import { useCallback } from "react";
import { r2ProxyUrl } from "../config.js";

// backend/utils/ownedNamesCache.js publishes every wrapped name (top-level domain or subname,
// activated or not) to R2 on a timer — same reasoning as useActivatedDomains.js/
// useMarketplaceListings.js's sellers fetch: resolving a whole wallet's holdings by scanning
// on-chain in the browser is exactly the RPC-flood problem fixed elsewhere in this app, just
// triggered by "how many names does this wallet own" instead of "how many domains exist".
//
// No fallback to an on-chain scan if this fetch fails — same call as useActivatedDomains.js, for
// the same reason. ManageSubdomain.jsx keeps its original manual-lookup box as a fallback UI
// instead, which also remains the only way to find a genuinely unwrapped ("retro", registered
// outside this app) name — see backend/utils/ownedNamesCache.js's header comment for why those
// can never appear in this list at all.
export function useOwnedNames() {
  const getOwnedNames = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("owned-names.json"));
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data?.names) ? data.names : [];
    } catch (err) {
      console.warn("Owned names cache fetch failed:", err.message);
      return [];
    }
  }, []);

  // Every name currently owned by `address`, sorted alphabetically. Case-insensitive — the cache
  // stores owner addresses lowercased, but callers may pass a checksummed wallet.account.
  const getNamesOwnedBy = useCallback(async (address) => {
    if (!address) return [];
    const all = await getOwnedNames();
    const addrLc = address.toLowerCase();
    return all
      .filter((n) => n.owner === addrLc)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [getOwnedNames]);

  return { getNamesOwnedBy };
}
