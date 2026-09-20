import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/tvlHistory.js publishes ElectroSwap's total value locked over time to R2 (via this
// backend's own proxy, same as every other R2-backed hook — see config.js's r2ProxyUrl). Points are
// `{ t, tvlUsd, pools?, src? }`: hourly live measurements (full ISO `t`) for the last couple of weeks,
// daily points (date-only `t`) before that, the oldest from DefiLlama (`src: "defillama"`).
// A fetch failure just means the TVL tile shows no data; nothing else breaks. The pure helpers that turn
// these points into the chart series and headline figures live in ../utils/tvlSeries.js.
export function useTvlHistory() {
  const getTvlHistory = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("tvl-history.json"));
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data?.points) ? data.points : [];
    } catch (err) {
      console.warn("TVL history fetch failed:", err.message);
      return [];
    }
  }, []);

  return { getTvlHistory };
}
