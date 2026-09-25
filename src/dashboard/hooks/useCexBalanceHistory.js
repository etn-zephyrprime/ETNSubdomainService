import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/cexBalanceHistory.js publishes a daily "combined ETN balance across every known
// CEX/bridge address" series (rolling ~12-month window) plus each address's own current balance to
// R2 — see that file's own header comment for how it's backfilled from Blockscout's real per-event
// balance ledger, not reconstructed/estimated. Same no-fallback-on-failure pattern as this app's
// other R2-backed hooks: a fetch failure just means the tab shows nothing, nothing else breaks.
export function useCexBalanceHistory() {
  const getCexBalanceHistory = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("cex-balance-history.json"));
      if (!res.ok) return { series: [], addresses: [], updatedAt: null };
      const data = await res.json();
      return {
        series: Array.isArray(data?.series) ? data.series : [],
        addresses: Array.isArray(data?.addresses) ? data.addresses : [],
        updatedAt: data?.updatedAt || null,
      };
    } catch (err) {
      console.warn("CEX balance history fetch failed:", err.message);
      return { series: [], addresses: [], updatedAt: null };
    }
  }, []);

  return { getCexBalanceHistory };
}
