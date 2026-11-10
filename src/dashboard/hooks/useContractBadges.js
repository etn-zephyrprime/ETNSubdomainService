import { useEffect, useState } from "react";
import { r2ProxyUrl } from "../../config.js";

// The free tier's Contract Check: just the overall badge for ElectroSwap-listed tokens, from the static
// contract-badges.json backend/services/contractCheck/badges.js publishes every few hours. No API call,
// no wallet. Same shared-cache/single-fetch pattern as useTokenLiquidity.js.
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

let cachedBadges = new Map(); // Map<lowercased token address, "green" | "amber" | "red">
const subscribers = new Set();

async function fetchAndBroadcast() {
  try {
    const res = await fetch(r2ProxyUrl("contract-badges.json"));
    if (!res.ok) return;
    const data = await res.json();
    if (!data || typeof data.badges !== "object") return;
    cachedBadges = new Map(Object.entries(data.badges).map(([a, o]) => [a.toLowerCase(), o]));
    subscribers.forEach((fn) => fn(cachedBadges));
  } catch (err) {
    console.warn("Contract badges fetch failed:", err.message);
  }
}

let refreshTimer = null;
function ensurePolling() {
  if (refreshTimer) return;
  fetchAndBroadcast();
  refreshTimer = setInterval(fetchAndBroadcast, REFRESH_INTERVAL_MS);
}

/** Map<lowercased token address, overall> — empty until the first fetch; a token with no badge is absent. */
export function useContractBadges() {
  const [badges, setBadges] = useState(cachedBadges);
  useEffect(() => {
    ensurePolling();
    subscribers.add(setBadges);
    if (cachedBadges.size > 0) setBadges(cachedBadges);
    return () => subscribers.delete(setBadges);
  }, []);
  return badges;
}
