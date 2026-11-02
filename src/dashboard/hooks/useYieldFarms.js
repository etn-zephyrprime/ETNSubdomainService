import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// GET /api/premium/yield-farms — Core Tier's Yield Farms tab: every farm, its wallets, and each one's
// remaining token0/token1 (backend/services/yieldFarmSnapshot.js; cached 10 minutes server-side).
export function useYieldFarms() {
  const getYieldFarms = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/yield-farms?${params}`);
    if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return res.json(); // { asOf, contract, farms: [{ id, name, active, token0, token1, total, farmers: [{ address, amount0, amount1, sharePct }] }] }
  }, []);
  return { getYieldFarms };
}
