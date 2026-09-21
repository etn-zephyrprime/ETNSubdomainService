// backend/utils/lastKnownPrices.js
//
// The last USD price each token was successfully priced at, remembered across restarts (persisted to R2).
//
// WHY. Portfolio valuations (the Telegram daily summary, portfolio alerts) price every holding live. When a
// price lookup fails — ElectroSwap's key rate-limited/suspended and its breaker open, GeckoTerminal
// rate-limited — the holding used to count as $0 and the total swung by thousands for no real reason. A
// holding that can't be priced right now is instead valued at its last known price: a slightly stale figure
// beats a zero, and it's replaced by the live price the moment lookups work again.
//
// Recording happens wherever a live price is successfully obtained (portfolioValuation.js and
// defiPositionValuation.js); reading happens where a live lookup failed. In-memory map + debounced R2 flush
// (at most one write per FLUSH_INTERVAL_MS, and only when something changed), loaded lazily on first read so a
// restart doesn't lose what was known.
import { getLastKnownPricesData, setLastKnownPricesData } from "../state/lastKnownPricesState.js";

// A price this old is more misleading than helpful (a token that hasn't priced in a month is probably dead).
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = process.env.LAST_KNOWN_PRICES_FLUSH_MS ? parseInt(process.env.LAST_KNOWN_PRICES_FLUSH_MS, 10) : 2 * 60 * 1000;

const known = new Map(); // lowercased address -> { usd, at }
let loading = null;
let dirty = false;
let flushTimer = null;

function ensureLoaded() {
  if (!loading) {
    loading = getLastKnownPricesData()
      .then((stored) => {
        for (const [address, entry] of Object.entries(stored)) {
          const mine = known.get(address);
          if (Number.isFinite(entry?.usd) && Number.isFinite(entry?.at) && (!mine || mine.at < entry.at)) known.set(address, entry);
        }
      })
      .catch(() => {}); // unreadable store: carry on with whatever is in memory
  }
  return loading;
}

async function flush() {
  flushTimer = null;
  if (!dirty) return;
  dirty = false;
  try {
    await ensureLoaded();
    const cutoff = Date.now() - MAX_AGE_MS;
    const out = {};
    for (const [address, entry] of known) if (entry.at >= cutoff) out[address] = entry;
    await setLastKnownPricesData(out);
  } catch (err) {
    dirty = true; // try again next time
    console.warn("⚠️  Couldn't persist last-known prices:", err.message);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

/** Remember a successfully obtained USD price. Ignores anything that isn't a positive finite number. */
export function recordLastKnownPrice(tokenAddress, usd) {
  if (!tokenAddress || !Number.isFinite(usd) || usd <= 0) return;
  known.set(tokenAddress.toLowerCase(), { usd, at: Date.now() });
  dirty = true;
  scheduleFlush();
}

/** The last USD price this token was successfully priced at (up to MAX_AGE_MS ago), or null if never/too old. */
export async function getLastKnownPrice(tokenAddress) {
  if (!tokenAddress) return null;
  await ensureLoaded();
  const entry = known.get(tokenAddress.toLowerCase());
  return entry && Date.now() - entry.at <= MAX_AGE_MS ? entry.usd : null;
}
