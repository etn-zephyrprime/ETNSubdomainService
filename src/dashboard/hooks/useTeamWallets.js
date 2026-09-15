import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/teamWalletsCache.js publishes every known Electroneum team wallet's current ETN
// balance plus a merged, deduped feed of their recent real ETN movements to R2 — see that file's
// own header comment. Same no-fallback-on-failure pattern as this app's other R2-backed hooks: a
// fetch failure just means the Team Wallets tab shows nothing, nothing else breaks. Fetched via
// this backend's own proxy, not R2 directly — see config.js's r2ProxyUrl for why.
export function useTeamWallets() {
  const getTeamWallets = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("team-wallets.json"));
      if (!res.ok) return { wallets: [], movements: [], updatedAt: null };
      const data = await res.json();
      return {
        wallets: Array.isArray(data?.wallets) ? data.wallets : [],
        movements: Array.isArray(data?.movements) ? data.movements : [],
        updatedAt: data?.updatedAt || null,
      };
    } catch (err) {
      console.warn("Team wallets fetch failed:", err.message);
      return { wallets: [], movements: [], updatedAt: null };
    }
  }, []);

  return { getTeamWallets };
}
