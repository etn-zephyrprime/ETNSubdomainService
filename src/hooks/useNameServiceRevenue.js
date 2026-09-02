import { useState, useEffect, useCallback } from "react";
import { r2ProxyUrl } from "../config.js";

// Same published cache the dashboard's Name Service tab already reads (see
// dashboard/hooks/useNameServiceStats.js) — deliberately re-fetched here via a separate,
// main-app-scoped hook rather than importing that one directly, matching this app's existing
// bundle-separation convention (see main.jsx's header comment): the dashboard and the main
// ENS site are two different bundles sharing one deploy, and nothing under src/dashboard/ should
// be a dependency of anything under src/ itself. config.js's r2ProxyUrl is shared/side-effect-free,
// so importing that alone is fine.
//
// This only pulls totalSellerRevenueWei out of name-service-stats.json — the homepage's Total
// Domain Revenue card (see components/DomainRevenueCard.jsx) doesn't need the rest of that
// payload (event history, floor price, etc.), unlike the dashboard's own richer stats view.
const POLL_INTERVAL_MS = 900000; // matches nameServiceStatsCache.js's own 15-minute refresh cadence — no point polling faster than the source updates

export function useNameServiceRevenue() {
  const [totalSellerRevenueWei, setTotalSellerRevenueWei] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(r2ProxyUrl("name-service-stats.json"));
      const data = res.ok ? await res.json() : null;
      setTotalSellerRevenueWei(data?.totalSellerRevenueWei ?? "0");
      setError(null);
    } catch (err) {
      console.error("Failed to load Name Service revenue stats:", err);
      setError("Couldn't load total domain revenue");
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { totalSellerRevenueWei, error };
}
