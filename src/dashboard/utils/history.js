// Blockscout has no per-address "count over time" endpoint for transactions or token transfers
// (confirmed — only coin-balance-history-by-day exists for a wallet's own history). This derives
// a daily count from whichever items were actually fetched — a *sized-to-cover* number of pages
// (see AddressLookup.jsx's fetchUntilWindow, which fetches until the oldest item reaches back
// `windowDays`, not a fixed page count) rather than a true full history, which would mean
// unbounded fetching for a genuinely active address. `windowDays` is a parameter, not a constant,
// so it stays in sync with however far AddressLookup.jsx has actually fetched — a fixed window
// wider than what was fetched would zero-fill days that are simply *unfetched*, indistinguishable
// in the chart from real zero activity (confirmed live: a wallet doing 4,248 lifetime transactions
// still only reached ~20 days back under a naive fixed-page-count fetch, rendering as a flat,
// misleadingly "quiet" chart for the rest of a 60-day window it never actually covered).
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(isoString) {
  return isoString.slice(0, 10); // "2026-08-26T..." -> "2026-08-26"
}

/**
 * Buckets `items` (each with a `timestamp` field, ISO string) into daily counts covering the
 * last `windowDays` days, oldest first, zero-filled for days with no activity — the zero-fill
 * matters as much as the counts themselves, since SparklineChart's x-axis assumes equal time
 * steps between points; only plotting days that had activity would compress a genuinely sparse
 * history into a misleadingly busy-looking line. Returns `{ label, value }` pairs — `label` is
 * the bucket's day ("2026-08-26"), for SparklineChart's axis/tooltip date formatting.
 */
export function bucketDailyCounts(items, timestampField = "timestamp", windowDays = 30) {
  const counts = new Map();
  const now = Date.now();
  const cutoff = now - windowDays * ONE_DAY_MS;

  for (const item of items) {
    const ts = item[timestampField];
    if (!ts) continue;
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    const key = dayKey(ts);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const series = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const key = dayKey(new Date(now - i * ONE_DAY_MS).toISOString());
    series.push({ label: key, value: counts.get(key) || 0 });
  }
  return series;
}
