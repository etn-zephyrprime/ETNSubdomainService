import { useCallback } from "react";
import { PNL_BACKEND_URL } from "../../config.js";

// Core tier's tracked-wallet list — GET/PUT /api/premium/tracked-wallets, both requiring a signed
// proof of wallet ownership (see useWalletAuthSignature.js) AND an active Core tier membership
// (checked server-side; see backend/utils/premiumAccess.js). A 403 here specifically means "not a
// Core tier member" — surfaced as its own error code rather than a plain thrown Error so callers
// can show an upsell instead of a generic failure message.
export function useTrackedWallets() {
  const getTrackedWallets = useCallback(async (wallet, signature, timestamp) => {
    const params = new URLSearchParams({ wallet, signature, timestamp });
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/tracked-wallets?${params}`);
    if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
    if (!res.ok) throw new Error(`Failed to load tracked wallets (${res.status})`);
    return res.json();
  }, []);

  const setTrackedWallets = useCallback(async (wallet, signature, timestamp, wallets) => {
    const res = await fetch(`${PNL_BACKEND_URL}/api/premium/tracked-wallets`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, timestamp, wallets }),
    });
    if (res.status === 403) throw new Error("CORE_ACCESS_REQUIRED");
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to save tracked wallets (${res.status})`);
    }
    return res.json();
  }, []);

  return { getTrackedWallets, setTrackedWallets };
}
