import { useCallback } from "react";
import { BACKEND_IMAGE_URL } from "../../config.js";

// Backs a portfolio view's own token pricing (CoreTierPortfolio.jsx / CoreTierDemo.jsx /
// AddressLookup.jsx) — one batched call to this app's own backend (tokenChartRouter.js's
// /token-prices, ElectroSwap-first with a GeckoTerminal fallback) instead of each of those screens
// firing up to 50 individual useTokenChart calls, one per holding, just to read each one's latest
// close price. Confirmed live that a single cold /token-chart call can itself take 90+ seconds
// when ElectroSwap's own candles endpoint is slow to respond before falling back — 50 of those
// fired in parallel could never realistically finish inside a normal page view, which is why a
// portfolio's "Tokens" slice could sit at $0 despite real holdings. Not a replacement for
// useTokenChart — that still backs the Tokens tab's own per-token candle chart, which this
// endpoint doesn't provide.
export function useBatchTokenPrices() {
  const getBatchTokenPrices = useCallback(async (addresses) => {
    const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
    if (unique.length === 0) return {};

    const res = await fetch(`${BACKEND_IMAGE_URL}/api/token-prices?addresses=${unique.join(",")}`);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `Batch token price request failed (${res.status})`);
    }
    const data = await res.json();
    return data.prices || {}; // { [lowercased address]: usdPrice } -- absent means unpriced, not failed
  }, []);

  return { getBatchTokenPrices };
}
