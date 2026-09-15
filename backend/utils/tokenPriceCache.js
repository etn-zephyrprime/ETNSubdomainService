import { getBatchTokenPrices, isElectroSwapConfigured } from "./electroSwapApi.js";
import { getTokenPriceCache, setTokenPriceCache } from "../state/tokenPriceState.js";

// Keeps a small public JSON cache of the whitelisted ERC20 payment tokens' live USD prices in R2
// — same reasoning/shape as etnPriceCache.js, just for BOLT/USDC/USDT/CLUB/CORE/DYNO/DCNT/PDY/
// FUGAZI instead of ETN itself, so a subname quote paid in any of them can show a "≈ $X.XX"
// estimate the same way an ETN quote already does (see src/hooks/useTokenPrices.js/
// UsdEstimate.jsx). Same 9-token list marketplaceWatcher.js's/subdomainAdvertScheduler.js's own
// TOKEN_DECIMALS_BY_ADDRESS track (symbol/decimals there; only addresses needed here) —
// duplicated per this codebase's established "small per-file lists are fine to drift
// independently" convention.
const WHITELISTED_TOKEN_ADDRESSES = [
  "0x043fAa1b5C5FC9a7dc35171f290c29ECDE0cCff1", // BOLT
  "0x309B916b3A90cb3E071697Ea9680e9217A30066f", // CORE
  "0xEe432C220273e4F949007B4c1946562826Efa055", // DYNO
  "0xc20d02538368D8F7deBeAeB99D9a8b4d4D1DDC1C", // PDY
  "0x075533AB8EeC6A6999F07C8bc2f1900eB8312e25", // FUGAZI
  "0x3187deAd7A2Bd6770F5Fe81495D1B715926AAe6e", // USDC
  "0x48E722f1458b253c2FB0E573F939318D7Dbd54e7", // USDT
  "0xC9FC4AB00911793D99b5c7Bd01f01203C21D4131", // CLUB
  "0xE74e4E7A064310466f3bdBd3F3Ce4e8c8F7CF1d5", // DCNT
];

const CACHE_INTERVAL_MS = process.env.TOKEN_PRICE_CACHE_INTERVAL_MS
  ? parseInt(process.env.TOKEN_PRICE_CACHE_INTERVAL_MS, 10)
  : 300000;

let isRunning = false;

async function refreshAndPublish() {
  if (isRunning) return; // previous refresh still in flight — skip this tick
  isRunning = true;
  try {
    const priceMap = await getBatchTokenPrices(WHITELISTED_TOKEN_ADDRESSES); // Map<lowercased address, {usd, etn}>

    // Only the `usd` field of each entry — `etn` (also returned) isn't needed here, and an entry
    // can in principle carry one without the other (see electroSwapApi.js's own parsePriceEntry
    // comment), which shouldn't count as "this token is priced" for this cache's purpose.
    const prices = {};
    for (const [address, entry] of priceMap.entries()) {
      if (typeof entry.usd === "number" && Number.isFinite(entry.usd) && entry.usd > 0) {
        prices[address] = entry.usd;
      }
    }

    if (Object.keys(prices).length === 0) {
      // ElectroSwap simply doesn't have a USD price for any of these right now (or the call
      // itself failed — getBatchTokenPrices already swallows that and returns an empty Map either
      // way). Keep whatever was last published rather than overwriting a good cache with an empty
      // one — same "don't misrepresent a stale-but-real value as freshly-confirmed-empty"
      // reasoning etnPriceCache.js's own refreshAndPublish uses.
      const previous = await getTokenPriceCache();
      if (previous?.prices && Object.keys(previous.prices).length > 0) {
        console.warn(`⚠️  Token price cache: no prices returned this cycle — keeping previous prices from ${previous.updatedAt}`);
      } else {
        console.warn("⚠️  Token price cache: no prices available yet (nothing to publish)");
      }
      return;
    }

    await setTokenPriceCache(prices);
    console.log(`💵 Token price cache updated — ${Object.keys(prices).length}/${WHITELISTED_TOKEN_ADDRESSES.length} token(s) priced`);
  } catch (err) {
    console.error("⚠️  Token price cache refresh failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured (nowhere public to publish
 * to, same as etnPriceCache.js) or ElectroSwap isn't configured (no price source at all —
 * unlike ETN, these tokens aren't on CoinGecko, so there's no fallback provider to fall back to).
 */
export function startTokenPriceCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — token price cache disabled");
    return;
  }
  if (!isElectroSwapConfigured()) {
    console.log("ℹ️  ELECTROSWAP_API_KEY not set — token price cache disabled");
    return;
  }

  console.log(`💵 Token price cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s, ${WHITELISTED_TOKEN_ADDRESSES.length} token(s))`);
  refreshAndPublish();
  setInterval(refreshAndPublish, CACHE_INTERVAL_MS);
}
