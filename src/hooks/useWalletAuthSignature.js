import { useCallback } from "react";
import { signWalletAuth } from "../utils/walletAuth.js";

// A signed wallet-ownership proof (see src/utils/walletAuth.js) is only valid for 30 minutes
// (backend/utils/walletAuth.js's AUTH_MAX_SKEW_MS — see that constant's own comment for why 30
// minutes is a reasonable window for a read-only proof) -- caches the signature and only
// re-prompts the wallet for a new one once it's genuinely close to expiring, so a component that
// polls an auth-gated endpoint (PnlStatementProgress.jsx, or the Core Tier PnL/Portfolio tabs'
// own ingest-progress polling) doesn't trigger a new signature popup on every single poll tick.
// Re-signs immediately if the connected account has changed since the last one.
//
// MODULE-LEVEL cache, deliberately NOT a useRef — confirmed live this was a real gap: Core Tier's
// tabs (PortfolioDashboardSection.jsx) are conditionally rendered ({tab === "portfolio" && <.../>}
// in DashboardApp.jsx), so switching to any other tab and back fully unmounts and remounts this
// hook's own component instance. A useRef-scoped cache dies with that unmount — the 30-minute
// lifetime above never gets a chance to matter if the member ever navigates away and back, which is
// completely ordinary usage, not an edge case. A plain module-level variable survives any number of
// mount/unmount cycles for as long as the page itself stays open (reset only on a real page
// reload/navigation, same boundary this signature's own security already assumes), and is shared
// correctly across every caller regardless of which component instance asks — the (address,
// purpose) keying below already isolates unrelated requests from each other, the same as it always
// did.
//
// `purpose` (see walletAuth.js) is part of what gets signed, so it's part of the cache key too —
// two different callers asking for two different purposes must not hand back a cached signature
// for the wrong one.
//
// Also de-dupes CONCURRENT calls, not just repeated ones over time: several components/effects
// commonly call getAuthParams(sameAddress, samePurpose) within the same tick (e.g. a screen that
// fires 3-4 independent data loads on mount, or several sibling components each owning their own
// access-check state) — each one is an async function that reaches this cache check before any of
// the others has resolved and populated the cache, so without tracking the in-flight request itself
// (not just its eventual result) every one of them would see "nothing cached yet" and independently
// prompt the wallet for its own signature. Confirmed live: exactly this caused 6-7 simultaneous
// signature prompts on one dashboard tab load, across several components that each — correctly, in
// isolation — thought they were the first to need one. inFlightAuth makes every concurrent caller
// for the same (address, purpose) share the one real request instead.
const AUTH_LIFETIME_MS = 30 * 60 * 1000; // must match the backend's AUTH_MAX_SKEW_MS
const REFRESH_BEFORE_EXPIRY_MS = 60 * 1000; // re-sign with a minute of buffer left

let cachedAuth = null; // { address, purpose, signature, timestamp } | null
let inFlightAuth = null; // { address, purpose, promise } | null

export function useWalletAuthSignature(wallet) {
  const getAuthParams = useCallback(async (purpose) => {
    if (!wallet?.account) throw new Error("Wallet not connected");

    const stillFresh =
      cachedAuth &&
      cachedAuth.address === wallet.account &&
      cachedAuth.purpose === purpose &&
      Date.now() - cachedAuth.timestamp < AUTH_LIFETIME_MS - REFRESH_BEFORE_EXPIRY_MS;

    if (stillFresh) return cachedAuth;

    if (inFlightAuth && inFlightAuth.address === wallet.account && inFlightAuth.purpose === purpose) {
      return inFlightAuth.promise;
    }

    const promise = (async () => {
      const signer = await wallet.getSigner();
      const { signature, timestamp } = await signWalletAuth(signer, wallet.account, purpose);
      const result = { address: wallet.account, purpose, signature, timestamp };
      cachedAuth = result;
      return result;
    })();

    inFlightAuth = { address: wallet.account, purpose, promise };
    try {
      return await promise;
    } finally {
      // Only clear if this is still the request we set — a newer call (different purpose/account)
      // may have already replaced it by the time this one settles.
      if (inFlightAuth?.promise === promise) inFlightAuth = null;
    }
  }, [wallet]);

  return getAuthParams;
}
