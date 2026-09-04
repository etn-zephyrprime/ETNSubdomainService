import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Site-wide, non-sensitive PnL statement stats (total CORE burned via this contract's own
// buy-and-burn flow, cumulative statements-requested series) — GET /api/pnl/stats, no wallet/auth
// needed. Same "no caching/state here, each screen owns its own loading/error state" shape as
// useBlockscout.js and this directory's other hooks.
export function usePnlStats() {
  const getStats = useCallback(async () => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/pnl/stats`);
    if (!res.ok) throw new Error(`Failed to load PnL stats (${res.status})`);
    return res.json();
  }, []);

  return { getStats };
}
