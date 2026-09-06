import React, { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { Wallet as WalletIcon, Lock, TriangleAlert } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import DashboardButton from "./DashboardButton.jsx";
import { useWalletAuthSignature } from "../../../hooks/useWalletAuthSignature.js";
import { useTrackedWallets } from "../../hooks/useTrackedWallets.js";
import { useCombinedPortfolio } from "../../hooks/useCombinedPortfolio.js";
import { useTokenChart } from "../../hooks/useTokenChart.js";
import { useEtnPrice } from "../../../hooks/useEtnPrice.js";
import { formatTokenAmount, formatUsdPrice, formatEtnBalance, isSpamTokenName, shortHash } from "../../utils/format.js";
import { green, greenGlow, muted, mutedLight, border, panel2, orange, error as errorColor } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";
const NFT_TOKEN_TYPES = new Set(["ERC-721", "ERC-1155"]);
const MAX_PRICED_HOLDINGS = 25; // matches AddressLookup.jsx's own cap — how many fungible tokens
// get a price fetched at all, independent of HOLDINGS_PAGE_SIZE below (how many rows show at
// once); a token beyond this cap can still be shown via "Show more", just without a $ value.
const HOLDING_CATEGORIES = [
  { id: "tokens", label: "Tokens" },
  { id: "nfts", label: "NFT's" },
];
const HOLDINGS_PAGE_SIZE = 10;

function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Same "no known price yet -> omit the $ figure, never fake one" convention as AddressLookup.jsx's
// own tokenUsdValue.
function tokenUsdValue(rawValue, decimals, priceUsd) {
  if (priceUsd == null) return null;
  try {
    const amount = parseFloat(ethers.formatUnits(rawValue, decimals == null ? 18 : Number(decimals)));
    return Number.isFinite(amount) ? amount * priceUsd : null;
  } catch {
    return null;
  }
}

const smallInputStyle = {
  flex: 1,
  padding: "10px 12px",
  borderRadius: 10,
  border: `1px solid ${border}`,
  background: panel2,
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  boxSizing: "border-box",
  outline: "none",
  fontFamily: "monospace",
};

// A standing, always-visible warning (not just something shown mid-action) — the cooldown is a
// real lock, not a soft suggestion, so a member deciding whether to track a wallet at all should
// see this before they ever reach the confirm step below.
function CooldownNotice({ children }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, background: "rgba(255,138,61,0.08)", border: `1px solid ${border}`, marginBottom: 12 }}>
      <TriangleAlert size={14} color={orange} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 11, color: mutedLight, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

