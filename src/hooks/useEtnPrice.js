import { useEffect, useState } from "react";
import { r2ProxyUrl } from "../config.js";

// backend/utils/etnPriceCache.js publishes the live ETN/USD price to R2 on a timer (every 5
// minutes by default) — fetched once here and shared across every component that renders a "≈
// $X.XX" estimate via UsdEstimate.jsx, rather than each one polling R2 independently.
//
// No fallback to fetching CoinGecko directly from the browser if this fails — same reasoning as
// useActivatedDomains.js/useOwnedNames.js: every price display just renders without its USD
// estimate (UsdEstimate.jsx returns null while usdPrice is null), which is a much better failure
// mode than either blocking the page on a third-party API or flooding it with direct client
// calls from every visitor.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let cachedPrice = null;
let subscribers = new Set();

async function fetchAndBroadcast() {
  try {
    const res = await fetch(r2ProxyUrl("etn-price.json"));
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data?.usd === "number" && Number.isFinite(data.usd) && data.usd > 0) {
      cachedPrice = data.usd;
      subscribers.forEach((fn) => fn(cachedPrice));
    }
  } catch (err) {
    console.warn("ETN price fetch failed:", err.message);
  }
}

let refreshTimer = null;
function ensurePolling() {
  if (refreshTimer) return;
  fetchAndBroadcast();
  refreshTimer = setInterval(fetchAndBroadcast, REFRESH_INTERVAL_MS);
}

/**
 * Returns the current ETN/USD price (a number), or null until the first successful fetch. Shared
 * module-level cache + a single polling timer regardless of how many components call this — a
 * page with a dozen price displays makes one fetch, not a dozen.
 */
export function useEtnPrice() {
  const [usdPrice, setUsdPrice] = useState(cachedPrice);

  useEffect(() => {
    ensurePolling();
    subscribers.add(setUsdPrice);
    if (cachedPrice !== null) setUsdPrice(cachedPrice); // pick up a value fetched before mount
    return () => subscribers.delete(setUsdPrice);
  }, []);

  return usdPrice;
}
