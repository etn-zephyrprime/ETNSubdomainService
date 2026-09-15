import { useEffect, useState } from "react";
import { BACKEND_IMAGE_URL } from "../../config.js";

// backend/utils/cexAddressesRouter.js exposes this backend's manually-maintained cex_addresses
// table (a known exchange/bridge counterparty list — Blockscout has no address tagging on
// Electroneum at all) to the dashboard. Same shared-module-cache-plus-single-poller pattern as
// useTokenPrices.js/useEtnPrice.js: fetched once, shared across every component that renders a
// "CEX" tag, rather than each one polling independently. No fallback on failure — a tag is
// cosmetic, so a fetch failure just means nothing gets tagged this session.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Map<lowercased address, label> — populated from the backend's own array-of-objects response.
let cachedMap = new Map();
let subscribers = new Set();

async function fetchAndBroadcast() {
  try {
    const res = await fetch(`${BACKEND_IMAGE_URL}/api/cex-addresses`);
    if (!res.ok) return;
    const data = await res.json();
    const next = new Map();
    for (const { address, label } of data?.addresses || []) {
      if (address) next.set(address.toLowerCase(), label || "CEX");
    }
    cachedMap = next;
    subscribers.forEach((fn) => fn(cachedMap));
  } catch (err) {
    console.warn("CEX addresses fetch failed:", err.message);
  }
}

let refreshTimer = null;
function ensurePolling() {
  if (refreshTimer) return;
  fetchAndBroadcast();
  refreshTimer = setInterval(fetchAndBroadcast, REFRESH_INTERVAL_MS);
}

/**
 * Returns a Map<lowercased address, label> of known CEX/bridge addresses — empty until the first
 * successful fetch. Shared module-level cache + a single polling timer regardless of how many
 * components call this, same pattern as useEtnPrice.js/useTokenPrices.js.
 */
export function useCexAddresses() {
  const [map, setMap] = useState(cachedMap);

  useEffect(() => {
    ensurePolling();
    subscribers.add(setMap);
    if (cachedMap.size > 0) setMap(cachedMap); // pick up a value fetched before mount
    return () => subscribers.delete(setMap);
  }, []);

  return map;
}
