import { useCallback, useRef } from "react";
import { signWalletAuth } from "../utils/walletAuth.js";

// A signed wallet-ownership proof (see src/utils/walletAuth.js) is only valid for a few minutes
// (backend/utils/walletAuth.js's AUTH_MAX_SKEW_MS) -- caches the signature and only re-prompts
// the wallet for a new one once it's genuinely close to expiring, so a component that polls an
// auth-gated endpoint (PnlStatementProgress.jsx) doesn't trigger a new signature popup on every
// single poll tick. Re-signs immediately if the connected account has changed since the last one.
const AUTH_LIFETIME_MS = 5 * 60 * 1000; // must match the backend's AUTH_MAX_SKEW_MS
const REFRESH_BEFORE_EXPIRY_MS = 60 * 1000; // re-sign with a minute of buffer left

export function useWalletAuthSignature(wallet) {
  const cacheRef = useRef(null); // { address, signature, timestamp } | null

  const getAuthParams = useCallback(async () => {
    if (!wallet?.account) throw new Error("Wallet not connected");

    const cached = cacheRef.current;
    const stillFresh =
      cached &&
      cached.address === wallet.account &&
      Date.now() - cached.timestamp < AUTH_LIFETIME_MS - REFRESH_BEFORE_EXPIRY_MS;

    if (stillFresh) return cached;

    const signer = await wallet.getSigner();
    const { signature, timestamp } = await signWalletAuth(signer, wallet.account);
    const result = { address: wallet.account, signature, timestamp };
    cacheRef.current = result;
    return result;
  }, [wallet]);

  return getAuthParams;
}
