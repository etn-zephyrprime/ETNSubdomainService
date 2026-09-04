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
// Last-resort only, when CoinGecko fails AND nothing has ever been cached yet (e.g. the very
// first boot). Same fallback coreClashSwapWatcher.js uses. Everyday CoinGecko failures no longer
// touch this at all -- they keep whatever price was last successfully fetched instead (see
// refreshAndPublish below); this stale hardcoded number was previously overwriting a perfectly
// good recent price on every transient failure.
const FALLBACK_USD_PRICE = 0.00103;
const CACHE_INTERVAL_MS = process.env.ETN_PRICE_CACHE_INTERVAL_MS
  ? parseInt(process.env.ETN_PRICE_CACHE_INTERVAL_MS, 10)
  : 300000;
const FETCH_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 2000;

// Throws (doesn't fall back to anything itself) after exhausting retries -- a single transient
// blip or rate-limit response shouldn't immediately count as "CoinGecko is down"; the caller
// decides what to do once retries are genuinely exhausted.
async function fetchEtnUsd() {
  let lastErr;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(COINGECKO_API);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
      }
      const data = await res.json();
      const price = data?.electroneum?.usd;
      if (price && Number.isFinite(price) && price > 0) return price;
      throw new Error(`Unexpected response shape: ${JSON.stringify(data).slice(0, 200)}`);
    } catch (err) {
      lastErr = err;
      if (attempt < FETCH_ATTEMPTS) {
        console.warn(`⚠️  ETN price cache: CoinGecko attempt ${attempt}/${FETCH_ATTEMPTS} failed (${err.message}), retrying in ${FETCH_RETRY_DELAY_MS}ms`);
        await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
      }
    }
  }

  throw lastErr;
}

let isRunning = false;

async function refreshAndPublish() {
  if (isRunning) return; // previous refresh still in flight — skip this tick
  isRunning = true;
  try {
    let usd;

    try {
      usd = await fetchEtnUsd();
    } catch (err) {
      const previous = await getEtnPriceCache();

      if (previous?.usd) {
        // Cache already holds the right value -- nothing to publish. Explicitly not calling
        // setEtnPriceCache() here: doing so would just bump `updatedAt` to now against an
        // unchanged price, misrepresenting a stale value as freshly confirmed.
        console.warn(
          `⚠️  ETN price cache: CoinGecko fetch failed after ${FETCH_ATTEMPTS} attempts (${err.message}) — keeping previous price $${previous.usd.toFixed(6)} from ${previous.updatedAt}`
        );
        return;
      }

      console.warn(
        `⚠️  ETN price cache: CoinGecko fetch failed after ${FETCH_ATTEMPTS} attempts (${err.message}) and nothing cached yet — publishing hardcoded fallback $${FALLBACK_USD_PRICE}`
      );
      usd = FALLBACK_USD_PRICE;
    }

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
