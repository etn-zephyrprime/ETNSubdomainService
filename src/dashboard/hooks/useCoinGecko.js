import { useCallback } from "react";

// Direct CoinGecko calls, same as backend/utils/etnPriceCache.js's reasoning for using this API
// at all — confirmed live that CoinGecko's public API sets access-control-allow-origin: *, so no
// backend proxy is needed here either. Used instead of Blockscout's own /stats/charts/market for
// price history specifically because that field is mostly empty on this Blockscout deployment
// (only the most recent day has a non-null closing_price — confirmed while building the original
// Overview chart) — CoinGecko has genuine, complete daily history.
const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";

export function useCoinGecko() {
  // `days` -> Blockscout-style daily granularity is plenty for a dashboard chart; CoinGecko's
  // default granularity auto-adjusts by range anyway (hourly under ~90 days), which is fine here
  // since the chart de-dupes visually at this size regardless.
  const getMarketChart = useCallback(async (days = 90) => {
    const res = await fetch(`${COINGECKO_API_BASE}/coins/electroneum/market_chart?vs_currency=usd&days=${days}`);
    if (!res.ok) throw new Error(`CoinGecko market_chart returned ${res.status}`);
    return res.json(); // { prices: [[ms, usd], ...], market_caps: [[ms, usd], ...], total_volumes }
  }, []);

  // Real OHLC candles — confirmed live: CoinGecko auto-picks candle width by range (30min under
  // 2 days, 4h for 3-30 days, 4-day for 31-90 days on the free tier), same `days` param as
  // getMarketChart above.
  const getOhlc = useCallback(async (days = 30) => {
    const res = await fetch(`${COINGECKO_API_BASE}/coins/electroneum/ohlc?vs_currency=usd&days=${days}`);
    if (!res.ok) throw new Error(`CoinGecko ohlc returned ${res.status}`);
    return res.json(); // [[ms, open, high, low, close], ...]
  }, []);

  return { getMarketChart, getOhlc };
}
