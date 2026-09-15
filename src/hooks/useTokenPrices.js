import { useEffect, useState } from "react";
import { r2ProxyUrl } from "../config.js";

// backend/utils/tokenPriceCache.js publishes the live USD price of every whitelisted ERC20
// payment token to R2 on a timer (ElectroSwap-backed — see that file's own header comment),
// mirroring what etnPriceCache.js/useEtnPrice.js already do for ETN itself. Fetched once here and
// shared across every component that renders a "≈ $X.XX" estimate for a token-denominated amount
// via UsdEstimate.jsx, rather than each one polling R2 independently.
//
// No fallback to fetching a price directly from the browser if this fails — same reasoning as
// useEtnPrice.js: every price display just renders without its USD estimate (UsdEstimate.jsx
// returns null while no price is available for that token), which is a much better failure mode
// than blocking the page or flooding a third party with direct client calls from every visitor.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Map<lowercased token address, usd price> — lowercased since the cache itself is published this
// way (see tokenPriceCache.js) and an on-chain `paymentToken` address arrives checksummed
// (mixed-case) — every lookup normalizes to lowercase so the two always agree regardless of case.
let cachedPrices = new Map();
let subscribers = new Set();

async function fetchAndBroadcast() {
  try {
    const res = await fetch(r2ProxyUrl("token-prices.json"));
    if (!res.ok) return;
    const data = await res.json();
    if (!data || typeof data.prices !== "object") return;

    const next = new Map();
    for (const [address, usd] of Object.entries(data.prices)) {
      if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) {
        next.set(address.toLowerCase(), usd);
      }
    }
    cachedPrices = next;
    subscribers.forEach((fn) => fn(cachedPrices));
  } catch (err) {
    console.warn("Token price fetch failed:", err.message);
  }
}

let refreshTimer = null;
function ensurePolling() {
  if (refreshTimer) return;
  fetchAndBroadcast();
  refreshTimer = setInterval(fetchAndBroadcast, REFRESH_INTERVAL_MS);
}

/**
 * Returns a Map<lowercased token address, USD price> — empty until the first successful fetch (or
 * for any token ElectroSwap doesn't have a price for, which is simply absent from the map, never a
 * fabricated 0). Shared module-level cache + a single polling timer regardless of how many
 * components call this — same pattern as useEtnPrice.js.
 */
export function useTokenPrices() {
  const [prices, setPrices] = useState(cachedPrices);

  useEffect(() => {
    ensurePolling();
    subscribers.add(setPrices);
    if (cachedPrices.size > 0) setPrices(cachedPrices); // pick up a value fetched before mount
    return () => subscribers.delete(setPrices);
  }, []);

  return prices;
}
