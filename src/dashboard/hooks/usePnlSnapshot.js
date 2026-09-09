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
  //
  // `priorityTokens` (optional): `{ [walletAddress]: [tokenAddress, ...] }` — the cold-start
  // speedup. Only matters for a wallet still mid-cold-start; see pnlSnapshotRouter.js's own
  // comment for the full mechanism and its safety boundary (a wallet past cold-start ignores this
  // entirely and always gets full pricing).
  const getLiveSnapshot = useCallback(async (wallet, signature, timestamp, priorityTokens) => {
    const params = new URLSearchParams({
      wallet,
      signature,
      timestamp,
      ...(priorityTokens ? { priorityTokens: JSON.stringify(priorityTokens) } : {}),
    });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/pnl-snapshot?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { perWallet, combined, failed: [address,...], needsSelection: [{walletAddress, availableTokens}] }
  }, []);

  const getHistory = useCallback(async (wallet, signature, timestamp, days) => {
    const params = new URLSearchParams({ wallet, signature, timestamp, ...(days ? { days: String(days) } : {}) });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/pnl-history?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { perWallet: [{walletAddress, points}], combined: [{date, totalValueUsd, realizedPnlUsd, unrealizedPnlUsd}] }
  }, []);

  // Same shape as getHistory above, scoped to one category ("liquidity" or "farm_staking" — see
  // categoryPnlService.js's own CATEGORIES) — /premium/pnl-category-history.
  const getCategoryHistory = useCallback(async (wallet, signature, timestamp, category, days) => {
    const params = new URLSearchParams({ wallet, signature, timestamp, category, ...(days ? { days: String(days) } : {}) });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/pnl-category-history?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { perWallet: [{walletAddress, points}], combined: [{date, totalValueUsd, realizedPnlUsd, unrealizedPnlUsd}] }
  }, []);

  return { getLiveSnapshot, getHistory, getCategoryHistory };
}
