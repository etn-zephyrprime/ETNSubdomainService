// Small localStorage-backed cache of "last known USD price" per token address — shared by
// CoreTierPortfolio.jsx and AddressLookup.jsx, both of which price each held token one at a time
// through the same shared, rate-limited GeckoTerminal proxy (tokenChartRouter.js's own
// MIN_GT_INTERVAL_MS ~1.5s-per-token trickle) and previously started from a blank slate on every
// mount — a reload or reconnect had to wait out the same trickle again even for prices fetched
// moments earlier. Reading this cache lets a component seed its price state immediately (instant
// numbers instead of a blank "still pricing..." state) while a fresh fetch still runs in the
// background and overwrites it — stale-while-revalidate, not a replacement for the real fetch.
//
// Deliberately global, not scoped to a wallet/account: a token's USD price doesn't depend on who
// holds it, so a price learned while viewing one wallet should already be available when viewing a
// different one (or the free-tier AddressLookup.jsx page) without re-fetching.
const STORAGE_KEY = "etnDashboard.tokenPriceCache.v1";
// Bounds worst-case localStorage growth for a browser that's looked up many distinct tokens over
// time — oldest-by-last-update entries evicted first once over the cap.
const MAX_ENTRIES = 500;

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // private browsing / storage disabled / corrupted JSON — this cache is a pure optimization, never a hard dependency
  }
}

function writeAll(map) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // storage full or disabled — silently skip, same "never a hard dependency" reasoning as readAll
  }
}

/** Every cached price as a plain `{ address (lowercased): price }` map — for seeding a component's
 * price state immediately on mount, before any fresh fetch has resolved. */
export function readCachedTokenPrices() {
  const all = readAll();
  const out = {};
  for (const [address, entry] of Object.entries(all)) {
    if (entry && typeof entry.price === "number" && Number.isFinite(entry.price)) out[address] = entry.price;
  }
  return out;
}

/** Records a freshly-fetched price so the next mount/reload can show it immediately instead of
 * waiting out the rate-limited queue again. No-ops on a non-finite price — never cache "nothing". */
export function cacheTokenPrice(address, price) {
  if (!address || typeof price !== "number" || !Number.isFinite(price)) return;

  const all = readAll();
  all[address.toLowerCase()] = { price, updatedAt: Date.now() };

  const entries = Object.entries(all);
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => (a[1]?.updatedAt || 0) - (b[1]?.updatedAt || 0));
    for (const [staleKey] of entries.slice(0, entries.length - MAX_ENTRIES)) delete all[staleKey];
  }

  writeAll(all);
}
