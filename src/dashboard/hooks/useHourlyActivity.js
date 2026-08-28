import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/hourlyActivityCache.js's real per-UTC-hour tx counts + ETN volume transferred,
// rolling last ~8 days — see that file's header comment for why this exists (no source anywhere
// else has either figure at hourly granularity). Same no-fallback-on-failure pattern as this
// app's other R2-backed hooks.
export function useHourlyActivity() {
  const getHourlyActivity = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("hourly-activity.json"));
      if (!res.ok) return null;
      return res.json(); // { hours: { "2026-08-28T14": { txCount, etnVolumeWei } } }
    } catch (err) {
      console.warn("Hourly activity fetch failed:", err.message);
      return null;
    }
  }, []);

  return { getHourlyActivity };
}
