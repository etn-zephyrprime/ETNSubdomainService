import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { Wallet as WalletIcon, TriangleAlert } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import DashboardButton from "./DashboardButton.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import { useCoreTierAccess } from "../../hooks/useCoreTierAccess.js";
import { useCombinedPortfolio } from "../../hooks/useCombinedPortfolio.js";
import { useTokenChart } from "../../hooks/useTokenChart.js";
import { useEtnPrice } from "../../../hooks/useEtnPrice.js";
import { formatTokenAmount, formatUsdPrice, formatEtnBalance, isSpamTokenName, shortHash } from "../../utils/format.js";
import { readCachedTokenPrices, cacheTokenPrice } from "../../utils/tokenPriceCache.js";
import { green, greenGlow, muted, mutedLight, border, panel2, orange, error as errorColor } from "../../theme.js";

const NFT_TOKEN_TYPES = new Set(["ERC-721", "ERC-1155"]);
// How many fungible tokens get a price fetched at all, independent of HOLDINGS_PAGE_SIZE below
// (how many rows show at once) — matches AddressLookup.jsx's own cap. This is NOT just a render
// limit: a token beyond this cap never gets priced, full stop, so it necessarily sinks to the
// bottom of the USD-sorted list regardless of its real value (confirmed live: a wallet holding
// 30k of a token with a genuine ~$1,335 CLUB/WETN pool showed no $ value and sorted last, purely
// because it fell past position 25 in Blockscout's own — unordered — token-balances response, not
// because it was actually worth less than everything above it). Raised from 25 to 50: comfortably
// covers realistic portfolios while bounding worst-case impact on the shared GeckoTerminal queue
// (tokenChartRouter.js) every visitor's price charts also depend on — that queue enforces ~1.5s
// between new-token lookups site-wide, so a wallet that maxes this cap can add up to ~75s of
// queued lookups ahead of everyone else's, not just its own.
const MAX_PRICED_HOLDINGS = 50;
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
export default function CoreTierPortfolio({ wallet, membershipVersion = 0, getAuthParams }) {
  // Access + tracked-wallet-list state/effects live in useCoreTierAccess.js — shared with
  // CoreTierBalanceHistory.jsx, which needs the exact same "is this member allowed, and which
  // wallets do they track" data without either duplicating this state machine a second time or
  // reaching into this component's internals. `getAuthParams` comes from
  // PortfolioDashboardSection.jsx's single shared signature — see that hook's own comment on why.
  const {
    hasAccess, accessError, awaitingActivation, manualCheckLoading,
    active, cooling, maxWallets, cooldownDays,
    refresh, checkAccessOnce, addWallet, removeWallet,
  } = useCoreTierAccess(wallet, membershipVersion, getAuthParams);
  const { getCombinedPortfolio } = useCombinedPortfolio();
  const { getTokenChart } = useTokenChart();
  const etnUsdPrice = useEtnPrice();

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

  // Drops any in-progress editor state on an account change — one built for the previous account
  // has no business surviving a disconnect/switch. The access/tracked-wallet state itself resets
  // inside useCoreTierAccess.
  useEffect(() => {
    setManaging(false);
    setPending(null);
    setPendingError(null);
    setAddInput("");
    setAddInputError(null);
  }, [wallet.isConnected, wallet.account]);

  // Combined portfolio loads whenever the active tracked-wallet list changes.
  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setPortfolio(null);
      return;
    }
    let cancelled = false;
    setPortfolio(null);
    setPortfolioError(null);
    // Seed from the last-known-price cache (tokenPriceCache.js) instead of a blank slate — a
    // reload/reconnect otherwise had to wait out the same rate-limited per-token trickle below all
    // over again for prices it already knew moments earlier. The effect below still fetches fresh
    // values for every held token regardless, overwriting these as they arrive — this only makes
    // the FIRST paint show real numbers instead of "still pricing...".
    setTokenPrices(readCachedTokenPrices());
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
  // MAX_PRICED_HOLDINGS cap) as AddressLookup.jsx's own price-fetching effect. Spam-named tokens
  // are excluded before the cap is applied (not just from the rendered list later) so a wallet
  // full of airdropped junk can't burn through the priced-token budget before it ever reaches a
  // real holding.
  useEffect(() => {
    if (!portfolio) return;
    const fungible = portfolio.tokens.filter(
      (t) => t.token?.address && !NFT_TOKEN_TYPES.has(t.token?.type) && !isSpamTokenName(t.token?.name)
    );
    if (fungible.length === 0) return;
    let cancelled = false;
    fungible.slice(0, MAX_PRICED_HOLDINGS).forEach((t) => {
      const addr = t.token.address.toLowerCase();
      getTokenChart(t.token.address, "7")
        .then((res) => {
          if (cancelled || !res?.hasData || !res.candles?.length) return;
          const price = res.candles[res.candles.length - 1].close;
          setTokenPrices((prev) => ({ ...prev, [addr]: price }));
          cacheTokenPrice(addr, price); // so the NEXT reload/reconnect can show this immediately too
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
      if (pending.type === "add") {
        await addWallet(pending.address);
        setAddInput("");
      } else {
        await removeWallet(pending.address);
      }
      await refresh().catch(() => {}); // also refreshes `cooling` — non-fatal if it fails
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

  // Per-wallet total USD value (ETN + every priced fungible token holding) — uses each wallet's
  // own UNMERGED balances (portfolio.perWallet), not the merged/combined token list above, since a
  // real per-wallet breakdown needs what THAT wallet specifically holds, not a cross-wallet sum.
  // A wallet holding ETN with no known price yet, or any fungible token whose price hasn't
  // resolved (still trickling in, or beyond MAX_PRICED_HOLDINGS — see that constant's own
  // comment), makes its own figure — and the grand total's — a lower bound, not an exact number:
  // flagged with "≈" rather than silently understating as if it were precise.
  const perWalletTotals = portfolio
    ? portfolio.perWallet.map((w) => {
        const etnAmount = w.info?.coin_balance != null ? parseFloat(ethers.formatEther(w.info.coin_balance)) : 0;
        const etnUsd = etnUsdPrice != null ? etnAmount * etnUsdPrice : null;
        let tokensUsd = 0;
        let hasUnpriced = etnUsd == null && etnAmount > 0;
        for (const tb of w.balances) {
          if (NFT_TOKEN_TYPES.has(tb.token?.type) || isSpamTokenName(tb.token?.name)) continue;
          const usd = tokenUsdValue(tb.value, tb.token?.decimals, tokenPrices[tb.token?.address?.toLowerCase()]);
          if (usd != null) {
            tokensUsd += usd;
          } else if (BigInt(tb.value || 0) > 0n) {
            hasUnpriced = true;
          }
        }
        return { address: w.address, total: (etnUsd || 0) + tokensUsd, hasUnpriced };
      })
    : [];
  const totalPortfolioUsd = perWalletTotals.length > 0 ? perWalletTotals.reduce((sum, w) => sum + w.total, 0) : null;
  const totalPortfolioHasUnpriced = perWalletTotals.some((w) => w.hasUnpriced);

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

      <CoreTierGate
        wallet={wallet}
        hasAccess={hasAccess}
        accessError={accessError}
        awaitingActivation={awaitingActivation}
        manualCheckLoading={manualCheckLoading}
        checkAccessOnce={checkAccessOnce}
        featureDescription={`track up to ${maxWallets} wallets and see their combined ETN + token balances in one view`}
      >
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
                  <div style={{ marginBottom: 20, paddingBottom: 20, borderBottom: `1px solid ${border}` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 8 }}>
                      Total Portfolio Balance (USD)
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 900, color: "#fff", textShadow: `0 0 10px ${greenGlow}` }}>
                      {totalPortfolioUsd != null ? `${totalPortfolioHasUnpriced ? "≈ " : ""}${formatUsdPrice(totalPortfolioUsd)}` : "—"}
                    </div>
                    {totalPortfolioHasUnpriced && (
                      <div style={{ fontSize: 10, color: muted, marginTop: 2 }}>
                        Lower bound — some holdings' prices haven't resolved yet
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: mutedLight, marginTop: 4 }}>
                      ETN + all priced token holdings, across {active.length} tracked wallet{active.length === 1 ? "" : "s"}
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 12 }}>
                      {perWalletTotals.map((w) => (
                        <div key={w.address} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                          <span style={{ color: mutedLight, fontFamily: "monospace" }}>
                            {w.address.toLowerCase() === wallet.account?.toLowerCase() ? "You — " : ""}
                            {shortHash(w.address, 8)}
                          </span>
                          <span style={{ color: "#fff", fontWeight: 700 }}>
                            {w.hasUnpriced ? "≈ " : ""}{formatUsdPrice(w.total)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

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
      </CoreTierGate>
    </DashboardPanel>
  );
}
