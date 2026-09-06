import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Core tier's tracked-wallet list — GET/POST/DELETE /api/premium/tracked-wallets, all requiring a
// signed proof of wallet ownership (see useWalletAuthSignature.js) AND an active Core tier
// membership (checked server-side; see backend/utils/premiumAccess.js). A 403 here specifically
// means "not a Core tier member" — surfaced as its own error code rather than a plain thrown Error
// so callers can show an upsell instead of a generic failure message.
//
// Add/remove are separate calls, not "save this whole list" — see premiumDashboardRouter.js's own
// header comment for why: each one enforces its own 30-day cooldown (can't untrack a just-added
// wallet, can't re-track a just-removed one) against that specific wallet's own history, which a
// whole-list diff-and-replace can't do cleanly.
async function parseErrorOrThrow(res) {
  if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export function useTrackedWallets() {
  const getTrackedWallets = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/tracked-wallets?${params}`);
    await parseErrorOrThrow(res);
    return res.json(); // { active, cooling, maxWallets, cooldownDays }
  }, []);

  const addTrackedWallet = useCallback(async (wallet, signature, timestamp, walletToTrack) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/tracked-wallets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, timestamp, walletToTrack }),
    });
    await parseErrorOrThrow(res);
    return res.json(); // { active, maxWallets, cooldownDays }
  }, []);

  const removeTrackedWallet = useCallback(async (wallet, signature, timestamp, walletToUntrack) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/tracked-wallets`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, timestamp, walletToUntrack }),
    });
    await parseErrorOrThrow(res);
    return res.json(); // { active, maxWallets, cooldownDays }
  }, []);

  return { getTrackedWallets, addTrackedWallet, removeTrackedWallet };
}
