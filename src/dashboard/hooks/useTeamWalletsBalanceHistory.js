import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/teamWalletsBalanceHistory.js publishes a daily "combined ETN balance across every
// known Electroneum team wallet" series (rolling ~12-month window) to R2 — see that file's own
// header comment for how it's backfilled from Blockscout's real per-event balance ledger, not
// reconstructed/estimated. Same no-fallback-on-failure pattern as this app's other R2-backed
// hooks: a fetch failure just means the chart shows nothing, nothing else breaks.
export function useTeamWalletsBalanceHistory() {
  const getBalanceHistory = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("team-wallets-balance-history.json"));
      if (!res.ok) return { series: [], wallets: {} };
      const data = await res.json();
      return { series: Array.isArray(data?.series) ? data.series : [], wallets: data?.wallets || {} };
    } catch (err) {
      console.warn("Team wallets balance history fetch failed:", err.message);
      return { series: [], wallets: {} };
    }
  }, []);

  return { getBalanceHistory };
}
