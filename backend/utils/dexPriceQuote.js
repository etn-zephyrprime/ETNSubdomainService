// backend/utils/dexPriceQuote.js
//
// Live spot price of any ERC-20 token in ETN — built for tokenPriceAlertScheduler.js, which needs
// to poll potentially many user-configured tokens on a short interval (also used by
// defiPositionValuation.js, premiumAlertsRouter.js's new-alert baseline, and anything else that
// needs a live per-token spot price). getTokenEtnPrice below tries ElectroSwap's own official API
// first (electroSwapApi.js — no RPC/GeckoTerminal involved at all when it has a price), falling
// back to the on-chain read this file originally was, read directly from the token's ElectroSwap
// pool's state, for anything ElectroSwap doesn't price or when ELECTROSWAP_API_KEY isn't set.
//
// ElectroSwap has (at least) two pool types live on this chain — confirmed live: a token's pools
// via GeckoTerminal can come back labeled "electroswap v3" (concentrated liquidity, Uniswap-V3-
// style — price read via slot0().sqrtPriceX96, not a simple reserve ratio) alongside plain V2-style
// pairs, and EITHER can be "the" real pool for a given token — confirmed live for a real token with
// $15k+ of reserves 100% in a V3 pool and no V2 pair at all. A token can also have BOTH: an early,
// now-thin legacy V2 pair alongside a newer, far more liquid V3 one. Picking "whichever pool type
// happens to be checked first" (this file's original design: try V2, only look at V3 if V2 is
// completely absent) gets that case backwards — it would confidently price off the stale, thin V2
// pool while ignoring the pool that's actually carrying the real liquidity.
//
// So pool identification is LIQUIDITY-RANKED, not type-prioritized: wetnPoolResolver.js's shared
// pool resolution (same one pnlPricing.js's historical lookups use) already reports every
// WETN-paired pool of every type with a real reserve_in_usd figure, so asking it directly and
// taking the highest-liquidity one naturally picks the actual main pool regardless of which type
// that turns out to be. Persisted to Supabase (see that file's own header comment) rather than
// looked up fresh every poll, so it doesn't compete with GeckoTerminal's own rate limits the way a
// live-price poll would. If GeckoTerminal has nothing at all for a token (a pool too new to be
// indexed yet), this falls back to checking ElectroSwap's V2 factory directly on-chain — better
// than nothing for that edge case, but never preferred over a GeckoTerminal-ranked result when one
// exists.
//
// Whichever pool is found (either path), it's PROBED on-chain (try getReserves(), then slot0()) to
// determine its actual interface rather than trusting a dex-id string — self-healing if
// ElectroSwap's naming or pool mix ever changes. This probe result (poolType, token ordering,
// decimals) stays in THIS file's own in-memory pairInfoCache below, not Supabase — it's one cheap
// on-chain call per token, not worth the persistence complexity the GeckoTerminal crawl warrants.
// Every poll after this one-time resolution reads the cached pool directly on-chain — zero
// GeckoTerminal involvement for the recurring/expensive part, which is the whole reason this file
// exists instead of just calling GeckoTerminal every tick the way pnlPricing.js's historical
// lookups do.
//
// V3 price math deliberately uses plain JS Number rather than exact BigInt fixed-point: converting
// sqrtPriceX96 to a Number retains ~15-16 significant digits of RELATIVE precision regardless of
// its absolute magnitude (that's just how IEEE-754 doubles work) — far more than a %-move alert
// needs, and much simpler than carrying BigInt precision through a square-plus-decimal-adjustment
// by hand. This is not wei-exact and isn't meant to be — nothing here settles a trade.
import { ethers } from "ethers";
import { resolveTokenPools } from "./wetnPoolResolver.js";
import { getCachedTokenPrice as getElectroSwapTokenPrice } from "./electroSwapPriceCache.js";

