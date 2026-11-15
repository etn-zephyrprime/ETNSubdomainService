import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

export { mergeDailyTransactionCounts, reconstructCumulativeTransactions } from "../utils/transactionSeries.js";

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
