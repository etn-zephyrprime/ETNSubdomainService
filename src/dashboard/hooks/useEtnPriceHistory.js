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

  // Fine-grained candles for the 7D (5-minute) and 90D (12-hour) price charts — the backend's
  // /etn-candles (KuCoin ETN-USDT; CoinGecko's free OHLC can't do either resolution). Evenly spaced,
  // gap-filled: { candles: [{ time (ms), open, high, low, close, volume }, ...] }.
  const getEtnCandles = useCallback(async (range) => {
    const res = await fetch(`${BACKEND_IMAGE_URL}/api/etn-candles?range=${range}`);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `ETN candles request failed (${res.status})`);
    }
    return res.json();
  }, []);

  return { getEtnPriceHistory, getEtnCandles };
}
