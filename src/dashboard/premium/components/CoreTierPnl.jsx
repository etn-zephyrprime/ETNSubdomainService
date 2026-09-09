import React, { useCallback, useEffect, useState } from "react";
import { TrendingUp, RefreshCw, Info } from "lucide-react";
import CollapsibleCoreTierPanel from "./CollapsibleCoreTierPanel.jsx";
import DashboardButton from "./DashboardButton.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import SparklineChart from "../../components/SparklineChart.jsx";
import { usePnlSnapshot } from "../../hooks/usePnlSnapshot.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { useTokenNames } from "../../hooks/useTokenNames.js";
import { formatUsdPrice, formatChartDate } from "../../utils/format.js";
import { green, muted, mutedLight, error as errorColor, border, panel2 } from "../../theme.js";
import InfoTooltip from "../../components/InfoTooltip.jsx";

const AUTH_PURPOSE = "Premium Dashboard";
// Matches categoryPnlService.js's own CATEGORIES export (kept as a plain literal here rather than
// importing across the frontend/backend boundary, same as every other hand-synced constant in
// this app — see e.g. coreTierDemoRouter.js's own comment on why).
const CATEGORY_OPTIONS = [
  { key: "liquidity", label: "Liquidity Positions" },
  { key: "farm_staking", label: "Staking / Yield Farms" },
];
const sectionHeaderStyle = { fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 };

function pnlColor(v) {
  return v > 0 ? green : v < 0 ? errorColor : mutedLight;
}
function fmtSigned(v) {
  return `${v >= 0 ? "+" : ""}${formatUsdPrice(v)}`;
}

// Sub-toggle shown only in "PnL" chart mode (not "Value") — "Combined" (realized + unrealized
// together, the default) is exactly what this chart always plotted before this existed, so a
// member who never touches these buttons sees no change at all. Shared by both the whole-
// portfolio chart and the per-category chart below it.
export const PNL_SUB_MODES = [
  { key: "combined", label: "Combined" },
  { key: "realized", label: "Realized" },
  { key: "unrealized", label: "Unrealized" },
];
export function pnlOverTimeValue(p, pnlSubMode) {
  if (pnlSubMode === "realized") return Number(p.realizedPnlUsd);
  if (pnlSubMode === "unrealized") return Number(p.unrealizedPnlUsd);
  return Number(p.realizedPnlUsd) + Number(p.unrealizedPnlUsd);
}

/** The PnL/Value toggle buttons — one of two (otherwise identical) right-side header controls
 * shared by the whole-portfolio chart and the per-category chart below it. */
