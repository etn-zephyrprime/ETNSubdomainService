import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Closed farm-position cycle history — GET /api/premium/defi-closed-positions, same signed-
// ownership + Core tier membership gate as every other Core tier endpoint. Deliberately separate
// from useDefiPositions.js (the OPEN positions hook): this is lazily fetched behind the Portfolio
// tab's "Show closed positions" toggle, not loaded on every page view — see
// backend/services/defiPositionValuation.js's own getClosedFarmPositionsUsd comment for why no
// caching layer backs this on the server either.
async function parseErrorOrThrow(res) {
  if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function useClosedDefiPositions() {
  const getClosedDefiPositions = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/defi-closed-positions?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { perWallet: [{walletAddress, positions}], combined: {positions} }
  }, []);

  return { getClosedDefiPositions };
}
