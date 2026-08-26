// Blockscout has no per-address "count over time" endpoint for transactions or token transfers
// (confirmed — only coin-balance-history-by-day exists for a wallet's own history). This derives
// a daily count from whichever items were actually fetched (a bounded number of most-recent
// pages — see AddressLookup.jsx) rather than a true full history, which would mean unbounded
// fetching for a genuinely active address. Bounded to the last WINDOW_DAYS regardless of how far
// back the fetched items reach, so a sparse address's data doesn't stretch the chart across a
// mostly-empty year.
const WINDOW_DAYS = 60;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(isoString) {
  return isoString.slice(0, 10); // "2026-08-26T..." -> "2026-08-26"
}

/**
 * Buckets `items` (each with a `timestamp` field, ISO string) into daily counts covering the
 * last WINDOW_DAYS days, oldest first, zero-filled for days with no activity — the zero-fill
 * matters as much as the counts themselves, since SparklineChart's x-axis assumes equal time
 * steps between points; only plotting days that had activity would compress a genuinely sparse
 * history into a misleadingly busy-looking line. Returns `{ label, value }` pairs — `label` is
 * the bucket's day ("2026-08-26"), for SparklineChart's axis/tooltip date formatting.
 */
export function bucketDailyCounts(items, timestampField = "timestamp") {
  const counts = new Map();
  const now = Date.now();
  const cutoff = now - WINDOW_DAYS * ONE_DAY_MS;

  for (const item of items) {
    const ts = item[timestampField];
    if (!ts) continue;
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    const key = dayKey(ts);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const series = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const key = dayKey(new Date(now - i * ONE_DAY_MS).toISOString());
    series.push({ label: key, value: counts.get(key) || 0 });
  }
  return series;
}
