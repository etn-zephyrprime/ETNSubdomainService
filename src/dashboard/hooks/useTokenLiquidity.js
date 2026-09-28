import { useEffect, useState } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/tokenLiquidityCache.js publishes every ElectroSwap-listed token's total liquidity
// (USD) to R2 on a ~15min timer — same shared-cache/single-poller pattern as src/hooks/
// useTokenPrices.js, just for liquidity instead of price. Backs TokenLeaderboard.jsx's "sort by
// liquidity" + $ display on the free Tokens tab.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Map<lowercased token address, { usd, poolCount }> — a token ElectroSwap doesn't list (or that
// hasn't parsed correctly this cycle) is simply absent from the map, never a fabricated 0. `usd` is
// a SUM across every pool the token appears in (see tokenLiquidityCache.js's own comment) —
// `poolCount` is how many pools were summed, so a caller can show "$X across N pools" instead of a
// bare figure that reads like one pool's own size (confirmed confusing live: WETN's $204k is 116
// pools added together, not one WETN pool).
let cachedLiquidity = new Map();
let subscribers = new Set();

async function fetchAndBroadcast() {
  try {
    const res = await fetch(r2ProxyUrl("token-liquidity.json"));
    if (!res.ok) return;
    const data = await res.json();
    if (!data || typeof data.liquidityUsd !== "object") return;

    const next = new Map();
    for (const [address, usd] of Object.entries(data.liquidityUsd)) {
      if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0) {
        const poolCount = data.poolCounts?.[address];
        next.set(address.toLowerCase(), { usd, poolCount: typeof poolCount === "number" ? poolCount : null });
      }
    }
    cachedLiquidity = next;
    subscribers.forEach((fn) => fn(cachedLiquidity));
  } catch (err) {
    console.warn("Token liquidity fetch failed:", err.message);
  }
}

let refreshTimer = null;
function ensurePolling() {
  if (refreshTimer) return;
  fetchAndBroadcast();
  refreshTimer = setInterval(fetchAndBroadcast, REFRESH_INTERVAL_MS);
}

/**
 * Returns a Map<lowercased token address, { usd, poolCount }> — empty until the first successful
 * fetch. Shared module-level cache + a single polling timer regardless of how many components call
 * this.
 */
export function useTokenLiquidity() {
  const [liquidity, setLiquidity] = useState(cachedLiquidity);

  useEffect(() => {
    ensurePolling();
    subscribers.add(setLiquidity);
    if (cachedLiquidity.size > 0) setLiquidity(cachedLiquidity); // pick up a value fetched before mount
    return () => subscribers.delete(setLiquidity);
  }, []);

  return liquidity;
}
