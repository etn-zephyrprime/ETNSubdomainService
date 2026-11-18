import { isElectroSwapConfigured } from "./electroSwapApi.js";
import { getCachedBatchTokenPrices, registerPricePiggyback } from "./electroSwapPriceCache.js";
import { getTokenPriceCache, setTokenPriceCache } from "../state/tokenPriceState.js";
import { ELECTROSWAP_LISTED_TOKENS } from "./electroSwapTokens.js";

// Keeps a small public JSON cache of the whitelisted ERC20 payment tokens' live USD prices in R2
// — same reasoning/shape as etnPriceCache.js, just for BOLT/USDC/USDT/CLUB/CORE/DYNO/DCNT/PDY/
// FUGAZI instead of ETN itself, so a subname quote paid in any of them can show a "≈ $X.XX"
// estimate the same way an ETN quote already does (see src/hooks/useTokenPrices.js/
// UsdEstimate.jsx). These addresses are the shared candidate set; Bubblemaps further filters for
// active locks. The marketplace watcher and advert scheduler maintain their own
// TOKEN_DECIMALS_BY_ADDRESS maps.
const WHITELISTED_TOKEN_ADDRESSES = ELECTROSWAP_LISTED_TOKENS.map(({ address }) => address);

// ElectroSwap is metered (a batch call is 100 credits + 10 per token), and this file used to spend ~55K
// credits/day refreshing every 5 minutes around the clock. Three things now keep that down without slowing
// anything a visitor sees:
//
//  1. 10-minute cadence (was 5) — these prices only feed the "≈ $X.XX" estimates next to a subname quote.
//  2. DEMAND-DRIVEN: it only refreshes while somebody is actually fetching token-prices.json (the R2 proxy
//     calls noteTokenPricesRequested on every request; "recent" = DEMAND_WINDOW_MS). Nobody looking, nothing
//     spent. The FIRST request after an idle spell kicks an immediate refresh, so it's fresh for whoever
//     asks next (that one visitor may see the last-published prices).
//  3. PIGGYBACKING: tokenPriceAlertScheduler already makes a batch call every 5 minutes. When this cache is
//     due, its 9 tokens are added to that call (paying only the 10/token part) instead of a call of its
//     own. Only if no other caller makes a call within PIGGYBACK_GRACE_MS does it fetch by itself.
const CACHE_INTERVAL_MS = process.env.TOKEN_PRICE_CACHE_INTERVAL_MS
  ? parseInt(process.env.TOKEN_PRICE_CACHE_INTERVAL_MS, 10)
  : 10 * 60 * 1000;
const DEMAND_WINDOW_MS = process.env.TOKEN_PRICE_DEMAND_WINDOW_MS
  ? parseInt(process.env.TOKEN_PRICE_DEMAND_WINDOW_MS, 10)
  : 30 * 60 * 1000;
const PIGGYBACK_GRACE_MS = process.env.TOKEN_PRICE_PIGGYBACK_GRACE_MS ? parseInt(process.env.TOKEN_PRICE_PIGGYBACK_GRACE_MS, 10) : 6 * 60 * 1000; // > the alert scheduler's 5-minute cycle, so it gets a chance to carry us
const CHECK_TICK_MS = process.env.TOKEN_PRICE_CHECK_TICK_MS ? parseInt(process.env.TOKEN_PRICE_CHECK_TICK_MS, 10) : 60 * 1000;

let isRunning = false;
let lastPublishedAt = 0; // ms
let lastDemandAt = 0; // ms — last time token-prices.json was requested
let dueSince = null; // ms — when this cache first noticed it was due (for the piggyback grace period)
let lastKickAt = 0;

const demandActive = () => Date.now() - lastDemandAt < DEMAND_WINDOW_MS;
const isDue = () => !isRunning && demandActive() && Date.now() - lastPublishedAt >= CACHE_INTERVAL_MS;

/** Keeps only positive finite USD prices — the `usd` field of each entry (`etn` isn't needed here, and an
 * entry can in principle carry one without the other, which shouldn't count as "priced"). */
function usdPricesFrom(priceMap) {
  const prices = {};
  for (const address of WHITELISTED_TOKEN_ADDRESSES) {
    const entry = priceMap.get(address.toLowerCase());
    if (entry && typeof entry.usd === "number" && Number.isFinite(entry.usd) && entry.usd > 0) prices[address.toLowerCase()] = entry.usd;
  }
  return prices;
}

async function publish(priceMap) {
  const prices = usdPricesFrom(priceMap);

  if (Object.keys(prices).length === 0) {
    // ElectroSwap simply doesn't have a USD price for any of these right now (or the call itself failed —
    // the batch call swallows that and returns an empty Map either way). Keep whatever was last published
    // rather than overwriting a good cache with an empty one — same "don't misrepresent a stale-but-real
    // value as freshly-confirmed-empty" reasoning etnPriceCache.js's own refreshAndPublish uses.
    const previous = await getTokenPriceCache();
    if (previous?.prices && Object.keys(previous.prices).length > 0) {
      console.warn(`⚠️  Token price cache: no prices returned this cycle — keeping previous prices from ${previous.updatedAt}`);
    } else {
      console.warn("⚠️  Token price cache: no prices available yet (nothing to publish)");
    }
    return;
  }

  await setTokenPriceCache(prices);
  lastPublishedAt = Date.now();
  dueSince = null;
  console.log(`💵 Token price cache updated — ${Object.keys(prices).length}/${WHITELISTED_TOKEN_ADDRESSES.length} token(s) priced`);
}

async function refreshAndPublish() {
  if (isRunning) return; // previous refresh still in flight — skip this tick
  isRunning = true;
  try {
    await publish(await getCachedBatchTokenPrices(WHITELISTED_TOKEN_ADDRESSES));
  } catch (err) {
    console.error("⚠️  Token price cache refresh failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/** Called by the R2 proxy every time token-prices.json is requested (see r2CacheProxyRouter.js). Marks
 * demand, and if this is the first request after an idle spell with stale data, refreshes right away. */
export function noteTokenPricesRequested() {
  const wasIdle = !demandActive();
  lastDemandAt = Date.now();
  if (wasIdle && Date.now() - lastPublishedAt >= CACHE_INTERVAL_MS && Date.now() - lastKickAt > 60 * 1000) {
    lastKickAt = Date.now();
    refreshAndPublish();
  }
}

function tick() {
  if (!isDue()) {
    dueSince = null;
    return;
  }
  dueSince ??= Date.now();
  if (Date.now() - dueSince >= PIGGYBACK_GRACE_MS) refreshAndPublish(); // nobody carried us — pay for our own call
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

  console.log(`💵 Token price cache started (refreshing at most every ${CACHE_INTERVAL_MS / 1000}s, only while requested; ${WHITELISTED_TOKEN_ADDRESSES.length} token(s))`);

  registerPricePiggyback({
    isDue,
    addresses: WHITELISTED_TOKEN_ADDRESSES,
    onPrices: (priceMap) => { publish(priceMap).catch((err) => console.error("⚠️  Token price cache publish failed:", err.message)); },
  });

  // Resume from what's already published, so a restart/deploy doesn't buy a refresh it doesn't need.
  getTokenPriceCache()
    .then((previous) => {
      const at = previous?.updatedAt ? Date.parse(previous.updatedAt) : NaN;
      if (Number.isFinite(at)) lastPublishedAt = at;
      else refreshAndPublish(); // never published — seed it once
    })
    .catch(() => {});
  setInterval(tick, CHECK_TICK_MS);
}
