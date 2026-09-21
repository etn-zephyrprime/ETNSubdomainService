import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/teamWalletsDestinations.js publishes a report of where the suspected team wallets' ETN went over the
// last 12 months (top destinations, what they did with it next, totals). Resolves to null on any failure so the
// Team Wallets tab just omits the section.
export function useTeamWalletDestinations() {
  const getTeamWalletDestinations = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("team-wallet-destinations.json"));
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data?.destinations) ? data : null;
    } catch (err) {
      console.warn("Team wallet destinations fetch failed:", err.message);
      return null;
    }
  }, []);
  return { getTeamWalletDestinations };
}
