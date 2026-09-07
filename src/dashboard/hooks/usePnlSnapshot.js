import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// GET /api/premium/pnl-snapshot (live "right now" figures) and /pnl-history (the value-over-time
// chart's daily rollup) — Core tier's ongoing dashboard PnL feature. Same auth/error conventions
// as every other Core tier hook (useWalletAlerts.js etc.).
async function parseErrorOrThrow(res) {
  if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function usePnlSnapshot() {
  // Live compute — same order of magnitude as generating a PnL Statement (full FIFO replay + live
  // pricing per wallet), not a quick read. Callers should treat this as a real wait, not a poll
  // tick — see CoreTierPnl.jsx's own "fetch once, refresh on request" pattern.
  const getLiveSnapshot = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/pnl-snapshot?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { perWallet: [...], combined }
  }, []);

  const getHistory = useCallback(async (wallet, signature, timestamp, days) => {
    const params = new URLSearchParams({ wallet, signature, timestamp, ...(days ? { days: String(days) } : {}) });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/pnl-history?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { perWallet: [{walletAddress, points}], combined: [{date, totalValueUsd, realizedPnlUsd, unrealizedPnlUsd}] }
  }, []);

  return { getLiveSnapshot, getHistory };
}
