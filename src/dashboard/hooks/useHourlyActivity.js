import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/hourlyActivityCache.js's real per-UTC-hour tx counts + ETN volume transferred,
// rolling last ~8 days, plus a real rolling-7-day top-transactions-by-value leaderboard — see
// that file's header comment for why both exist (no source anywhere else has any of this at
// per-transaction/hourly granularity). Same no-fallback-on-failure pattern as this app's other
// R2-backed hooks.
export function useHourlyActivity() {
  const getHourlyActivity = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("hourly-activity.json"));
      if (!res.ok) return null;
      // { hours: { "2026-08-28T14": { txCount, etnVolumeWei } },
      //   topTransactions: [{ hash, from, to, valueWei, timestampMs }], topTransactionsSinceMs }
      return res.json();
    } catch (err) {
      console.warn("Hourly activity fetch failed:", err.message);
      return null;
    }
  }, []);

  return { getHourlyActivity };
}
