import { useCallback, useRef } from "react";
import { signWalletAuth } from "../utils/walletAuth.js";

// A signed wallet-ownership proof (see src/utils/walletAuth.js) is only valid for a few minutes
// (backend/utils/walletAuth.js's AUTH_MAX_SKEW_MS) -- caches the signature and only re-prompts
// the wallet for a new one once it's genuinely close to expiring, so a component that polls an
// auth-gated endpoint (PnlStatementProgress.jsx) doesn't trigger a new signature popup on every
// single poll tick. Re-signs immediately if the connected account has changed since the last one.
//
// `purpose` (see walletAuth.js) is part of what gets signed, so it's part of the cache key too —
// one hook instance asked for two different purposes (unusual, but not prevented) must not hand
// back a cached signature for the wrong one.
//
// Also de-dupes CONCURRENT calls, not just repeated ones over time: several components/effects
// commonly call getAuthParams(sameAddress, samePurpose) within the same tick (e.g. a screen that
// fires 3-4 independent data loads on mount, or several sibling components each owning their own
// access-check state) — each one is an async function that reaches this cache check before any of
// the others has resolved and populated cacheRef, so without tracking the in-flight request itself
// (not just its eventual result) every one of them would see "nothing cached yet" and independently
// prompt the wallet for its own signature. Confirmed live: exactly this caused 6-7 simultaneous
// signature prompts on one dashboard tab load, across several components that each — correctly, in
// isolation — thought they were the first to need one. inFlightRef makes every concurrent caller
// for the same (address, purpose) share the one real request instead.
const AUTH_LIFETIME_MS = 5 * 60 * 1000; // must match the backend's AUTH_MAX_SKEW_MS
const REFRESH_BEFORE_EXPIRY_MS = 60 * 1000; // re-sign with a minute of buffer left

export function useWalletAuthSignature(wallet) {
  const cacheRef = useRef(null); // { address, purpose, signature, timestamp } | null
  const inFlightRef = useRef(null); // { address, purpose, promise } | null

  const getAuthParams = useCallback(async (purpose) => {
    if (!wallet?.account) throw new Error("Wallet not connected");

    const cached = cacheRef.current;
    const stillFresh =
      cached &&
      cached.address === wallet.account &&
      cached.purpose === purpose &&
      Date.now() - cached.timestamp < AUTH_LIFETIME_MS - REFRESH_BEFORE_EXPIRY_MS;

    if (stillFresh) return cached;

    const inFlight = inFlightRef.current;
    if (inFlight && inFlight.address === wallet.account && inFlight.purpose === purpose) {
      return inFlight.promise;
    }

    const promise = (async () => {
      const signer = await wallet.getSigner();
      const { signature, timestamp } = await signWalletAuth(signer, wallet.account, purpose);
      const result = { address: wallet.account, purpose, signature, timestamp };
      cacheRef.current = result;
      return result;
    })();

    inFlightRef.current = { address: wallet.account, purpose, promise };
    try {
      return await promise;
    } finally {
      // Only clear if this is still the request we set — a newer call (different purpose/account)
      // may have already replaced it by the time this one settles.
      if (inFlightRef.current?.promise === promise) inFlightRef.current = null;
    }
  }, [wallet]);

  return getAuthParams;
}
