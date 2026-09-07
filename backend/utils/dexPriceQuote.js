// backend/utils/dexPriceQuote.js
//
// Live, on-chain spot price of any ERC-20 token in ETN, read directly from its ElectroSwap pool's
// state — built for tokenPriceAlertScheduler.js, which needs to poll potentially many
// user-configured tokens on a short interval.
//
// ElectroSwap has (at least) two pool types live on this chain — confirmed live: a token's pools
// via GeckoTerminal can come back labeled "electroswap v3" (concentrated liquidity, Uniswap-V3-
// style — price read via slot0().sqrtPriceX96, not a simple reserve ratio), and a token can have
// ONLY that kind with no plain V2 pair at all (confirmed live for a real token with $15k+ of
// reserves, 100% in a V3 pool — the original V2-only version of this file reported "no pool found"
// for it, which was simply wrong). Pool identification (which pool, which type) is resolved once
// per token and cached forever:
//   1. Try ElectroSwap's V2 factory directly (getPair(token, WETN)) — free, no external call.
//   2. If no V2 pair exists, fall back to a ONE-TIME GeckoTerminal lookup (same shared queue
//      pnlPricing.js/tokenChartRouter.js already use) for the token's best WETN-paired pool,
//      whatever type it turns out to be. This is a per-NEW-alert-token cost, not a per-poll one —
//      it doesn't compete with that queue's tight budget the way a live-price poll would.
//   3. Whichever pool is found, PROBE it (try getReserves(), then slot0()) to determine its actual
//      type rather than trusting a dex-id string — self-healing if ElectroSwap's naming or pool
//      mix ever changes, and works regardless of which discovery path found it.
// Every poll after that reads the cached pool directly on-chain — zero GeckoTerminal involvement
// for the recurring/expensive part, which is the whole reason this file exists instead of just
// calling GeckoTerminal every tick the way pnlPricing.js's historical lookups do.
//
// V3 price math deliberately uses plain JS Number rather than exact BigInt fixed-point: converting
// sqrtPriceX96 to a Number retains ~15-16 significant digits of RELATIVE precision regardless of
// its absolute magnitude (that's just how IEEE-754 doubles work) — far more than a %-move alert
// needs, and much simpler than carrying BigInt precision through a square-plus-decimal-adjustment
// by hand. This is not wei-exact and isn't meant to be — nothing here settles a trade.
import { ethers } from "ethers";
import { fetchGeckoTerminal } from "./tokenChartRouter.js";

const ROUTER_ADDRESS =
  process.env.ELECTROSWAP_ROUTER_ADDRESS || "0x072D4706f9A383D5608BD14B09b41683cb95fFd7"; // same router burnSourceLabels.js already recognizes ("Token Swaps")
// Same wrapped-ETN address pnlPricing.js uses — ETN/WETN are 1:1 pegged; ElectroSwap's pools (like
// every pair GeckoTerminal indexes for this chain) trade the wrapped token, not native ETN.
const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";
const NETWORK = "electroneum"; // same GeckoTerminal network slug pnlPricing.js uses

const ROUTER_ABI = ["function factory() view returns (address)"];
const FACTORY_V2_ABI = ["function getPair(address tokenA, address tokenB) view returns (address pair)"];
const PAIR_V2_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];
const POOL_V3_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
];
const ERC20_ABI = ["function decimals() view returns (uint8)"];

// Pool address, type, token ordering, and a token's own decimals are all static for the life of
// the pool — resolved once per token, ever, then reused on every subsequent poll. Only the live
// reserves/sqrtPrice themselves (read fresh in getTokenEtnPrice below) change per call.
let cachedFactoryAddress = null;
const pairInfoCache = new Map(); // tokenAddress (lowercased) -> { poolAddress, poolType: 'v2'|'v3', tokenIsToken0, tokenDecimals } | null

async function getFactoryAddress(provider) {
  if (cachedFactoryAddress) return cachedFactoryAddress;
  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);
  cachedFactoryAddress = await router.factory();
  return cachedFactoryAddress;
}

async function findViaV2Factory(provider, tokenAddress) {
  const factoryAddress = await getFactoryAddress(provider);
  const factory = new ethers.Contract(factoryAddress, FACTORY_V2_ABI, provider);
  const pairAddress = await factory.getPair(tokenAddress, WETN_ADDRESS);
  return pairAddress && pairAddress !== ethers.ZeroAddress ? pairAddress : null;
}

/** One-time-per-token fallback for when ElectroSwap's V2 factory has no direct pair — asks
 * GeckoTerminal which pool(s) it knows about for this token and picks the best WETN-paired one,
 * same selection logic pnlPricing.js's resolvePoolAddress already uses (prefer WETN pairs, highest
 * reserve_in_usd). See this file's own header comment for why this is a one-time, not per-poll,
 * cost. */
