import { useEffect, useState } from "react";
import { R2_PUBLIC_URL } from "../../config.js";

// Combines two R2-published caches, both already public/CORS-open — no backend call needed from
// the browser, same as every other dashboard data source:
//   - activated-domains.json (backs the homepage's own Activated Domains table already) — real,
//     current domain/subname counts and per-domain subname counts. No new backend work needed for
//     this half; it was already being published for an unrelated feature.
//   - name-service-stats.json (new — see nameServiceStatsCache.js) — timestamped event history
//     for the registrations trend, plus a live floor-price/active-listings snapshot. This half
//     genuinely didn't exist anywhere before.
export function useNameServiceStats() {
  const [domains, setDomains] = useState(null); // activated-domains.json's `domains` array
  const [stats, setStats] = useState(null); // name-service-stats.json
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${R2_PUBLIC_URL}/activated-domains.json`).then((r) => (r.ok ? r.json() : { domains: [] })),
      fetch(`${R2_PUBLIC_URL}/name-service-stats.json`).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([domainsRes, statsRes]) => {
        if (cancelled) return;
        setDomains(Array.isArray(domainsRes?.domains) ? domainsRes.domains : []);
        setStats(statsRes);
      })
      .catch((err) => {
        console.error("Failed to load Name Service stats:", err);
        if (!cancelled) setError("Couldn't load Name Service data — try again shortly.");
      });
    return () => { cancelled = true; };
  }, []);

  return { domains, stats, loading: domains === null && !error, error };
}
