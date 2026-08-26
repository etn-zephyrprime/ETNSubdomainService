import { useCallback } from "react";
import { R2_PUBLIC_URL } from "../../config.js";

// backend/utils/dashboardStatsCache.js publishes hourly network-stat snapshots to R2 — see its
// header comment for why this exists (Blockscout has no historical endpoint for these fields at
// all). Same no-fallback-on-failure pattern as this app's other R2-backed hooks: a fetch failure
// just means these particular charts show no data, nothing else breaks.
export function useDashboardStats() {
  const getSnapshots = useCallback(async () => {
    if (!R2_PUBLIC_URL) return [];
    try {
      const res = await fetch(`${R2_PUBLIC_URL.replace(/\/$/, "")}/dashboard-stats-history.json`);
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
 * arithmetic on two real numbers this app already fetches.
 */
export function reconstructCumulativeTransactions(dailyChartData, currentTotal) {
  if (!Array.isArray(dailyChartData) || !Number.isFinite(currentTotal)) return [];

  // Blockscout returns newest-first; oldest-first is what we build the running subtraction over.
  const oldestFirst = [...dailyChartData].reverse();
  let runningLaterSum = 0;
  const series = new Array(oldestFirst.length);

  for (let i = oldestFirst.length - 1; i >= 0; i--) {
    series[i] = currentTotal - runningLaterSum;
    const count = Number(oldestFirst[i].transaction_count);
    runningLaterSum += Number.isFinite(count) ? count : 0;
  }

  return series;
}