async function findViaGeckoTerminal(tokenAddress) {
  let pools = [];
  try {
    const res = await fetchGeckoTerminal(`/networks/${NETWORK}/tokens/${tokenAddress.toLowerCase()}/pools`);
    pools = res.data || [];
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (pools.length === 0) return null;

  const tokenId = `${NETWORK}_${tokenAddress.toLowerCase()}`;
  const wetnId = `${NETWORK}_${WETN_ADDRESS}`;
  const wetnPools = pools.filter((p) => {
    const baseId = p.relationships?.base_token?.data?.id;
    const quoteId = p.relationships?.quote_token?.data?.id;
    const otherId = baseId === tokenId ? quoteId : baseId;
    return otherId === wetnId;
  });
  if (wetnPools.length === 0) return null; // has pools, just none paired directly against WETN

  const best = wetnPools.reduce((a, b) => (Number(b.attributes.reserve_in_usd || 0) > Number(a.attributes.reserve_in_usd || 0) ? b : a));
  return best.attributes.address;
}

/** Determines a pool's actual interface by probing it, rather than trusting any dex-id string —
 * an unrecognized-selector call reverts cleanly on both known pool implementations, so this is
 * safe even for a pool type neither branch below matches (returns null). */
async function probePoolType(provider, poolAddress) {
  try {
    await new ethers.Contract(poolAddress, PAIR_V2_ABI, provider).getReserves();
    return "v2";
  } catch {
    // not V2-shaped — try V3 below
  }
  try {
    await new ethers.Contract(poolAddress, POOL_V3_ABI, provider).slot0();
    return "v3";
  } catch {
    return null;
  }
}

async function resolvePairInfo(provider, tokenAddress) {
  const key = tokenAddress.toLowerCase();
  if (pairInfoCache.has(key)) return pairInfoCache.get(key);

  let poolAddress = await findViaV2Factory(provider, tokenAddress);
  if (!poolAddress) poolAddress = await findViaGeckoTerminal(tokenAddress);
  if (!poolAddress) {
    pairInfoCache.set(key, null); // genuinely no WETN-paired pool anywhere — nothing to derive a price from
    return null;
  }

  const poolType = await probePoolType(provider, poolAddress);
  if (!poolType) {
    pairInfoCache.set(key, null); // found a pool address but it matches neither known ABI
    return null;
  }

  const abi = poolType === "v2" ? PAIR_V2_ABI : POOL_V3_ABI;
  const pool = new ethers.Contract(poolAddress, abi, provider);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [token0, tokenDecimals] = await Promise.all([pool.token0(), token.decimals()]);

  const info = { poolAddress, poolType, tokenIsToken0: token0.toLowerCase() === key, tokenDecimals: Number(tokenDecimals) };
  pairInfoCache.set(key, info);
  return info;
}

async function priceFromV2Reserves(provider, info) {
  const pair = new ethers.Contract(info.poolAddress, PAIR_V2_ABI, provider);
  const [reserve0, reserve1] = await pair.getReserves();
  const [tokenReserveRaw, wetnReserveRaw] = info.tokenIsToken0 ? [reserve0, reserve1] : [reserve1, reserve0];
  if (tokenReserveRaw === 0n) return null; // drained/uninitialized pool — no meaningful price

  const tokenReserve = Number(ethers.formatUnits(tokenReserveRaw, info.tokenDecimals));
  const wetnReserve = Number(ethers.formatUnits(wetnReserveRaw, 18));
  return wetnReserve / tokenReserve;
}

async function priceFromV3Slot0(provider, info) {
  const pool = new ethers.Contract(info.poolAddress, POOL_V3_ABI, provider);
  const { sqrtPriceX96 } = await pool.slot0();
  if (sqrtPriceX96 === 0n) return null;

  const otherDecimals = 18; // WETN
  const decimals0 = info.tokenIsToken0 ? info.tokenDecimals : otherDecimals;
  const decimals1 = info.tokenIsToken0 ? otherDecimals : info.tokenDecimals;
  // token1-per-token0, human-readable (see this file's header comment on the Number precision
  // this relies on).
  const token1PerToken0 = (Number(sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (decimals0 - decimals1);
  // We want WETN-per-token regardless of which side of the pool the token sits on.
  return info.tokenIsToken0 ? token1PerToken0 : 1 / token1PerToken0;
}

/**
 * Live spot price of `tokenAddress` in ETN, or null if it has no derivable ElectroSwap pool at all
 * (nothing to price against — same "omit rather than fake" convention as the rest of this app's
 * pricing code). Throws only on an actual RPC/GeckoTerminal failure — callers
 * (tokenPriceAlertScheduler.js) treat that as "skip this poll for this token", not "no price
 * exists".
 */
export async function getTokenEtnPrice(provider, tokenAddress) {
  const info = await resolvePairInfo(provider, tokenAddress);
  if (!info) return null;

  return info.poolType === "v2" ? priceFromV2Reserves(provider, info) : priceFromV3Slot0(provider, info);
}
