import { useCallback } from "react";
import { BACKEND_IMAGE_URL } from "../../config.js";

// Backs EtnPriceChart.jsx's long-range (1Y/All) view — calls this app's own backend
// (tokenChartRouter.js's /etn-price-history route), which is backed by price_points (see
// pnlPricing.js's KuCoin backfill), not CoinGecko directly. CoinGecko's free API caps history at
// 365 days; this is specifically for ranges that cap can't serve at all.
export function useEtnPriceHistory() {
  const getEtnPriceHistory = useCallback(async (range) => {
    const res = await fetch(`${BACKEND_IMAGE_URL}/api/etn-price-history?range=${range}`);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `ETN price history request failed (${res.status})`);
    }
    return res.json(); // { points: [{ timestamp, priceUsd }, ...] }
  }, []);

  return { getEtnPriceHistory };
}
