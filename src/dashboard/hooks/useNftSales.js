import { useEffect, useState } from "react";
import { r2ProxyUrl } from "../../config.js";

// Real on-chain NFT sale history for a single collection — see nftSalesCache.js for how this is
// scanned (Seaport OrderFulfilled events) and why it deliberately has no floor price. `sales.json`
// is a flat, all-collections array; filtered down to this one collection here rather than in the
// backend, since it's a single small fetch either way and keeps nftSalesCache.js's cache
// shape simple (matches nameServiceStatsCache.js's flat-events convention).
export function useNftSales(collectionAddress) {
  const [sales, setSales] = useState(null); // this collection's sales, oldest first, or [] if none yet
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!collectionAddress) return;
    let cancelled = false;
    setSales(null);
    setError(null);

    fetch(r2ProxyUrl("nft-sales.json"))
      .then((r) => (r.ok ? r.json() : { sales: [] }))
      .then((res) => {
        if (cancelled) return;
        const addr = collectionAddress.toLowerCase();
        const all = Array.isArray(res?.sales) ? res.sales : [];
        setSales(all.filter((s) => s.collectionAddress === addr));
      })
      .catch((err) => {
        console.error("Failed to load NFT sales:", err);
        if (!cancelled) setError("Couldn't load sale history — try again shortly.");
      });

    return () => { cancelled = true; };
  }, [collectionAddress]);

  return { sales, loading: sales === null && !error, error };
}
