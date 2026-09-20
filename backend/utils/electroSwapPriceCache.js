// backend/utils/electroSwapPriceCache.js
//
// Shared, short-TTL cache in front of electroSwapApi.js's price endpoints. electroSwapApi.js
// itself has NO caching at all (see its own header comment) — every call there is billed fresh,
// every time. Every consumer that wants a token's live ElectroSwap price should go through here
// instead of calling electroSwapApi.js directly, so two consumers wanting the same token within
// the cache window share ONE real (credit-costing) call instead of each paying for their own.
//
// Currently read by: dexPriceQuote.js's getTokenEtnPrice (used by tokenPriceAlertScheduler.js,
// defiPositionValuation.js, premiumAlertsRouter.js's new-alert baseline). (coreClashSwapWatcher.js no longer
// calls ElectroSwap — it prices CORE from its own pool's reserves.)
//
// CACHE_TTL_MS is intentionally shorter than every current consumer's own poll/refresh interval
// (tokenPriceAlertScheduler.js: 5 min) — this never serves a
// consumer a price staler than what ITS OWN interval would have gotten by calling
// electroSwapApi.js directly. It only ever saves a call when two lookups for the SAME token land
// within the same short window — which happens whenever two consumers' schedules happen to
// overlap for a token both care about. Worth being honest about the shape of that saving: it's
// real but OPPORTUNISTIC, not a way to make a consumer's own recurring calls free. A token nothing
// else is pricing on a similar cadence (e.g. CORE, unless it also happens to have an active
// member-configured price alert) still pays for its own call most of the time — this cache
// protects against literal duplicate cost, it doesn't invent a free price feed.
import { getTokenPrice, getBatchTokenPrices } from "./electroSwapApi.js";

const CACHE_TTL_MS = 90 * 1000;
const cache = new Map(); // tokenAddress (lowercased) -> { price: {usd,etn}|null, expiresAt }
// Same in-flight-dedup pattern as pnlIngestion.js's inFlightIngestions — concurrent callers asking
// for the SAME token during a cache miss share ONE real call rather than each starting their own.
const inFlight = new Map(); // tokenAddress (lowercased) -> Promise<{usd,etn}|null>

function freshEntry(address) {
  const entry = cache.get(address);
  return entry && entry.expiresAt > Date.now() ? entry : null;
}

/** Cached `{ usd, etn } | null` for ONE token. Prefer getCachedBatchTokenPrices for more than a
 * couple of tokens at once — same reasoning electroSwapApi.js's own getTokenPrice/
 * getBatchTokenPrices docs give; this wrapper doesn't change that trade-off, only adds caching on
 * top of whichever one a caller picks. */
export async function getCachedTokenPrice(tokenAddress) {
  const address = tokenAddress.toLowerCase();
  const fresh = freshEntry(address);
  if (fresh) return fresh.price;

  const existing = inFlight.get(address);
  if (existing) return existing;

  const promise = getTokenPrice(address)
    .then((price) => {
      cache.set(address, { price, expiresAt: Date.now() + CACHE_TTL_MS });
      return price;
    })
    .finally(() => {
      if (inFlight.get(address) === promise) inFlight.delete(address);
    });
  inFlight.set(address, promise);
  return promise;
}

/** Cached batch lookup — only the addresses NOT already fresh in cache are actually sent to
 * electroSwapApi.js's getBatchTokenPrices; whatever's already cached is returned immediately with
 * no call at all. Returns a Map keyed by lowercased address -> {usd,etn}, same shape as the
 * underlying batch call — an address ElectroSwap has no price for is simply absent, never a
 * fabricated entry (same "omit rather than fake" convention electroSwapApi.js itself documents).
 *
 * Known gap, deliberately not solved here: this doesn't consult getCachedTokenPrice's own
 * inFlight map, so a single-token lookup and a batch call landing on the exact same token at the
 * exact same moment could each trigger their own real call instead of sharing one. Not worth the
 * added complexity for how rarely that literal collision happens given this app's actual call
 * patterns (a handful of poll/refresh loops on staggered multi-minute intervals) — this still
 * removes the common, repeated duplication (the actual problem), just not every conceivable one. */
export async function getCachedBatchTokenPrices(tokenAddresses) {
  const result = new Map();
  const toFetch = [];

  for (const raw of tokenAddresses) {
    const address = raw.toLowerCase();
    const fresh = freshEntry(address);
    if (fresh) {
      if (fresh.price) result.set(address, fresh.price);
      continue;
    }
    toFetch.push(address);
  }
  if (toFetch.length === 0) return result;

  // A batch call costs 100 credits BASE plus 10 per token, so the base is what a second, separate call
  // wastes. Any registered piggyback that is due right now adds its own addresses to THIS call (paying only
  // the 10/token part) instead of making a call of its own — see registerPricePiggyback.
  const due = piggybacks.filter((p) => p.isDue());
  const requested = new Set(toFetch);
  const riders = new Set();
  for (const p of due) {
    for (const raw of p.addresses) {
      const address = raw.toLowerCase();
      if (!requested.has(address)) riders.add(address);
    }
  }
  const allAddresses = [...requested, ...riders];

  const fetched = await getBatchTokenPrices(allAddresses);
  const expiresAt = Date.now() + CACHE_TTL_MS;
  for (const address of allAddresses) {
    const price = fetched.get(address) ?? null;
    cache.set(address, { price, expiresAt });
    if (price && requested.has(address)) result.set(address, price);
  }
  for (const p of due) {
    try {
      p.onPrices(fetched);
    } catch (err) {
      console.warn("⚠️  ElectroSwap price piggyback handler failed:", err.message);
    }
  }
  return result;
}

const piggybacks = [];

/** Lets a slower, lower-priority price refresh ride along on another caller's batch call instead of paying
 * the 100-credit base for a call of its own. `isDue()` says whether it wants prices right now;
 * `addresses` are the tokens it wants; `onPrices(map)` receives the whole Map<lowercased address,
 * {usd, etn}> that call returned (only invoked when a real call was made — the registrant still needs its
 * own fallback for when nothing else happens to be calling). */
export function registerPricePiggyback({ isDue, addresses, onPrices }) {
  piggybacks.push({ isDue, addresses, onPrices });
}
