import { useEffect, useState } from "react";
import { r2ProxyUrl } from "../../config.js";

// backend/utils/tokenLocksCache.js publishes a liquidity-lock summary (count + latest unlock date)
// per token to R2 once a day — same shared-cache/single-poller pattern as useTokenLiquidity.js,
// just for lock data instead of liquidity. Backs the lock badge on every row of the free Tokens
// tab (TokenLeaderboard.jsx); TokenDetail.jsx's own per-token card still uses the separate, lazy
// useLiquidityLock.js hook (fresher, but only for the one token being viewed).
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // the underlying cache only changes once a day; this just re-polls the published file periodically

// Map<lowercased token address, { count, latestUnlockAt }> — a token never checked (or not paired
// in any pool ElectroSwap tracks) is simply absent, never a fabricated "no locks".
let cachedLocks = new Map();
let subscribers = new Set();

async function fetchAndBroadcast() {
  try {
    const res = await fetch(r2ProxyUrl("token-locks.json"));
    if (!res.ok) return;
    const data = await res.json();
    if (!data || typeof data.locksByAddress !== "object") return;

    const next = new Map();
    for (const [address, summary] of Object.entries(data.locksByAddress)) {
      if (summary && typeof summary.count === "number") {
        next.set(address.toLowerCase(), summary);
      }
    }
    cachedLocks = next;
    subscribers.forEach((fn) => fn(cachedLocks));
  } catch (err) {
    console.warn("Token locks fetch failed:", err.message);
  }
}

let refreshTimer = null;
function ensurePolling() {
  if (refreshTimer) return;
  fetchAndBroadcast();
  refreshTimer = setInterval(fetchAndBroadcast, REFRESH_INTERVAL_MS);
}

/**
 * Returns a Map<lowercased token address, { count, latestUnlockAt: ISOstring|null }> — empty until
 * the first successful fetch. Shared module-level cache + a single polling timer regardless of how
 * many components call this.
 */
export function useTokenLocks() {
  const [locks, setLocks] = useState(cachedLocks);

  useEffect(() => {
    ensurePolling();
    subscribers.add(setLocks);
    if (cachedLocks.size > 0) setLocks(cachedLocks); // pick up a value fetched before mount
    return () => subscribers.delete(setLocks);
  }, []);

  return locks;
}
