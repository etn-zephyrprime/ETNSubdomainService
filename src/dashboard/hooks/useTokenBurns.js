import { useCallback } from "react";
import { BACKEND_IMAGE_URL } from "../../config.js";

// Backs TokenDetail.jsx's burn-history chart — calls this app's own backend
// (tokenChartRouter.js's /token-burns route -> tokenBurnService.js), which does the actual on-chain
// log scanning; GeckoTerminal has no concept of "burns" at all, so unlike the price chart there's
// no external API this could otherwise hit directly.
export function useTokenBurns() {
  const getTokenBurns = useCallback(async (address) => {
    const res = await fetch(`${BACKEND_IMAGE_URL}/api/token-burns?address=${address}`);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `Token burns request failed (${res.status})`);
    }
    return res.json(); // { isCore, burnAddress, totalBurnedRaw, series: [{date, cumulativeRaw}], recentEvents, fullyBackfilled }
  }, []);

  return { getTokenBurns };
}
