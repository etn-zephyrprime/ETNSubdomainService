import { useCallback, useEffect, useRef, useState } from "react";
import { useWalletAuthSignature } from "../../hooks/useWalletAuthSignature.js";
import { useTrackedWallets } from "./useTrackedWallets.js";

const AUTH_PURPOSE = "Premium Dashboard";

// Access re-check retry after a fresh subscribe (see the membershipVersion effect below) — the
// backend's own membership record only updates once premiumSubscriptionWatcher.js has polled and
// processed the purchase event (up to its own POLL_INTERVAL_MS, ~a minute by default), so a
// single immediate re-check right after the tx confirms would very often still see "not a member"
// even though the purchase genuinely went through. Retries every 10s for up to 2 minutes — past
// that, something's actually wrong (watcher down, RPC issue) rather than just normal lag.
const ACCESS_RETRY_INTERVAL_MS = 10 * 1000;
const ACCESS_RETRY_MAX_ATTEMPTS = 12;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Core tier's access + tracked-wallet-list state, shared by every Core Tier feature that needs
// "is this member allowed, and which wallets do they track" — originally lived entirely inside
// CoreTierPortfolio.jsx alone; extracted here once CoreTierBalanceHistory.jsx needed the exact
// same data (who's tracked, are they a member) without either duplicating this whole state
// machine a second time or CoreTierPortfolio reaching into a sibling component's internals.
// Deliberately does NOT own any track/untrack UI state (confirm-step, input text, etc.) — that
// stays view-specific in CoreTierPortfolio.jsx, which is still the only place wallets are actually
// added/removed from.
export function useCoreTierAccess(wallet, membershipVersion = 0) {
  const getAuthParams = useWalletAuthSignature(wallet);
  const { getTrackedWallets, addTrackedWallet, removeTrackedWallet } = useTrackedWallets();

  // null = not checked yet (or wallet not connected), true/false once known — reset on every
  // account change so a previous account's answer never leaks into the new one for even one
  // render.
  const [hasAccess, setHasAccess] = useState(null);
  const [accessError, setAccessError] = useState(null);
  // True while re-checking access after a fresh subscribe (see the membershipVersion effect
  // below) — distinct from the plain "Checking Core tier access…" of the very first load, since
  // this one can legitimately take up to ACCESS_RETRY_MAX_ATTEMPTS * ACCESS_RETRY_INTERVAL_MS.
  const [awaitingActivation, setAwaitingActivation] = useState(false);
  const [manualCheckLoading, setManualCheckLoading] = useState(false);
  const prevMembershipVersionRef = useRef(membershipVersion);

  const [active, setActive] = useState([]); // [{ address, addedAt, removableAt }]
  const [cooling, setCooling] = useState([]); // [{ address, removedAt, retrackableAt }]
  const [maxWallets, setMaxWallets] = useState(3);
  const [cooldownDays, setCooldownDays] = useState(30);

  const refresh = useCallback(async () => {
    const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
    const res = await getTrackedWallets(wallet.account, signature, timestamp);
    setActive(res.active || []);
    setCooling(res.cooling || []);
    if (res.maxWallets) setMaxWallets(res.maxWallets);
    if (res.cooldownDays) setCooldownDays(res.cooldownDays);
    return res;
  }, [getAuthParams, getTrackedWallets, wallet.account]);

  // One-shot manual recheck — a "Check again" button, for a member who comes back after the
  // automatic retry (below) already gave up, or who reloaded the page and landed straight on the
  // plain "membership required" state with no retry in flight at all.
  const checkAccessOnce = useCallback(async () => {
    setManualCheckLoading(true);
    setAccessError(null);
    try {
      await refresh();
      setHasAccess(true);
    } catch (err) {
      if (err.message !== "CORE_ACCESS_REQUIRED") {
        console.error("Failed to re-check Core tier access:", err);
        setAccessError(err.message || "Couldn't check Core tier access");
      }
    } finally {
      setManualCheckLoading(false);
    }
  }, [refresh]);

  // Load Core tier access + the tracked-wallet list whenever the connected account changes.
  useEffect(() => {
    if (!wallet.isConnected || !wallet.account) {
      setHasAccess(null);
      setActive([]);
      setCooling([]);
      return;
    }
    let cancelled = false;
    setHasAccess(null);
    setAccessError(null);
    (async () => {
      try {
        await refresh();
        if (!cancelled) setHasAccess(true);
      } catch (err) {
        if (cancelled) return;
        if (err.message === "CORE_ACCESS_REQUIRED") {
          setHasAccess(false);
        } else {
          console.error("Failed to load tracked wallets:", err);
          setAccessError(err.message || "Couldn't check Core tier access");
          setHasAccess(false);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.isConnected, wallet.account]);

  // Re-checks access when MembershipPurchase reports a fresh subscribe (membershipVersion bump)
  // — skipped on the very first render and whenever there's no connected wallet to check. Retries
  // with a delay instead of a single immediate check — see ACCESS_RETRY_* comment above.
  useEffect(() => {
    if (membershipVersion === prevMembershipVersionRef.current) return;
    prevMembershipVersionRef.current = membershipVersion;
    if (!wallet.isConnected || !wallet.account) return;

    let cancelled = false;
    setAwaitingActivation(true);
    setAccessError(null);
    (async () => {
      for (let attempt = 0; attempt < ACCESS_RETRY_MAX_ATTEMPTS; attempt++) {
        try {
          await refresh();
          if (cancelled) return;
          setHasAccess(true);
          return;
        } catch (err) {
          if (cancelled) return;
          if (err.message !== "CORE_ACCESS_REQUIRED") {
            console.error("Failed to re-check Core tier access:", err);
            setAccessError(err.message || "Couldn't check Core tier access");
            setHasAccess(false);
            return;
          }
          if (attempt < ACCESS_RETRY_MAX_ATTEMPTS - 1) await sleep(ACCESS_RETRY_INTERVAL_MS);
        }
      }
      // Gave up — leaves hasAccess false; the "already subscribed? Check again" button covers this.
    })().finally(() => { if (!cancelled) setAwaitingActivation(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membershipVersion]);

  const addWallet = useCallback(async (address) => {
    const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
    const res = await addTrackedWallet(wallet.account, signature, timestamp, address);
    setActive(res.active || []);
    return res;
  }, [getAuthParams, addTrackedWallet, wallet.account]);

  const removeWallet = useCallback(async (address) => {
    const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
    const res = await removeTrackedWallet(wallet.account, signature, timestamp, address);
    setActive(res.active || []);
    return res;
  }, [getAuthParams, removeTrackedWallet, wallet.account]);

  return {
    hasAccess,
    accessError,
    awaitingActivation,
    manualCheckLoading,
    active,
    cooling,
    maxWallets,
    cooldownDays,
    refresh,
    checkAccessOnce,
    addWallet,
    removeWallet,
  };
}
