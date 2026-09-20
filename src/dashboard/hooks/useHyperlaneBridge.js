import { useCallback } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/hyperlaneBridge.js publishes every USDT/USDC transfer across the Hyperlane warp routes to R2
// as compact events, plus each token's current supply and the chains it is enrolled with. Same
// no-fallback-on-failure pattern as the dashboard's other R2-backed hooks: a failed fetch resolves to null and
// the tab shows a message.
export function useHyperlaneBridge() {
  const getHyperlaneBridge = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("hyperlane-bridge.json"));
      if (!res.ok) return null;
      const data = await res.json();
      return {
        tokens: Array.isArray(data?.tokens) ? data.tokens : [],
        events: Array.isArray(data?.events) ? data.events : [],
        current: data?.current && typeof data.current === "object" ? data.current : {},
        updatedAt: data?.updatedAt ?? null,
      };
    } catch (err) {
      console.warn("Hyperlane bridge fetch failed:", err.message);
      return null;
    }
  }, []);

  return { getHyperlaneBridge };
}
