import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Per-token balance-over-time, per wallet — GET /api/premium/token-balance-history, same
// signed-ownership + Core tier gate as every other Core Tier endpoint. Backs
// CoreTierBalanceHistory.jsx's token dropdown; a genuinely new capability (see
// tokenBalanceHistoryService.js's own header comment) built from this app's own ingested transfer
// history, not Blockscout (which has no per-token equivalent of coin-balance-history-by-day).
async function parseErrorOrThrow(res) {
  if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function useTokenBalanceHistory() {
  const getTokenBalanceHistory = useCallback(async (wallet, signature, timestamp, tokenAddress) => {
    const params = new URLSearchParams({ wallet, signature, timestamp, tokenAddress });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/token-balance-history?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { perWallet: [{ walletAddress, series: [{date, balance}] }] }
  }, []);

  return { getTokenBalanceHistory };
}
