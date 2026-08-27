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
