import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/dailyBlockStatsCache.js's real per-UTC-day tx counts + validator breakdowns —
// see that file's header comment for why this exists (Blockscout has neither a 90-day chart nor
// any validator/miner data at all). Same no-fallback-on-failure pattern as this app's other
// R2-backed hooks: a fetch failure just means these particular charts show no data.
export function useDailyBlockStats() {
  const getDailyBlockStats = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("daily-block-stats.json"));
      if (!res.ok) return null;
      return res.json(); // { days: { "2026-08-28": { txCount, blockCount, validators } } }
    } catch (err) {
      console.warn("Daily block stats fetch failed:", err.message);
      return null;
    }
  }, []);

  return { getDailyBlockStats };
}
