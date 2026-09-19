import { useCallback } from "react";
import { BACKEND_IMAGE_URL } from "../../config.js";

// 24h price change per token, from tokenChartRouter.js's /token-price-changes — sibling of
// useBatchTokenPrices.js, same "one batched call for a whole portfolio" reasoning.
export function useTokenPriceChanges() {
  const getTokenPriceChanges = useCallback(async (addresses) => {
    const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
    if (unique.length === 0) return {};

    const res = await fetch(`${BACKEND_IMAGE_URL}/api/token-price-changes?addresses=${unique.join(",")}`);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `Token price change request failed (${res.status})`);
    }
    const data = await res.json();
    return data.changes || {}; // { [lowercased address]: fractional change (0.2 = +20%) } -- absent means unknown, not 0
  }, []);

  return { getTokenPriceChanges };
}
