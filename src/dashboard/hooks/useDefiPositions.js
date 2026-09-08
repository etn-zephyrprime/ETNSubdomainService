import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Live value of a member's currently-open yield-farm/staking positions — GET
// /api/premium/defi-positions, same signed-ownership + Core tier membership gate as every other
// Core tier endpoint. Separate from useCombinedPortfolio.js's Blockscout token-balance read: funds
// moved into a farm/staking contract aren't a wallet token balance at all anymore, so that endpoint
// simply can't see them — see backend/services/defiPositionValuation.js's own header comment.
async function parseErrorOrThrow(res) {
  if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function useDefiPositions() {
  const getDefiPositions = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/defi-positions?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { perWallet: [{walletAddress, positions, totalUsd, hasUnpriced}], combined: {positions, totalUsd, hasUnpriced} }
  }, []);

  return { getDefiPositions };
}
