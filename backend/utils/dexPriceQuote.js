// backend/utils/dexPriceQuote.js
//
// Live, on-chain spot price of any ERC-20 token in ETN, read directly from its ElectroSwap pool's
// reserves — built for tokenPriceAlertScheduler.js, which needs to poll potentially many
// user-configured tokens on a short interval. Deliberately does NOT go through GeckoTerminal (the
// way pnlPricing.js/tokenChartRouter.js do): that's a shared, tightly rate-limited queue already
// serving the free-tier token chart and every PnL statement's historical pricing (see
// tokenChartRouter.js's own MIN_GT_INTERVAL_MS/cooldown comments) — a per-alert-token polling loop
// hitting it too would compete with those for the same small budget. A raw reserve read is a plain
// RPC call against this app's own Ankr/fallback provider instead, with no shared external budget
// to exhaust.
//
// Deliberately reads reserves directly (getReserves()) rather than routing a quote through
// router.getAmountsOut() the way premiumSplitQuote.js correctly does for an actual swap: that
// function's job is "what would a specific trade size cost right now" (slippage against real
// depth is exactly the point there). This one's job is "what's the current market price" — a pure
// reserve ratio, no trade-size slippage folded in.
import { ethers } from "ethers";

const ROUTER_ADDRESS =
  process.env.ELECTROSWAP_ROUTER_ADDRESS || "0x072D4706f9A383D5608BD14B09b41683cb95fFd7"; // same router burnSourceLabels.js already recognizes ("Token Swaps")
// Same wrapped-ETN address pnlPricing.js uses — ETN/WETN are 1:1 pegged; ElectroSwap's pools (like
// every pair GeckoTerminal indexes for this chain) trade the wrapped token, not native ETN.
const WETN_ADDRESS = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";

const ROUTER_ABI = ["function factory() view returns (address)"];
const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) view returns (address pair)"];
const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];
const ERC20_ABI = ["function decimals() view returns (uint8)"];

// Pair address, token ordering, and a token's own decimals are all static for the life of the
// pool — resolved once per token, ever, then reused on every subsequent poll. Only the reserves
// themselves (read fresh in getTokenEtnPrice below) are live per call.
let cachedFactoryAddress = null;
const pairInfoCache = new Map(); // tokenAddress (lowercased) -> { pairAddress, tokenIsToken0, tokenDecimals } | null

async function getFactoryAddress(provider) {
  if (cachedFactoryAddress) return cachedFactoryAddress;
  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);
  cachedFactoryAddress = await router.factory();
  return cachedFactoryAddress;
}

async function resolvePairInfo(provider, tokenAddress) {
  const key = tokenAddress.toLowerCase();
  if (pairInfoCache.has(key)) return pairInfoCache.get(key);

  const factoryAddress = await getFactoryAddress(provider);
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
  const pairAddress = await factory.getPair(tokenAddress, WETN_ADDRESS);

  if (!pairAddress || pairAddress === ethers.ZeroAddress) {
    pairInfoCache.set(key, null); // no direct WETN pair on this DEX — cached so we don't re-check every poll
    return null;
  }

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [token0, tokenDecimals] = await Promise.all([pair.token0(), token.decimals()]);

  const info = { pairAddress, tokenIsToken0: token0.toLowerCase() === key, tokenDecimals: Number(tokenDecimals) };
  pairInfoCache.set(key, info);
  return info;
}

/**
 * Live spot price of `tokenAddress` in ETN, or null if it has no direct WETN pair on ElectroSwap
 * (nothing to derive a price from — same "omit rather than fake" convention as the rest of this
 * app's pricing code). Throws only on an actual RPC failure — callers (tokenPriceAlertScheduler.js)
 * treat that as "skip this poll for this token", not "no price exists".
 */
export async function getTokenEtnPrice(provider, tokenAddress) {
  const info = await resolvePairInfo(provider, tokenAddress);
  if (!info) return null;

  const pair = new ethers.Contract(info.pairAddress, PAIR_ABI, provider);
  const [reserve0, reserve1] = await pair.getReserves();
  const [tokenReserveRaw, wetnReserveRaw] = info.tokenIsToken0 ? [reserve0, reserve1] : [reserve1, reserve0];
  if (tokenReserveRaw === 0n) return null; // drained/uninitialized pool — no meaningful price

  const tokenReserve = Number(ethers.formatUnits(tokenReserveRaw, info.tokenDecimals));
  const wetnReserve = Number(ethers.formatUnits(wetnReserveRaw, 18));
  return wetnReserve / tokenReserve;
}