const ROUTER_ADDRESS =
  process.env.ELECTROSWAP_ROUTER_ADDRESS || "0x072D4706f9A383D5608BD14B09b41683cb95fFd7"; // same router burnSourceLabels.js already recognizes ("Token Swaps")
// Same wrapped-ETN address pnlPricing.js uses — ETN/WETN are 1:1 pegged; ElectroSwap's pools (like
// every pair GeckoTerminal indexes for this chain) trade the wrapped token, not native ETN.
const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";

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

/** Primary discovery path: the shared wetnPoolResolver.js (also used by pnlPricing.js) — asks
 * GeckoTerminal which pool(s) it knows about for this token and picks the highest-liquidity
 * WETN-paired one, regardless of pool type. See this file's own header comment for why
 * liquidity-ranking (not "try V2 first") is what correctly finds a token's actual main pool.
 * Persisted to Supabase now (see that file's own header comment) rather than an in-memory-only
 * cache — this call used to be a one-time, not-per-poll cost only within a single process's
 * lifetime; a redeploy used to make this and pnlPricing.js each re-pay it independently. */
async function findViaGeckoTerminal(tokenAddress) {
  const { wetnPool } = await resolveTokenPools(tokenAddress);
  return wetnPool?.poolAddress ?? null; // null covers both "no pools at all" and "has pools, just none paired directly against WETN"
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

  // GeckoTerminal first — it ranks every pool type by real liquidity, so it naturally finds the
  // actual main pool regardless of whether that's V2 or V3 (see this file's header comment for why
  // "prefer V2 because it's simpler to check" was the bug). The on-chain V2 factory is only a
  // fallback for a pool too new for GeckoTerminal to have indexed yet.
  let poolAddress = await findViaGeckoTerminal(tokenAddress);
  if (!poolAddress) poolAddress = await findViaV2Factory(provider, tokenAddress);
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
 *
 * Tries ElectroSwap's own official API first (electroSwapApi.js) — one HTTP call, no RPC/
 * GeckoTerminal pool-discovery involved at all, and it's ElectroSwap's own aggregation of whatever
 * pools THEY consider canonical rather than this file's own liquidity-ranked pick. Never throws on
 * its own (ELECTROSWAP_API_KEY unset, the token not priced there, or a request failure all just
 * return null) — falls straight through to the existing on-chain/GeckoTerminal path below
 * unchanged, so every caller keeps exactly its pre-existing coverage and throw/null semantics on
 * any deployment that hasn't set the key, or for any token ElectroSwap doesn't price.
 *
 * `skipElectroSwap` — for a caller that's already resolved this exact token through ElectroSwap's
 * BATCH endpoint (getBatchTokenPrices) and got nothing back for it: retrying the SINGLE endpoint
 * here would almost certainly fail again too (same underlying pricing data on ElectroSwap's side),
 * just at a real credit cost (50/call) for a near-guaranteed miss. Set true to skip straight to the
 * on-chain/GeckoTerminal path in that case — see portfolioValuation.js and
 * tokenPriceAlertScheduler.js, both of which batch first across every token they need in one tick/
 * request and only call this per-token for whatever the batch didn't cover.
 *
 * The ElectroSwap lookup itself goes through electroSwapPriceCache.js's short-TTL cache, not
 * electroSwapApi.js directly — a real credit cost only when this exact token hasn't been priced by
 * ANY consumer of that shared cache in the last ~90s, not on every single call here.
 */
export async function getTokenEtnPrice(provider, tokenAddress, { skipElectroSwap = false } = {}) {
  if (!skipElectroSwap) {
    const electroSwapPrice = await getElectroSwapTokenPrice(tokenAddress);
    if (electroSwapPrice?.etn != null) return electroSwapPrice.etn;
  }

  const info = await resolvePairInfo(provider, tokenAddress);
  if (!info) return null;

  return info.poolType === "v2" ? priceFromV2Reserves(provider, info) : priceFromV3Slot0(provider, info);
}
