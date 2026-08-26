import { getEtnPriceCache, setEtnPriceCache } from "../state/etnPriceState.js";

// Keeps a small public JSON cache of the live ETN/USD price in R2, so every price shown on the
// site (subname pricing, marketplace listings, registration fees, burn pool balance) can show a
// "≈ $X.XX" estimate without every visitor's browser hitting CoinGecko directly — same reasoning
// as every other R2 cache in this backend, just for a market price instead of on-chain data.
//
// Same CoinGecko endpoint/id ("electroneum") and fallback price coreClashSwapWatcher.js's
// fetchWetnUsd() already uses — ETN is the native coin CoreClashGame's WETN/USD estimate is
// itself derived from, so this is the same underlying price, just published for this app's own
// use instead of folded into a Telegram swap alert.
const COINGECKO_API = "https://api.coingecko.com/api/v3/simple/price?ids=electroneum&vs_currencies=usd";
const FALLBACK_USD_PRICE = 0.00103; // same fallback coreClashSwapWatcher.js uses
const CACHE_INTERVAL_MS = process.env.ETN_PRICE_CACHE_INTERVAL_MS
  ? parseInt(process.env.ETN_PRICE_CACHE_INTERVAL_MS, 10)
  : 300000;

async function fetchEtnUsd() {
  try {
    const res = await fetch(COINGECKO_API);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const price = data?.electroneum?.usd;
    if (price && Number.isFinite(price) && price > 0) return price;
  } catch (err) {
    console.warn("⚠️  ETN price cache: CoinGecko fetch failed, using fallback price:", err.message);
  }
  return FALLBACK_USD_PRICE;
}

let isRunning = false;

async function refreshAndPublish() {
  if (isRunning) return; // previous refresh still in flight — skip this tick
  isRunning = true;
  try {
    const usd = await fetchEtnUsd();
    await setEtnPriceCache(usd);
    console.log(`💵 ETN price cache updated — $${usd.toFixed(6)}`);
  } catch (err) {
    console.error("⚠️  ETN price cache refresh failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background cache refresher. No-op if R2 isn't configured, same as this repo's other
 * caches — there'd be nowhere public to publish to.
 */
export function startEtnPriceCache() {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — ETN price cache disabled");
    return;
  }

  console.log(`💵 ETN price cache started (refreshing every ${CACHE_INTERVAL_MS / 1000}s)`);
  refreshAndPublish();
  setInterval(refreshAndPublish, CACHE_INTERVAL_MS);
}
