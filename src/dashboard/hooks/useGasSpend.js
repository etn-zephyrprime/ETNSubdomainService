import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Per-day gas spent (ETN) per covered wallet — GET /api/premium/gas-spend, same signed-ownership +
// Core tier gate as every other Core Tier endpoint.
export function useGasSpend() {
  const getGasSpend = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/gas-spend?${params}`);
    if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return res.json(); // { perWallet: [{ walletAddress, daily: [{ day, etn, txCount }] }] }
  }, []);
  return { getGasSpend };
}