export function PnlValueToggle({ chartMode, setChartMode }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {[{ key: "pnl", label: "PnL" }, { key: "value", label: "Value" }].map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => setChartMode(opt.key)}
          style={{
            padding: "4px 10px",
            borderRadius: 8,
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
            border: `1px solid ${chartMode === opt.key ? green : border}`,
            background: chartMode === opt.key ? "rgba(24,187,26,0.12)" : "transparent",
            color: chartMode === opt.key ? green : mutedLight,
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Combined/Realized/Unrealized sub-toggle, rendered as its own full-width row BELOW the header
 * (not inside PnlValueToggle's own flex row — a fragment there would just become a third sibling
 * of the header's flex-wrap layout instead of reliably sitting on its own line). Callers only
 * render this while chartMode === "pnl" — it has no meaning in "Value" mode. */
export function PnlSubModeToggle({ pnlSubMode, setPnlSubMode }) {
  return (
    <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
      {PNL_SUB_MODES.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => setPnlSubMode(opt.key)}
          style={{
            padding: "3px 9px",
            borderRadius: 6,
            fontSize: 10,
            fontWeight: 700,
            cursor: "pointer",
            border: `1px solid ${pnlSubMode === opt.key ? green : border}`,
            background: pnlSubMode === opt.key ? "rgba(24,187,26,0.1)" : "transparent",
            color: pnlSubMode === opt.key ? green : muted,
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// Narrows a snapshot-shaped object (combined, or one entry of snapshot.perWallet — both have the
// same holdings/realizedByToken/currentValueUsd/unrealizedPnlUsd/realizedPnlUsd shape) down to one
// token's own figures. currentValueUsd/unrealizedPnlUsd come back null for a token that's held but
// unpriced (marketValueUsd null — same "omit rather than fake" convention the holdings list itself
// already uses), NOT for a token with zero exposure — a caller filtering the token list to wallets
// that actually hold it should never hit that case. realizedPnlUsd defaults to "0" (a real, known
// zero) for a held token that's simply never been sold, distinct from "unpriced" — realized P&L
// doesn't depend on a live price the way current/unrealized do.
function pickTokenFigures(snap, tokenFilter) {
  if (!snap) return null;
  if (tokenFilter === "all") {
    return { currentValueUsd: snap.currentValueUsd, unrealizedPnlUsd: snap.unrealizedPnlUsd, realizedPnlUsd: snap.realizedPnlUsd };
  }
  const holding = snap.holdings?.find((h) => h.tokenAddress === tokenFilter);
  const currentValueUsd = holding?.marketValueUsd ?? null;
  const unrealizedPnlUsd = holding?.marketValueUsd != null ? String(Number(holding.marketValueUsd) - Number(holding.costBasisUsd)) : null;
  const realizedPnlUsd = snap.realizedByToken?.find((r) => r.tokenAddress === tokenFilter)?.realizedPnlUsd ?? "0";
  return { currentValueUsd, unrealizedPnlUsd, realizedPnlUsd };
}

const selectStyle = {
  padding: "8px 12px",
  borderRadius: 10,
  border: `1px solid ${border}`,
  background: panel2,
  color: "#fff",
  fontSize: 12,
  fontWeight: 600,
  outline: "none",
};

// Core tier's ongoing dashboard PnL — a live, lightweight "how am I doing right now" view, built
// on the EXACT SAME FIFO ledger the PnL Statement product uses (pnlSnapshotService.js reuses
// pnlEventBuilder.js/fifoLotEngine.js verbatim, not a second implementation) so this can never
// disagree with a Statement for the same wallet/token/timestamp.
//
// Deliberately narrower than the Statement — see the build brief's own "must not compete with"
// framing: no CEX inclusion, no fixed reporting periods, no immutable/exportable artifact, no
// per-disposal ledger. This is a running total and current snapshot only, always recomputed live
// (never frozen), with an explicit upsell to the Statement for anything more formal.
//
// The live figures are a real computation (same order of magnitude as generating a Statement, not
// a quick read) — fetched once on load, then only again if the member explicitly asks via
// Refresh, not on a timer. The chart below reads a cheap pre-computed daily rollup instead
// (pnlSnapshotScheduler.js), so it loads fast even though the "right now" numbers above it don't.
export default function CoreTierPnl({ wallet, getAuthParams, onSelectToken, coreTierAccess, walletFilter }) {
  // Access + tracked-wallet-list state and the page-wide wallet filter both live in
  // PortfolioDashboardSection.jsx now — see that file's own comment on why (one shared fetch for
  // all four Core Tier panels, and a filter the panels couldn't otherwise agree on).
  const { hasAccess, accessError, awaitingActivation, manualCheckLoading, active, checkAccessOnce } = coreTierAccess;
  const { getLiveSnapshot, getHistory, getCategoryHistory } = usePnlSnapshot();
  const { resolve: resolveWalletName } = useDisplayNames(active.map((w) => w.address));

  const [snapshot, setSnapshot] = useState(null); // { perWallet, combined } | null
  const [snapshotError, setSnapshotError] = useState(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [history, setHistory] = useState(null); // { combined: [{date,...}] } | null
  const [historyError, setHistoryError] = useState(null);
  // "Liquidity Positions" / "Staking & Yield Farms" PnL-over-time chart — a separate fetch per
  // category (unlike the whole-portfolio chart above, which fetches every wallet's history in one
  // call and only re-derives the wallet-filtered view client-side): each category is its own
  // backend query, so switching the dropdown below needs a fresh request, not just a re-derive.
  const [selectedCategory, setSelectedCategory] = useState(CATEGORY_OPTIONS[0].key);
  const [categoryHistory, setCategoryHistory] = useState(null);
  const [categoryHistoryError, setCategoryHistoryError] = useState(null);
  const [categoryChartMode, setCategoryChartMode] = useState("pnl");
  // "combined" (realized + unrealized together — what this chart always showed before this
  // existed) | "realized" | "unrealized" — see PNL_SUB_MODES' own comment.
  const [categoryPnlSubMode, setCategoryPnlSubMode] = useState("combined");

  const { resolve: resolveTokenName, isSpam: isSpamToken } = useTokenNames((snapshot?.combined?.holdings || []).map((h) => h.tokenAddress));
  const [showHiddenTokens, setShowHiddenTokens] = useState(false);

  // Cold-start token picker — one entry per wallet snapshot.needsSelection names, address ->
  // Set(tokenAddress). Defaults to every available token pre-selected the first time a wallet's
  // picker appears (see the build brief: "select them all" is the trivial fallback), so hitting
  // Continue with no changes just gets full pricing, same as not using this feature at all.
  const [pickerSelections, setPickerSelections] = useState({});

  const loadSnapshot = useCallback(
    async (priorityTokens) => {
      setSnapshotLoading(true);
      setSnapshotError(null);
      try {
        const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
        const res = await getLiveSnapshot(wallet.account, signature, timestamp, priorityTokens);
        setSnapshot(res);
        // Seed the picker for any wallet that newly needs one — existing selections for a wallet
        // already being configured are left alone, not reset, so a partial in-progress picker
        // (e.g. one wallet already confirmed, another still needsSelection) doesn't lose its state.
        setPickerSelections((prev) => {
          const next = { ...prev };
          for (const { walletAddress, availableTokens } of res.needsSelection || []) {
            if (!next[walletAddress]) next[walletAddress] = new Set(availableTokens.map((t) => t.address));
          }
          return next;
        });
      } catch (err) {
        setSnapshotError(err.message || "Couldn't compute your live PnL");
      } finally {
        setSnapshotLoading(false);
      }
    },
    [getAuthParams, getLiveSnapshot, wallet.account]
  );

  const toggleTokenSelection = (walletAddress, tokenAddress) => {
    setPickerSelections((prev) => {
      const set = new Set(prev[walletAddress]);
      if (set.has(tokenAddress)) set.delete(tokenAddress);
      else set.add(tokenAddress);
      return { ...prev, [walletAddress]: set };
    });
  };

  const submitSelections = () => {
    const priorityTokens = {};
    for (const { walletAddress } of snapshot?.needsSelection || []) {
      priorityTokens[walletAddress] = [...(pickerSelections[walletAddress] || [])];
    }
    loadSnapshot(priorityTokens);
  };

  const loadHistory = useCallback(async () => {
    setHistoryError(null);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const res = await getHistory(wallet.account, signature, timestamp);
      setHistory(res);
    } catch (err) {
      setHistoryError(err.message || "Couldn't load PnL history");
    }
  }, [getAuthParams, getHistory, wallet.account]);

  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setSnapshot(null);
      setHistory(null);
      return;
    }
    loadSnapshot();
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, active]);

  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setCategoryHistory(null);
      return;
    }
    let cancelled = false;
    setCategoryHistory(null);
    setCategoryHistoryError(null);
    (async () => {
      try {
        const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
        const res = await getCategoryHistory(wallet.account, signature, timestamp, selectedCategory);
        if (!cancelled) setCategoryHistory(res);
      } catch (err) {
        if (!cancelled) setCategoryHistoryError(err.message || "Couldn't load category PnL history");
      }
    })();
    return () => { cancelled = true; };
  }, [hasAccess, active, getAuthParams, getCategoryHistory, wallet.account, selectedCategory]);

  // A per-wallet snapshot entry has the exact same shape as the combined one (perWallet.push in
  // pnlSnapshotRouter.js spreads the full snapshot alongside walletAddress) — same for a
  // per-wallet history entry vs. the combined series — so picking one or the other here is a
  // drop-in swap, nothing downstream needs to know which it's looking at.
  const combined = walletFilter === "all" ? snapshot?.combined : snapshot?.perWallet?.find((w) => w.walletAddress === walletFilter);
  const combinedHistory =
    walletFilter === "all" ? history?.combined || [] : history?.perWallet?.find((w) => w.walletAddress === walletFilter)?.points || [];
  const combinedCategoryHistory =
    walletFilter === "all"
      ? categoryHistory?.combined || []
      : categoryHistory?.perWallet?.find((w) => w.walletAddress === walletFilter)?.points || [];
  // True only when the filtered wallet's PnL failed to compute this round (see snapshot.failed
  // below) — distinct from `!combined`, which is also true before the very first load completes.
  const filteredWalletFailed = walletFilter !== "all" && (snapshot?.failed || []).includes(walletFilter);
  const formatValue = (v) => formatUsdPrice(v);

  // Token filter — local to this panel only, unlike walletFilter (shared across all four Core Tier
  // panels in PortfolioDashboardSection.jsx): a token list only makes sense once you're already
  // looking at PnL specifically, and a per-token breakdown for Portfolio/Balance History/Alerts is
  // a different feature each of those would need to opt into on its own. Self-healing the same way
  // PortfolioDashboardSection.jsx validates walletFilter: if the previously-selected token vanishes
  // from the current (possibly wallet-filtered) holdings — switching wallet filter, a refresh, a
  // fully-disposed position — this quietly falls back to "all" instead of showing a blank filtered
  // view for a token that's no longer in scope.
  const [tokenFilterRaw, setTokenFilter] = useState("all");
  const tokenFilter =
    tokenFilterRaw === "all" || (combined?.holdings || []).some((h) => h.tokenAddress === tokenFilterRaw) ? tokenFilterRaw : "all";
  const tokenOptions = (combined?.holdings || [])
    .filter((h) => !isSpamToken(h.tokenAddress))
    .slice()
    .sort((a, b) => (Number(b.marketValueUsd) || 0) - (Number(a.marketValueUsd) || 0));
  const figures = pickTokenFigures(combined, tokenFilter);

  // Value Over Time chart mode — "pnl" (realized + unrealized, net) or "value" (raw portfolio
  // value). Defaults to pnl: profit/loss over time is what most people actually want from this
  // chart; the underlying pnl_snapshots row already carries both figures per day (see
  // pnlSnapshotRouter.js's own comment on getHistory's response shape), so this is purely which
  // field(s) get plotted, not a different data source.
  const [chartMode, setChartMode] = useState("pnl");
  // "combined" (realized + unrealized together — what this chart always showed before this
  // existed, so a member who never touches these buttons sees no change) | "realized" |
  // "unrealized" — see PNL_SUB_MODES' own comment.
  const [pnlSubMode, setPnlSubMode] = useState("combined");

  return (
    <CollapsibleCoreTierPanel
      icon={TrendingUp}
      title="Core Tier — PnL"
      headerRight={
        hasAccess && active.length > 0 && (
          <DashboardButton
            onClick={() => loadSnapshot()}
            disabled={snapshotLoading}
            style={{ background: "transparent", border: `1px solid ${border}`, color: mutedLight, boxShadow: "none", padding: "6px 12px", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}
          >
            <RefreshCw size={12} />
            {snapshotLoading ? "Refreshing…" : "Refresh"}
          </DashboardButton>
        )
      }
    >
      <CoreTierGate
        wallet={wallet}
        hasAccess={hasAccess}
        accessError={accessError}
        awaitingActivation={awaitingActivation}
        manualCheckLoading={manualCheckLoading}
        checkAccessOnce={checkAccessOnce}
        featureDescription="see live holdings and running P&L for your tracked wallets"
      >
        {active.length === 0 ? (
          <div style={{ fontSize: 12, color: mutedLight }}>
            Track a wallet under Core Tier — Portfolio above to see its PnL here.
          </div>
        ) : (
          <>
            {/* Required disclaimer + upsell — this view is never a record, the Statement is */}
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, background: panel2, border: `1px solid ${border}`, marginBottom: 16 }}>
              <Info size={14} color={mutedLight} style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 11, color: mutedLight, lineHeight: 1.6 }}>
                This is a live estimate for your own reference and updates continuously — it's not a formal record.
                For an immutable, downloadable statement suitable for tax purposes,{" "}
                <a href="/pnl" style={{ color: green, textDecoration: "underline" }}>generate a PnL Statement</a>.
              </div>
            </div>

            {/* Cold-start token picker — only appears for a wallet still mid-first-ingestion (see
                pnlSnapshotRouter.js's own comment). Prioritizing a smaller set of tokens speeds up
                that FIRST computation a lot; everything else still gets priced automatically in
                the background afterward, so this is purely a speed choice, never a permanent one. */}
            {snapshot?.needsSelection?.length > 0 && (
              <div style={{ padding: "12px 14px", borderRadius: 10, background: panel2, border: `1px solid ${green}`, marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#fff", marginBottom: 4 }}>
                  Speed up your first PnL calculation
                </div>
                <div style={{ fontSize: 11, color: mutedLight, marginBottom: 12, lineHeight: 1.6 }}>
                  Building full price history for every token you've ever held can take a while the first time. Pick
                  which tokens to prioritize — everything else will still be included automatically once it's ready
                  in the background. Leave everything checked to prioritize all of them.
                </div>
                {snapshot.needsSelection.map(({ walletAddress, availableTokens }) => (
                  <div key={walletAddress} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: mutedLight, marginBottom: 6 }}>
                      {walletAddress.toLowerCase() === wallet.account?.toLowerCase() ? "You — " : ""}
                      {resolveWalletName(walletAddress)}
                    </div>
                    {availableTokens.length === 0 ? (
                      <div style={{ fontSize: 11, color: muted }}>No priced token holdings found — nothing to prioritize, continuing normally.</div>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {availableTokens.map((t) => {
                          const checked = pickerSelections[walletAddress]?.has(t.address) ?? true;
                          return (
                            <label
                              key={t.address}
                              style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 8, background: checked ? "rgba(24,187,26,0.12)" : "rgba(255,255,255,0.03)", border: `1px solid ${checked ? green : border}`, cursor: "pointer", fontSize: 11 }}
                            >
                              <input type="checkbox" checked={checked} onChange={() => toggleTokenSelection(walletAddress, t.address)} style={{ accentColor: green }} />
                              <span style={{ color: checked ? "#fff" : mutedLight }}>{t.symbol || t.name || `${t.address.slice(0, 6)}...${t.address.slice(-4)}`}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
                <DashboardButton onClick={submitSelections} disabled={snapshotLoading} style={{ padding: "8px 16px", fontSize: 12, marginTop: 4 }}>
                  {snapshotLoading ? "Computing…" : "Continue"}
                </DashboardButton>
              </div>
            )}

            {snapshotError && <div style={{ fontSize: 12, color: errorColor, marginBottom: 12 }}>{snapshotError}</div>}
            {walletFilter === "all" && snapshot?.failed?.length > 0 && snapshot?.combined && (
              <div style={{ fontSize: 11, color: errorColor, marginBottom: 12 }}>
                Couldn't compute PnL for {snapshot.failed.map((a) => resolveWalletName(a)).join(", ")} right now — the figures below only
                reflect your other tracked wallet{snapshot.failed.length === active.length - 1 ? "" : "s"}. Try Refresh.
              </div>
            )}

            {!snapshot && !snapshotError ? (
              <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>Computing your live PnL — this can take a moment…</div>
            ) : filteredWalletFailed ? (
              <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>
                Couldn't compute PnL for {resolveWalletName(walletFilter)} right now — try Refresh.
              </div>
            ) : !combined && snapshot?.failed?.length > 0 ? (
              <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>
                Couldn't compute PnL for any of your tracked wallets right now — try Refresh.
              </div>
            ) : combined ? (
              <>
                {combined.pricingIncomplete && (
                  <div style={{ fontSize: 11, color: mutedLight, marginBottom: 12, fontStyle: "italic" }}>
                    Still finishing price history for some of your other tokens in the background — the figures below will fill
                    in further on their own. Refresh in a few minutes for the complete picture.
                  </div>
                )}

                {tokenOptions.length > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted }}>Token</span>
                    <select value={tokenFilter} onChange={(e) => setTokenFilter(e.target.value)} style={selectStyle}>
                      <option value="all">All tokens</option>
                      {tokenOptions.map((h) => (
                        <option key={h.tokenAddress} value={h.tokenAddress}>{resolveTokenName(h.tokenAddress)}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 20 }}>
                  <div>
                    <div style={sectionHeaderStyle}>Current Value</div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: "#fff" }}>
                      {figures.currentValueUsd != null ? formatUsdPrice(Number(figures.currentValueUsd)) : "price unavailable"}
                    </div>
                  </div>
                  <div>
                    <div style={sectionHeaderStyle}>Unrealized P&amp;L</div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: figures.unrealizedPnlUsd != null ? pnlColor(Number(figures.unrealizedPnlUsd)) : mutedLight }}>
                      {figures.unrealizedPnlUsd != null ? fmtSigned(Number(figures.unrealizedPnlUsd)) : "—"}
                    </div>
                  </div>
                  <div>
                    <div style={sectionHeaderStyle}>Realized P&amp;L (running total)</div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: pnlColor(Number(figures.realizedPnlUsd)) }}>
                      {fmtSigned(Number(figures.realizedPnlUsd))}
                    </div>
                    <div style={{ fontSize: 10, color: muted, marginTop: 2 }}>
                      {tokenFilter === "all" ? "Since tracking began, net of gas" : "Since tracking began — gas isn't attributed per token"}
                    </div>
                  </div>
                </div>

                {walletFilter === "all" && active.length > 1 && snapshot.perWallet && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 20, paddingBottom: 20, borderBottom: `1px solid ${border}` }}>
                    {snapshot.perWallet
                      .filter((w) => tokenFilter === "all" || w.holdings?.some((h) => h.tokenAddress === tokenFilter))
                      .map((w) => {
                        const wf = pickTokenFigures(w, tokenFilter);
                        return (
                          <div key={w.walletAddress} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                            <span style={{ color: mutedLight }}>
                              {w.walletAddress.toLowerCase() === wallet.account?.toLowerCase() ? "You — " : ""}
                              {resolveWalletName(w.walletAddress)}
                            </span>
                            <span style={{ display: "flex", gap: 10 }}>
                              <span style={{ color: "#fff", fontWeight: 700 }}>
                                {wf.currentValueUsd != null ? formatUsdPrice(Number(wf.currentValueUsd)) : "price unavailable"}
                              </span>
                              <span style={{ color: wf.unrealizedPnlUsd != null ? pnlColor(Number(wf.unrealizedPnlUsd) + Number(wf.realizedPnlUsd)) : mutedLight }}>
                                {wf.unrealizedPnlUsd != null ? fmtSigned(Number(wf.unrealizedPnlUsd) + Number(wf.realizedPnlUsd)) : "—"}
                              </span>
                            </span>
                          </div>
                        );
                      })}
                  </div>
                )}

                <div style={{ marginBottom: 20 }}>
                  <div style={sectionHeaderStyle}>Current Holdings</div>
                  {(() => {
                    // isSpam(address) checks the token's actual resolved name (never a hex
                    // fallback — see useTokenNames.js's own comment on why). marketValueUsd null
                    // means dexPriceQuote.js found no ElectroSwap pool at all for this token
                    // (checked server-side against GeckoTerminal's full pool list, not a narrow
                    // recent-activity window) — a confirmed negative, safe to hide by default.
                    const allHoldings = combined.holdings.filter(
                      (h) => !isSpamToken(h.tokenAddress) && (tokenFilter === "all" || h.tokenAddress === tokenFilter)
                    );
                    const hiddenCount = allHoldings.filter((h) => h.marketValueUsd == null).length;
                    const shown = (showHiddenTokens ? allHoldings : allHoldings.filter((h) => h.marketValueUsd != null))
                      .slice()
                      .sort((a, b) => (Number(b.marketValueUsd) || 0) - (Number(a.marketValueUsd) || 0));

                    if (allHoldings.length === 0) {
                      return (
                        <div style={{ fontSize: 12, color: muted }}>
                          {tokenFilter === "all" ? "No holdings across your tracked wallets right now." : "No holdings of this token right now."}
                        </div>
                      );
                    }
                    return (
                      <>
                        {shown.map((h) => {
                          const unrealized = h.marketValueUsd != null ? Number(h.marketValueUsd) - Number(h.costBasisUsd) : null;
                          return (
                            <div key={h.tokenAddress} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${border}` }}>
                              <span style={{ fontSize: 12, color: "#fff" }}>
                                {onSelectToken ? (
                                  <button
                                    type="button"
                                    onClick={() => onSelectToken(h.tokenAddress)}
                                    style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: "underline", textDecorationColor: "transparent" }}
                                    onMouseEnter={(e) => { e.currentTarget.style.textDecorationColor = green; }}
                                    onMouseLeave={(e) => { e.currentTarget.style.textDecorationColor = "transparent"; }}
                                    title="View on the Tokens page"
                                  >
                                    {resolveTokenName(h.tokenAddress)}
                                  </button>
                                ) : (
                                  resolveTokenName(h.tokenAddress)
                                )}
                              </span>
                              <span style={{ textAlign: "right" }}>
                                <span style={{ fontSize: 12, color: "#fff", fontWeight: 700 }}>
                                  {h.marketValueUsd != null ? formatUsdPrice(Number(h.marketValueUsd)) : "price unavailable"}
                                </span>
                                {unrealized != null && (
                                  <span style={{ display: "block", fontSize: 10, color: pnlColor(unrealized) }}>{fmtSigned(unrealized)}</span>
                                )}
                              </span>
                            </div>
                          );
                        })}
                        {!showHiddenTokens && hiddenCount > 0 && (
                          <div style={{ marginTop: 10, fontSize: 11, color: muted, textAlign: "center" }}>
                            {hiddenCount} token{hiddenCount === 1 ? "" : "s"} hidden (no ElectroSwap pool found) —{" "}
                            <button type="button" onClick={() => setShowHiddenTokens(true)} style={{ background: "none", border: "none", padding: 0, color: green, cursor: "pointer", textDecoration: "underline", fontSize: 11 }}>
                              Show
                            </button>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </>
            ) : null}

            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                <div style={{ ...sectionHeaderStyle, marginBottom: 0 }}>
                  {chartMode === "pnl" ? "PnL Over Time" : "Value Over Time"}
                  <InfoTooltip text="Your whole portfolio's value and profit/loss, day by day, since tracking began. PnL mode shows realized + unrealized combined; Value mode shows raw portfolio value." />
                </div>
                <PnlValueToggle chartMode={chartMode} setChartMode={setChartMode} />
              </div>
              {chartMode === "pnl" && <PnlSubModeToggle pnlSubMode={pnlSubMode} setPnlSubMode={setPnlSubMode} />}
              {tokenFilter !== "all" && !historyError && (
                <div style={{ fontSize: 11, color: muted, marginBottom: 8, fontStyle: "italic" }}>
                  Per-token history isn't available yet — this chart shows your whole tracked wallet{walletFilter === "all" && active.length > 1 ? "s" : ""}, not just the selected token.
                </div>
              )}
              {historyError ? (
                <div style={{ fontSize: 12, color: errorColor }}>{historyError}</div>
              ) : combinedHistory.length === 0 ? (
                <div style={{ fontSize: 12, color: mutedLight }}>
                  No history yet — this fills in once the daily snapshot has run at least once.
                </div>
              ) : (
                <SparklineChart
                  data={combinedHistory.map((p) => ({
                    label: p.date,
                    value: chartMode === "pnl" ? pnlOverTimeValue(p, pnlSubMode) : Number(p.totalValueUsd),
                  }))}
                  height={120}
                  formatValue={chartMode === "pnl" ? fmtSigned : formatValue}
                  formatLabel={formatChartDate}
                  colorBySign={chartMode === "pnl"}
                />
              )}
            </div>

            <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${border}` }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                <div style={{ ...sectionHeaderStyle, marginBottom: 0 }}>
                  {categoryChartMode === "pnl" ? "PnL Over Time" : "Value Over Time"}
                  <InfoTooltip text="Same idea as the chart above, scoped to one category — pick Liquidity Positions (V2/V3, held directly) or Staking / Yield Farms below. Covers realized gains/losses and reward income; does NOT include the live value of a position that's currently open/locked — see Liquidity Positions / Staked & Farming Positions above for that." />
                </div>
                <PnlValueToggle chartMode={categoryChartMode} setChartMode={setCategoryChartMode} />
              </div>
              {categoryChartMode === "pnl" && <PnlSubModeToggle pnlSubMode={categoryPnlSubMode} setPnlSubMode={setCategoryPnlSubMode} />}

              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                style={{ ...selectStyle, marginBottom: 12, width: "100%" }}
              >
                {CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.key} value={opt.key}>{opt.label}</option>
                ))}
              </select>

              {categoryHistoryError ? (
                <div style={{ fontSize: 12, color: errorColor }}>{categoryHistoryError}</div>
              ) : !categoryHistory ? (
                <div style={{ fontSize: 12, color: mutedLight }}>Loading…</div>
              ) : combinedCategoryHistory.length === 0 ? (
                <div style={{ fontSize: 12, color: mutedLight }}>
                  No {CATEGORY_OPTIONS.find((o) => o.key === selectedCategory)?.label.toLowerCase()} history yet — this fills in once the daily snapshot has run at least once, and only if this wallet has ever actually had any.
                </div>
              ) : (
                <SparklineChart
                  data={combinedCategoryHistory.map((p) => ({
                    label: p.date,
                    value: categoryChartMode === "pnl" ? pnlOverTimeValue(p, categoryPnlSubMode) : Number(p.totalValueUsd),
                  }))}
                  height={120}
                  formatValue={categoryChartMode === "pnl" ? fmtSigned : formatValue}
                  formatLabel={formatChartDate}
                  colorBySign={categoryChartMode === "pnl"}
                />
              )}
            </div>
          </>
        )}
      </CoreTierGate>
    </CollapsibleCoreTierPanel>
  );
}
