import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// GET /api/premium/recent-activity — Core tier's Recent Activity feed (recentActivityService.js).
// Same auth/error conventions as useNftPnlSnapshot.js's own getNftPnlSnapshot.
async function parseErrorOrThrow(res) {
  if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function useRecentActivity() {
  const getRecentActivity = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/recent-activity?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { perWallet: [{ walletAddress, items }], failed: [address,...] }
  }, []);

  return { getRecentActivity };
}
