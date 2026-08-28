import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/dashboardStatsCache.js publishes hourly network-stat snapshots to R2 — see its
// header comment for why this exists (Blockscout has no historical endpoint for these fields at
// all). Same no-fallback-on-failure pattern as this app's other R2-backed hooks: a fetch failure
// just means these particular charts show no data, nothing else breaks. Fetched via this
// backend's own proxy, not R2 directly — see config.js's r2ProxyUrl for why.
export function useDashboardStats() {
  const getSnapshots = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("dashboard-stats-history.json"));
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data?.snapshots) ? data.snapshots : [];
    } catch (err) {
      console.warn("Dashboard stats history fetch failed:", err.message);
      return [];
    }
  }, []);

  return { getSnapshots };
}

/**
 * Reconstructs an approximate cumulative "total transactions" series from
 * /stats/charts/transactions' daily *new*-transaction counts (a flow metric) plus the current
 * all-time total (a stock metric) — Blockscout has no direct history for the stock metric
 * itself, but this derives one that's accurate as of each day's close: cumulative[day] =
 * currentTotal - (sum of every later day's new-transaction count). Real data, not a guess — just
 * arithmetic on two real numbers this app already fetches. Returns `{ label, value }` pairs,
 * `label` being that day's real date from Blockscout's own chart_data.
 */
/**
 * Merges Blockscout's own daily tx-count chart (real, but capped at 31 days — confirmed live)
 * with dailyBlockStatsCache.js's own real, independently-scanned daily counts (which cover up to
 * 90 days, but backfill gradually in the background — see that cache's header comment) into one
 * `[{date, transaction_count}]` series, newest-first, same shape reconstructCumulativeTransactions
 * already expects. Blockscout is preferred wherever both have a date (it's always live/current;
 * our own cache's tip only catches up once per its own ~5-minute cycle) — our cache's job is
 * purely to extend the series *further back* than Blockscout goes, not to replace it.
 *
 * Walks backward from today one day at a time and stops at the first *interior* gap neither
 * source has, so the result is always a contiguous run (no gap a running cumulative subtraction
 * could silently get wrong) — during dailyBlockStatsCache.js's initial backfill this naturally
 * means the series is only as long as Blockscout's own 31 days for the first few hours, then
 * grows past 31 as that cache's backfill reaches further back. Same "starts thin, grows richer"
 * shape as this app's other caches.
 *
 * Leading gaps are skipped rather than treated as a stop condition — confirmed live that
 * Blockscout's own chart doesn't include *today* at all (its newest entry is yesterday, presumably
 * because today's day-bucket hasn't closed yet), and our own cache's tip can likewise be a few
 * minutes behind "now". Breaking on that would collapse the whole series to zero days over a gap
 * that's really just "the most recent day isn't finalized yet", not missing history.
 */
export function mergeDailyTransactionCounts(blockscoutChartData, ourDays, daysBack = 90) {
  const bsMap = new Map((blockscoutChartData || []).map((d) => [d.date, Number(d.transaction_count)]));
  const merged = [];
  const today = new Date();
  let started = false;

  for (let i = 0; i < daysBack; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    let count = null;
    if (bsMap.has(dateStr)) count = bsMap.get(dateStr);
    else if (ourDays?.[dateStr]) count = ourDays[dateStr].txCount;

    if (count == null) {
      if (!started) continue; // today (or the very front of the window) just isn't closed/scanned yet
      break; // a real gap in otherwise-real history — stop here
    }
    started = true;
    merged.push({ date: dateStr, transaction_count: count });
  }

  return merged;
}

export function reconstructCumulativeTransactions(dailyChartData, currentTotal) {
  if (!Array.isArray(dailyChartData) || !Number.isFinite(currentTotal)) return [];

  // Blockscout returns newest-first; oldest-first is what we build the running subtraction over.
  const oldestFirst = [...dailyChartData].reverse();
  let runningLaterSum = 0;
  const series = new Array(oldestFirst.length);

  for (let i = oldestFirst.length - 1; i >= 0; i--) {
    series[i] = { label: oldestFirst[i].date, value: currentTotal - runningLaterSum };
    const count = Number(oldestFirst[i].transaction_count);
    runningLaterSum += Number.isFinite(count) ? count : 0;
  }

  return series;
}
