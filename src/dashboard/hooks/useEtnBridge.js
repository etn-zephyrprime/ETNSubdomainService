import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/etnBridge.js publishes the ETNBridge tracker's data to R2: `points` (cumulative ETN migrated
// over time — daily since the contract was deployed, hourly for the last two weeks), `current` (latest
// migrated total / migration count / ETN still in the bridge), and `top7d` (the largest migrations of the
// rolling last 7 days). Same no-fallback-on-failure pattern as the dashboard's other R2-backed hooks: a
// failed fetch resolves to null and the tab just shows a message.
export function useEtnBridge() {
  const getEtnBridge = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("etn-bridge.json"));
      if (!res.ok) return null;
      const data = await res.json();
      return {
        points: Array.isArray(data?.points) ? data.points : [],
        current: data?.current ?? null,
        top7d: data?.top7d ?? null,
        backfill: data?.backfill ?? null,
        updatedAt: data?.updatedAt ?? null,
      };
    } catch (err) {
      console.warn("ETN bridge fetch failed:", err.message);
      return null;
    }
  }, []);

  return { getEtnBridge };
}