// Core tier's flagship feature: track up to MAX_TRACKED_WALLETS wallets (your own, cold storage,
// a friend's — anything; no ownership proof is required of the *tracked* wallets, only of the
// member's own connected one) and see their combined ETN + token balances as one merged
// portfolio. Always mounted regardless of wallet/membership state — same "decide what to show
// internally, don't gate at the call site" pattern as PnlStatementRequest.jsx.
//
// Tracking and untracking each carry a real 30-day cooldown (see trackedWallets.js) specifically
// to stop "untrack A, track B, untrack B, retrack A" from being a free way to see more than
// MAX_TRACKED_WALLETS wallets' data over time. Both actions require an explicit confirm step
// (handlePendingConfirm below) with the consequence spelled out in the confirmation itself, not
// just mentioned once in passing — a member should never be surprised by a 30-day lock they didn't
// see coming.
// Access re-check retry after a fresh subscribe (see the membershipVersion effect below) — the
// backend's own membership record only updates once premiumSubscriptionWatcher.js has polled and
// processed the purchase event (up to its own POLL_INTERVAL_MS, ~a minute by default), so a
// single immediate re-check right after the tx confirms would very often still see "not a member"
// even though the purchase genuinely went through. Retries every 10s for up to 2 minutes — past
// that, something's actually wrong (watcher down, RPC issue) rather than just normal lag, and
// this stops nagging the backend and shows a plain "try refreshing" message instead.
const ACCESS_RETRY_INTERVAL_MS = 10 * 1000;
const ACCESS_RETRY_MAX_ATTEMPTS = 12;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function CoreTierPortfolio({ wallet, membershipVersion = 0 }) {
  const getAuthParams = useWalletAuthSignature(wallet);
  const { getTrackedWallets, addTrackedWallet, removeTrackedWallet } = useTrackedWallets();
  const { getCombinedPortfolio } = useCombinedPortfolio();
  const { getTokenChart } = useTokenChart();
  const etnUsdPrice = useEtnPrice();

  // null = not checked yet (or wallet not connected), true/false once known — reset on every
  // account change so a previous account's answer never leaks into the new one for even one
  // render.
  const [hasAccess, setHasAccess] = useState(null);
  const [accessError, setAccessError] = useState(null);
  // True while re-checking access after a fresh subscribe (see the membershipVersion effect
  // below) — distinct from the plain "Checking Core tier access…" of the very first load, since
  // this one can legitimately take up to ACCESS_RETRY_MAX_ATTEMPTS * ACCESS_RETRY_INTERVAL_MS and
  // deserves its own "hang on, this is expected" message rather than looking stuck.
  const [awaitingActivation, setAwaitingActivation] = useState(false);
  const [manualCheckLoading, setManualCheckLoading] = useState(false);
  const prevMembershipVersionRef = useRef(membershipVersion);

  const [active, setActive] = useState([]); // [{ address, addedAt, removableAt }]
  const [cooling, setCooling] = useState([]); // [{ address, removedAt, retrackableAt }]
  const [maxWallets, setMaxWallets] = useState(3);
  const [cooldownDays, setCooldownDays] = useState(30);
  const [managing, setManaging] = useState(false);

  const [addInput, setAddInput] = useState("");
  const [addInputError, setAddInputError] = useState(null);

  // The one action currently awaiting confirmation — null | { type: "add"|"remove", address }.
  // Nothing is sent to the backend until the member confirms, and the confirm panel itself states
  // the exact consequence (see renderPending below).
  const [pending, setPending] = useState(null);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingError, setPendingError] = useState(null);

  const [portfolio, setPortfolio] = useState(null); // null = loading/nothing to show yet
  const [portfolioError, setPortfolioError] = useState(null);
  const [tokenPrices, setTokenPrices] = useState({}); // lowercased token address -> USD price
  const [holdingsCategory, setHoldingsCategory] = useState("tokens");
  const [holdingsShown, setHoldingsShown] = useState(HOLDINGS_PAGE_SIZE);

  const refreshTrackedWallets = useCallback(async () => {
    const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
    const res = await getTrackedWallets(wallet.account, signature, timestamp);
    setActive(res.active || []);
    setCooling(res.cooling || []);
    if (res.maxWallets) setMaxWallets(res.maxWallets);
    if (res.cooldownDays) setCooldownDays(res.cooldownDays);
    return res;
  }, [getAuthParams, getTrackedWallets, wallet.account]);

  // One-shot manual recheck — the "Already subscribed? Check again" button below, for a member
  // who comes back after the automatic retry (see the membershipVersion effect) already gave up,
  // or who reloaded the page and landed straight on the plain "membership required" message with
  // no retry in flight at all.
  const checkAccessOnce = useCallback(async () => {
    setManualCheckLoading(true);
    setAccessError(null);
    try {
      await refreshTrackedWallets();
      setHasAccess(true);
    } catch (err) {
      if (err.message !== "CORE_ACCESS_REQUIRED") {
        console.error("Failed to re-check Core tier access:", err);
        setAccessError(err.message || "Couldn't check Core tier access");
      }
      // else: still not a member — leave the plain message showing, nothing new to say
    } finally {
      setManualCheckLoading(false);
    }
  }, [refreshTrackedWallets]);

  // Load Core tier access + the tracked-wallet list whenever the connected account changes — also
  // drops any in-progress action, since one built for the previous account has no business
  // surviving a disconnect/account switch.
  useEffect(() => {
    setManaging(false);
    setPending(null);
    setPendingError(null);
    setAddInput("");
    setAddInputError(null);

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
        await refreshTrackedWallets();
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
  // — skipped on the very first render (prevMembershipVersionRef starts equal to the initial
  // value, so there's nothing to react to yet) and whenever there's no connected wallet to check.
  // Retries with a delay instead of a single immediate check: see ACCESS_RETRY_* comment above for
  // why the backend's own membership record can genuinely still say "not a member" for a while
  // after a real, confirmed purchase.
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
          await refreshTrackedWallets();
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
          // Not active yet — this is the expected/common case right after a purchase, not an
          // error, so it's silently retried rather than surfaced.
          if (attempt < ACCESS_RETRY_MAX_ATTEMPTS - 1) await sleep(ACCESS_RETRY_INTERVAL_MS);
        }
      }
      // Gave up — leaves hasAccess false (the plain "membership required" message shows again,
      // with the standing "already subscribed?" hint below covering this exact case) rather than
      // claiming anything went wrong, since nothing necessarily did.
    })().finally(() => { if (!cancelled) setAwaitingActivation(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membershipVersion]);

  // Combined portfolio loads whenever the active tracked-wallet list changes.
  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setPortfolio(null);
      return;
    }
    let cancelled = false;
    setPortfolio(null);
    setPortfolioError(null);
    setTokenPrices({});
    setHoldingsShown(HOLDINGS_PAGE_SIZE);
    getCombinedPortfolio(active.map((w) => w.address))
      .then((res) => { if (!cancelled) setPortfolio(res); })
      .catch((err) => {
        console.error("Failed to load combined portfolio:", err);
        if (!cancelled) setPortfolioError("Couldn't load portfolio data — try again shortly.");
      });
    return () => { cancelled = true; };
  }, [hasAccess, active, getCombinedPortfolio]);

  // USD price per merged token — one small independent request each, same pattern (and the same
  // MAX_PRICED_HOLDINGS cap) as AddressLookup.jsx's own price-fetching effect.
  useEffect(() => {
    if (!portfolio) return;
    const fungible = portfolio.tokens.filter((t) => t.token?.address && !NFT_TOKEN_TYPES.has(t.token?.type));
    if (fungible.length === 0) return;
    let cancelled = false;
    fungible.slice(0, MAX_PRICED_HOLDINGS).forEach((t) => {
      const addr = t.token.address.toLowerCase();
      getTokenChart(t.token.address, "7")
        .then((res) => {
          if (cancelled || !res?.hasData || !res.candles?.length) return;
          setTokenPrices((prev) => ({ ...prev, [addr]: res.candles[res.candles.length - 1].close }));
        })
        .catch((err) => console.error(`Failed to load price for ${addr}:`, err.message));
    });
    return () => { cancelled = true; };
  }, [portfolio, getTokenChart]);

  const requestAdd = (rawAddress) => {
    setAddInputError(null);
    const trimmed = rawAddress.trim();
    if (!trimmed) return;
    if (!ethers.isAddress(trimmed)) {
      setAddInputError("Enter a valid wallet address");
      return;
    }
    if (active.some((w) => w.address.toLowerCase() === trimmed.toLowerCase())) {
      setAddInputError("Already tracking that wallet");
      return;
    }
    if (active.length >= maxWallets) {
      setAddInputError(`You can track up to ${maxWallets} wallets — untrack one first`);
      return;
    }
    const stillCooling = cooling.find((w) => w.address.toLowerCase() === trimmed.toLowerCase());
    setPendingError(null);
    setPending({ type: "add", address: trimmed, blockedUntil: stillCooling ? stillCooling.retrackableAt : null });
  };

  const requestRemove = (address) => {
    setPendingError(null);
    setPending({ type: "remove", address });
  };

  const cancelPending = () => {
    setPending(null);
    setPendingError(null);
  };

  const confirmPending = async () => {
    if (!pending) return;
    setPendingLoading(true);
    setPendingError(null);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      if (pending.type === "add") {
        const res = await addTrackedWallet(wallet.account, signature, timestamp, pending.address);
        setActive(res.active || []);
        setAddInput("");
      } else {
        const res = await removeTrackedWallet(wallet.account, signature, timestamp, pending.address);
        setActive(res.active || []);
      }
      await refreshTrackedWallets().catch(() => {}); // also refreshes `cooling` — non-fatal if it fails
      setPending(null);
    } catch (err) {
      console.error(`Failed to ${pending.type} wallet:`, err);
      setPendingError(err.message || "That didn't go through — try again.");
    } finally {
      setPendingLoading(false);
    }
  };

  // Ordered by USD value, descending — raw on-chain amounts aren't comparable across tokens with
  // different decimals, so sorting by those (the previous behavior) was effectively meaningless.
  // usdValue is attached here once and reused at render time rather than recomputed. A token with
  // no resolved price yet (tokenPrices hasn't caught up — see that effect above, prices trickle in
  // one request per token) sinks to the bottom instead of counting as $0, so it doesn't briefly
  // occupy a top slot before its real price arrives.
  // Split by category (fungible tokens vs NFTs — same NFT_TOKEN_TYPES membership check the price-
  // fetching effect above uses to skip NFTs, since Blockscout's own `type` field is the only
  // signal available), same convention as AddressLookup.jsx's own Tokens/NFT's toggle. Only the
  // fungible list is meaningfully sortable by USD value — NFTs never get a price (no ElectroSwap
  // trading pair), so they stay in whatever order useCombinedPortfolio.js's merge produced them.
  const visibleTokens = portfolio
    ? portfolio.tokens
        .filter((t) => !isSpamTokenName(t.token?.name) && !NFT_TOKEN_TYPES.has(t.token?.type))
        .map((t) => ({ ...t, usdValue: tokenUsdValue(t.value, t.token?.decimals, tokenPrices[t.token?.address?.toLowerCase()]) }))
        .sort((a, b) => {
          if (a.usdValue == null && b.usdValue == null) return 0;
          if (a.usdValue == null) return 1;
          if (b.usdValue == null) return -1;
          return b.usdValue - a.usdValue;
        })
    : [];
  const visibleNfts = portfolio
    ? portfolio.tokens.filter((t) => !isSpamTokenName(t.token?.name) && NFT_TOKEN_TYPES.has(t.token?.type))
    : [];
  const visibleHoldings = holdingsCategory === "nfts" ? visibleNfts : visibleTokens;

  const combinedEtnAmount = portfolio ? parseFloat(ethers.formatEther(portfolio.totalCoinBalance)) : null;
  const combinedUsdValue =
    etnUsdPrice != null && combinedEtnAmount != null && Number.isFinite(combinedEtnAmount)
      ? combinedEtnAmount * etnUsdPrice
      : null;

  const renderPending = () => {
    if (!pending) return null;
    const isAdd = pending.type === "add";
    return (
      <div style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${isAdd ? orange : errorColor}`, background: isAdd ? "rgba(255,138,61,0.08)" : "rgba(255,107,107,0.08)", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 10 }}>
          <TriangleAlert size={15} color={isAdd ? orange : errorColor} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 12, color: "#fff", lineHeight: 1.6 }}>
            {isAdd ? (
              pending.blockedUntil ? (
                <>You untracked <b>{shortHash(pending.address, 8)}</b> too recently — it can't be re-tracked until <b>{fmtDate(pending.blockedUntil)}</b>.</>
              ) : (
                <>Track <b>{shortHash(pending.address, 8)}</b>? Once added, it's locked in — you won't be able to untrack it for <b>{cooldownDays} days</b>.</>
              )
            ) : (
              <>Untrack <b>{shortHash(pending.address, 8)}</b>? You won't be able to re-track this exact wallet for <b>{cooldownDays} days</b> afterward.</>
            )}
          </div>
        </div>
        {pendingError && <div style={{ fontSize: 11, color: errorColor, marginBottom: 10 }}>{pendingError}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          {!(isAdd && pending.blockedUntil) && (
            <DashboardButton onClick={confirmPending} disabled={pendingLoading} loading={pendingLoading} style={{ flex: 1, justifyContent: "center", padding: "8px 12px", fontSize: 12 }}>
              {isAdd ? "Confirm Track" : "Confirm Untrack"}
            </DashboardButton>
          )}
          <button
            type="button"
            onClick={cancelPending}
            disabled={pendingLoading}
            style={{ flex: 1, padding: "8px 12px", borderRadius: 10, border: `1px solid ${border}`, background: panel2, color: mutedLight, fontSize: 12, fontWeight: 700, cursor: pendingLoading ? "not-allowed" : "pointer" }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  };

  return (
    <DashboardPanel>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <WalletIcon size={18} color={green} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Core Tier — Portfolio
        </div>
      </div>

      {!wallet.isConnected ? (
        <div>
          <div style={{ fontSize: 12, color: mutedLight, marginBottom: 12 }}>
            Connect your wallet to track up to {maxWallets} wallets and see their combined ETN + token balances in one view.
          </div>
          <DashboardButton onClick={wallet.connectWallet} style={{ width: "100%", justifyContent: "center" }}>
            Connect Wallet
          </DashboardButton>
        </div>
      ) : hasAccess === null ? (
        <div style={{ fontSize: 12, color: mutedLight }}>Checking Core tier access…</div>
      ) : accessError ? (
        <div style={{ fontSize: 12, color: errorColor }}>{accessError}</div>
      ) : hasAccess === false && awaitingActivation ? (
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <Lock size={16} color={green} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 12, color: mutedLight, lineHeight: 1.6 }}>
            Confirming your subscription — this can take up to a couple of minutes while it's
            picked up on our end. This will update on its own once it's through.
          </div>
        </div>
      ) : hasAccess === false ? (
        <div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
            <Lock size={16} color={muted} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 12, color: mutedLight, lineHeight: 1.6 }}>
              Core tier membership required — track up to {maxWallets} wallets and see their
              combined portfolio in one view. Subscribe (monthly or annual — either works) below to
              unlock it.
            </div>
          </div>
          <div style={{ marginLeft: 26 }}>
            <div style={{ fontSize: 11, color: muted, marginBottom: 6 }}>
              Already subscribed? It can take a minute or two to activate after purchase.
            </div>
            <button
              type="button"
              onClick={checkAccessOnce}
              disabled={manualCheckLoading}
              style={{
                background: "none",
                border: `1px solid ${border}`,
                borderRadius: 8,
                padding: "5px 10px",
                color: manualCheckLoading ? muted : green,
                fontSize: 11,
                fontWeight: 700,
                cursor: manualCheckLoading ? "not-allowed" : "pointer",
              }}
            >
              {manualCheckLoading ? "Checking…" : "Check again"}
            </button>
          </div>
        </div>
      ) : (
        <div>
          {!managing ? (
            <>
              {active.length === 0 ? (
                <div style={{ fontSize: 12, color: mutedLight, marginBottom: 14 }}>
                  No wallets tracked yet — add up to {maxWallets} to see your combined portfolio.
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
                  {active.map((w) => (
                    <div
                      key={w.address}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: `1px solid ${border}`,
                        background: panel2,
                        color: mutedLight,
                        fontSize: 11,
                        fontFamily: "monospace",
                      }}
                    >
                      {w.address.toLowerCase() === wallet.account?.toLowerCase() ? "You — " : ""}
                      {shortHash(w.address)}
                    </div>
                  ))}
                </div>
              )}
              <DashboardButton onClick={() => setManaging(true)} style={{ width: "100%", justifyContent: "center" }}>
                {active.length === 0 ? "Add Wallets" : "Manage Tracked Wallets"}
              </DashboardButton>
            </>
          ) : (
            <div>
              <CooldownNotice>
                Tracking a wallet locks it in for {cooldownDays} days before you can untrack it.
                Untracking a wallet then locks that same address out from being re-tracked for
                another {cooldownDays} days. Any address works — your own, cold storage, or
                anyone else's you want to watch; you only ever prove ownership of your own
                connected wallet, never of the ones you track.
              </CooldownNotice>

              {renderPending()}

              {active.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                  {active.map((w) => {
                    const locked = new Date(w.removableAt).getTime() > Date.now();
                    return (
                      <div
                        key={w.address}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "8px 10px",
                          borderRadius: 8,
                          border: `1px solid ${border}`,
                          background: panel2,
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 12, fontFamily: "monospace", color: "#fff" }}>
                            {w.address.toLowerCase() === wallet.account?.toLowerCase() ? "You — " : ""}
                            {shortHash(w.address, 8)}
                          </div>
                          <div style={{ fontSize: 10, color: locked ? orange : mutedLight, marginTop: 2 }}>
                            {locked ? `Locked until ${fmtDate(w.removableAt)}` : "Eligible to untrack"}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => requestRemove(w.address)}
                          disabled={locked}
                          style={{
                            background: "none",
                            border: `1px solid ${locked ? border : errorColor}`,
                            borderRadius: 8,
                            padding: "5px 10px",
                            color: locked ? muted : errorColor,
                            fontSize: 11,
                            fontWeight: 700,
                            cursor: locked ? "not-allowed" : "pointer",
                          }}
                        >
                          Untrack
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {cooling.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 6 }}>
                    Recently Untracked
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {cooling.map((w) => (
                      <div key={w.address} style={{ fontSize: 10, color: muted, fontFamily: "monospace" }}>
                        {shortHash(w.address, 8)} — re-trackable {fmtDate(w.retrackableAt)}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {active.length < maxWallets && (
                <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                  <input
                    type="text"
                    placeholder="0x... wallet address"
                    value={addInput}
                    onChange={(e) => setAddInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") requestAdd(addInput); }}
                    style={smallInputStyle}
                  />
                  <button
                    type="button"
                    onClick={() => requestAdd(addInput)}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 10,
                      border: `1px solid ${green}`,
                      background: "rgba(24,187,26,0.12)",
                      color: green,
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    Track
                  </button>
                </div>
              )}
              {addInputError && <div style={{ fontSize: 11, color: errorColor, marginBottom: 8 }}>{addInputError}</div>}

              {active.length < maxWallets &&
                !active.some((w) => w.address.toLowerCase() === wallet.account?.toLowerCase()) && (
                <button
                  type="button"
                  onClick={() => requestAdd(wallet.account)}
                  style={{
                    display: "block",
                    background: "none",
                    border: "none",
                    color: green,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: "pointer",
                    padding: "2px 0 10px",
                  }}
                >
                  + Track my connected wallet
                </button>
              )}

              <button
                type="button"
                onClick={() => setManaging(false)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "center",
                  fontSize: 12,
                  color: mutedLight,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "8px 0 0",
                  textDecoration: "underline",
                }}
              >
                Done
              </button>
            </div>
          )}

          {!managing && active.length > 0 && (
            <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${border}` }}>
              {portfolioError ? (
                <div style={{ fontSize: 12, color: errorColor }}>{portfolioError}</div>
              ) : !portfolio ? (
                <div style={{ fontSize: 12, color: mutedLight }}>Loading combined portfolio…</div>
              ) : (
                <>
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 8 }}>
                      Combined ETN Balance
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 22, fontWeight: 900, color: "#fff", textShadow: `0 0 10px ${greenGlow}` }}>
                        {formatEtnBalance(portfolio.totalCoinBalance)} ETN
                      </div>
                      {combinedUsdValue != null && (
                        <div style={{ fontSize: 13, color: mutedLight, fontWeight: 600 }}>{formatUsdPrice(combinedUsdValue)}</div>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: mutedLight, marginTop: 4 }}>
                      Across {active.length} tracked wallet{active.length === 1 ? "" : "s"}
                    </div>
                  </div>

                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
                    Combined Holdings
                  </div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                    {HOLDING_CATEGORIES.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => { setHoldingsCategory(c.id); setHoldingsShown(HOLDINGS_PAGE_SIZE); }}
                        style={{
                          flex: "1 1 100px",
                          padding: "8px 8px",
                          borderRadius: 10,
                          border: `1px solid ${c.id === holdingsCategory ? green : border}`,
                          background: c.id === holdingsCategory ? "rgba(24,187,26,0.12)" : panel2,
                          color: c.id === holdingsCategory ? green : mutedLight,
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                  {visibleHoldings.length === 0 ? (
                    <div style={{ fontSize: 12, color: muted }}>
                      {holdingsCategory === "nfts" ? "No NFTs held across your tracked wallets." : "No token balances across your tracked wallets."}
                    </div>
                  ) : (
                    <>
                      {visibleHoldings.slice(0, holdingsShown).map((t, i) => {
                        const usdValue = t.usdValue ?? null;
                        return (
                          <div
                            key={`${t.token?.address}-${i}`}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              padding: "8px 0",
                              borderBottom: `1px solid ${border}`,
                            }}
                          >
                            <span style={{ fontSize: 12, color: "#fff" }}>
                              {t.token?.name || "Unknown"} <span style={{ color: mutedLight }}>{t.token?.symbol}</span>
                              {t.heldBy.length > 1 && (
                                <span style={{ display: "block", fontSize: 10, color: muted }}>
                                  Held in {t.heldBy.length} of {active.length} wallets
                                </span>
                              )}
                            </span>
                            <span style={{ textAlign: "right" }}>
                              <span style={{ fontSize: 12, color: green, fontWeight: 700 }}>{formatTokenAmount(t.value, t.token?.decimals)}</span>
                              {usdValue != null && (
                                <span style={{ display: "block", fontSize: 11, color: mutedLight }}>{formatUsdPrice(usdValue)}</span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                      {visibleHoldings.length > holdingsShown && (
                        <button
                          type="button"
                          onClick={() => setHoldingsShown((n) => n + HOLDINGS_PAGE_SIZE)}
                          style={{
                            display: "block",
                            width: "100%",
                            marginTop: 10,
                            padding: "8px 0",
                            borderRadius: 8,
                            border: `1px solid ${border}`,
                            background: panel2,
                            color: green,
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: "pointer",
                          }}
                        >
                          Show more ({visibleHoldings.length - holdingsShown} more)
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </DashboardPanel>
  );
}
