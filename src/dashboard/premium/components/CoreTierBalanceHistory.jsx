import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { LineChart } from "lucide-react";
import CollapsibleCoreTierPanel from "./CollapsibleCoreTierPanel.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import SparklineChart from "../../components/SparklineChart.jsx";
import { useBlockscout } from "../../hooks/useBlockscout.js";
import { useEtnPriceHistory } from "../../hooks/useEtnPriceHistory.js";
import { useTokenBalanceHistory } from "../../hooks/useTokenBalanceHistory.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { mergeBalanceHistories, mergeTokenBalanceHistories, buildEtnPriceLookup, convertSeriesToUsd, buildDailySeries } from "../../utils/balanceHistory.js";
import { isSpamTokenName } from "../../utils/format.js";
import { getHistoricalBalance } from "../../utils/historicalBalance.js";
import { formatChartDate, formatUsdPrice } from "../../utils/format.js";
import { green, muted, mutedLight, border, panel2, monoFont } from "../../theme.js";

function fmtEtn(v) {
  return `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETN`;
}

const VALUE_MODES = [
  { id: "etn", label: "ETN" },
  { id: "usd", label: "USD" },
];
const AUTH_PURPOSE = "Premium Dashboard";
const NFT_TOKEN_TYPES = new Set(["ERC-721", "ERC-1155"]);
const ETN_SENTINEL = "ETN"; // selectedAsset value for the original native-ETN chart — never a real token address, so it can't collide

// Every chart on this page shares this exact window — a rolling 12 months ending today — so
// they're always directly comparable to each other, not each showing however far back that one
// wallet's own history happens to reach.
const WINDOW_DAYS = 365;

// Core Tier's second feature: full ETN balance history — combined across every tracked wallet,
// plus each wallet's own — reusing the exact same Blockscout endpoint (coin-balance-history-by-
// day) AddressLookup.jsx already charts for a single free-tier lookup, just fanned out across the
// tracked-wallet list and merged (see balanceHistory.js for why that merge needs to forward-fill
// rather than just sum whatever lands on the same date).
//
// The asset dropdown (ETN, or any currently-held fungible token) ADDS per-token balance history on
// top of that — Blockscout has no equivalent historical-balance endpoint for ERC-20 holdings (only
// the live snapshot CoreTierPortfolio.jsx already shows), so a token's series comes from this app's
// OWN ingested transfer history instead (tokenBalanceHistoryService.js), not Blockscout. No USD
// toggle for a token (no per-token historical price feed exists to convert with), and no
// historical-seed backfill (unlike ETN's Blockscout-sourced 90-day cap, this app's own transfer
// history already reaches back to cold-start).
//
// The ETN/USD toggle converts using the REAL historical price on each date (useEtnPriceHistory's
// own dense, gap-free daily series — confirmed live back to 2019-07-10), not today's price applied
// retroactively — the latter would just be a rescaled copy of the ETN chart, not an actual "what
// was this worth" answer.
//
// Access + tracked-wallet-list state and the page-wide wallet filter both live in
// PortfolioDashboardSection.jsx now — passed down here as `coreTierAccess`/`walletFilter` instead
// of this component calling useCoreTierAccess itself (see that file's own comment on why: one
// shared fetch for all four Core Tier panels, and a filter the panels couldn't otherwise agree on).
export default function CoreTierBalanceHistory({ wallet, getAuthParams, coreTierAccess, walletFilter }) {
  const {
    hasAccess, accessError, awaitingActivation, manualCheckLoading,
    active, checkAccessOnce,
  } = coreTierAccess;
  const { getAddressCoinBalanceHistory, getAddressTokenBalances } = useBlockscout();
  const { getEtnPriceHistory } = useEtnPriceHistory();
  const { getTokenBalanceHistory } = useTokenBalanceHistory();
  const { resolve: resolveName } = useDisplayNames(active.map((w) => w.address));

  const [historiesByAddress, setHistoriesByAddress] = useState({}); // address -> items[] | null (loading)
  const [error, setError] = useState(null);
  const [pricePoints, setPricePoints] = useState(null); // null until loaded
  const [valueMode, setValueMode] = useState("etn");

  // Which asset this chart shows — ETN_SENTINEL (the original chart, default) or a currently-held
  // token's lowercased address. A dropdown, not a per-wallet toggle like `valueMode` — switching
  // asset is a bigger change than switching units, deserves its own control.
  const [selectedAsset, setSelectedAsset] = useState(ETN_SENTINEL);
  const [heldTokens, setHeldTokens] = useState([]); // [{address, symbol, name}] — currently-held fungible tokens across active wallets, for the dropdown
  const [tokenHistoriesByAddress, setTokenHistoriesByAddress] = useState({}); // wallet address -> series[] | null (loading), for whichever token is selected
  const [tokenHistoryError, setTokenHistoryError] = useState(null);
  // address -> real ETN balance at WINDOW_DAYS ago, or 0 until resolved/if unresolvable — see
  // historicalBalance.js's own header comment for why "before the wallet's first Blockscout
  // history entry" must NOT default to 0 the way it did before this existed. Fetched separately
  // from (and doesn't block) historiesByAddress above — a genuine improvement to the chart's
  // accuracy once it resolves, not something the rest of the panel needs to wait on.
  const [historicalSeeds, setHistoricalSeeds] = useState({});

  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setHistoriesByAddress({});
      return;
    }
    let cancelled = false;
    setError(null);
    setHistoriesByAddress(Object.fromEntries(active.map((w) => [w.address, null])));

    Promise.all(
      active.map((w) =>
        getAddressCoinBalanceHistory(w.address)
          .then((res) => [w.address, Array.isArray(res?.items) ? res.items : []])
          .catch((err) => {
            console.error(`Failed to load balance history for ${w.address}:`, err.message);
            return [w.address, []]; // one wallet failing shouldn't blank the whole chart
          })
      )
    ).then((entries) => {
      if (cancelled) return;
      setHistoriesByAddress(Object.fromEntries(entries));
    });

    return () => { cancelled = true; };
  }, [hasAccess, active, getAddressCoinBalanceHistory]);

  // Backfills the stretch of the 12-month window older than Blockscout's own history retains —
  // see historicalBalance.js's own header comment. One RPC call per wallet, run in parallel,
  // independent of the fetch above so a slow/failed lookup here never blocks the chart itself from
  // rendering with today's "assume 0" fallback in the meantime.
  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setHistoricalSeeds({});
      return;
    }
    let cancelled = false;
    Promise.all(active.map((w) => getHistoricalBalance(w.address, WINDOW_DAYS).then((v) => [w.address, v ?? 0]))).then(
      (entries) => {
        if (!cancelled) setHistoricalSeeds(Object.fromEntries(entries));
      }
    );
    return () => { cancelled = true; };
  }, [hasAccess, active]);

  // Full daily ETN/USD price history — site-wide, not per-wallet, so fetched once (not per
  // tracked wallet) whenever there's anything to convert. "all" (not "1y") since a wallet's own
  // balance history can reach back further than a year.
  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setPricePoints(null);
      return;
    }
    let cancelled = false;
    getEtnPriceHistory("all")
      .then((res) => { if (!cancelled) setPricePoints(Array.isArray(res?.points) ? res.points : []); })
      .catch((err) => {
        console.error("Failed to load ETN price history:", err.message);
        if (!cancelled) setPricePoints([]);
      });
    return () => { cancelled = true; };
  }, [hasAccess, active, getEtnPriceHistory]);

  // Currently-held fungible tokens across every active wallet, for the dropdown — a live Blockscout
  // read (same endpoint AddressLookup.jsx/CoreTierPortfolio.jsx already use for holdings), not a
  // backend round-trip, since this is just populating choices, not the chart data itself.
  useEffect(() => {
    if (!hasAccess || active.length === 0) {
      setHeldTokens([]);
      return;
    }
    let cancelled = false;
    Promise.all(active.map((w) => getAddressTokenBalances(w.address).catch(() => [])))
      .then((perWallet) => {
        if (cancelled) return;
        const byAddress = new Map();
        for (const balances of perWallet) {
          for (const tb of balances || []) {
            const addr = tb.token?.address?.toLowerCase();
            if (!addr || NFT_TOKEN_TYPES.has(tb.token?.type) || isSpamTokenName(tb.token?.name)) continue;
            if (!byAddress.has(addr)) byAddress.set(addr, { address: addr, symbol: tb.token?.symbol, name: tb.token?.name });
          }
        }
        setHeldTokens([...byAddress.values()].sort((a, b) => (a.symbol || a.name || "").localeCompare(b.symbol || b.name || "")));
      })
      .catch((err) => console.warn("Failed to load held tokens for Balance History dropdown:", err.message));
    return () => { cancelled = true; };
  }, [hasAccess, active, getAddressTokenBalances]);

  // Self-heals the same way effectiveSelectedWallet below does: if the selected token is no longer
  // held by any active wallet (untracked, sold, or just not loaded yet), falls back to ETN rather
  // than showing a chart for a token no longer in scope.
  const effectiveSelectedAsset =
    selectedAsset === ETN_SENTINEL || heldTokens.some((t) => t.address === selectedAsset) ? selectedAsset : ETN_SENTINEL;

  // Per-token balance history — only fetched once a real token is selected, independent of the ETN
  // fetches above (switching the dropdown shouldn't re-pay for Blockscout's own ETN history).
  useEffect(() => {
    if (effectiveSelectedAsset === ETN_SENTINEL || !hasAccess || active.length === 0) {
      setTokenHistoriesByAddress({});
      return;
    }
    let cancelled = false;
    setTokenHistoryError(null);
    setTokenHistoriesByAddress(Object.fromEntries(active.map((w) => [w.address, null])));
    (async () => {
      try {
        // One call covers every active wallet (the backend loops over them server-side, same as
        // every other multi-wallet Core Tier endpoint) — not one call per wallet.
        const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
        const res = await getTokenBalanceHistory(wallet.account, signature, timestamp, effectiveSelectedAsset);
        if (cancelled) return;
        const byAddress = Object.fromEntries((res.perWallet || []).map((p) => [p.walletAddress, p.series]));
        setTokenHistoriesByAddress(byAddress);
      } catch (err) {
        console.error("Failed to load token balance history:", err.message);
        if (!cancelled) setTokenHistoryError("Couldn't load this token's balance history — try again shortly.");
      }
    })();
    return () => { cancelled = true; };
  }, [effectiveSelectedAsset, hasAccess, active, getAuthParams, getTokenBalanceHistory, wallet.account]);

  const priceLookup = useMemo(
    () => (pricePoints && pricePoints.length > 0 ? buildEtnPriceLookup(pricePoints) : null),
    [pricePoints]
  );
  const usdReady = priceLookup != null;
  const showUsd = valueMode === "usd" && usdReady;

  const loaded = active.length > 0 && active.every((w) => historiesByAddress[w.address] != null);
  // ETN-float seed -> wei bigint, the representation mergeBalanceHistories' own per-wallet
  // currentWei accumulator uses. A malformed/out-of-range value (shouldn't happen given
  // historicalBalance.js's own formatting, but defensive regardless) falls back to 0n — the same
  // "assume 0" this whole backfill exists to improve on, never worse than before.
  function toWeiSeed(etnValue) {
    try {
      return ethers.parseEther((etnValue || 0).toFixed(18));
    } catch {
      return 0n;
    }
  }
  // buildDailySeries always returns a full WINDOW_DAYS+1-point series regardless of input (a
  // wallet with literally no history yet still gets a flat line at its own seed value) —
  // hasCombinedHistory checks the underlying sparse data instead, so a tracked wallet with no
  // activity AND no resolvable historical seed shows the "not enough history" message rather than
  // a flat, uninformative zero line.
  const combinedSparse = loaded
    ? mergeBalanceHistories(active.map((w) => historiesByAddress[w.address]), active.map((w) => toWeiSeed(historicalSeeds[w.address])))
    : [];
  const combinedSeedEtn = active.reduce((sum, w) => sum + (historicalSeeds[w.address] || 0), 0);
  // A wallet that's held a flat nonzero balance for the whole window (no actual Blockscout entries
  // at all, but a real backfilled seed) still counts as "has history" — without this, it would
  // wrongly show "No balance history yet" despite a real, if unchanging, balance to chart.
  const hasCombinedHistory = combinedSparse.length > 0 || combinedSeedEtn > 0;
  const combinedSeriesEtn = buildDailySeries(combinedSparse, WINDOW_DAYS, combinedSeedEtn);
  const combinedSeries = showUsd ? convertSeriesToUsd(combinedSeriesEtn, priceLookup) : combinedSeriesEtn;
  const formatValue = showUsd ? formatUsdPrice : fmtEtn;

  // Translates the page-wide walletFilter ("all" | address) into this chart's own vocabulary
  // ("combined" | address) — falls back to "combined" if it's pointed at a wallet no longer in
  // `active` (PortfolioDashboardSection.jsx already guards this the same way, but a untracked-mid-
  // render edge case is cheap to guard here too rather than trust the prop blindly).
  const effectiveSelectedWallet =
    walletFilter === "all" || !active.some((w) => w.address === walletFilter) ? "combined" : walletFilter;

  /** One wallet's own daily series (ETN or USD, matching valueMode) — same shape as the combined
   * series above, just scoped to a single address's own history + backfilled seed. */
  function buildWalletSeries(address) {
    const items = historiesByAddress[address] || [];
    const sparse = items.map((d) => ({ label: d.date, value: parseFloat(ethers.formatEther(d.value)) }));
    const seedEtn = historicalSeeds[address] || 0;
    const seriesEtn = buildDailySeries(sparse, WINDOW_DAYS, seedEtn);
    return { series: showUsd ? convertSeriesToUsd(seriesEtn, priceLookup) : seriesEtn, hasHistory: sparse.length > 0 || seedEtn > 0 };
  }

  // Token-mode equivalents of everything above — no USD toggle (wasn't asked for, and this app has
  // no per-token historical price feed to convert with anyway — see tokenBurnService.js's own note
  // on the same gap), no historical-seed backfill (this app's own ingested transfer history already
  // reaches back to cold-start, unlike Blockscout's 90-day-capped ETN history).
  const selectedTokenInfo = effectiveSelectedAsset !== ETN_SENTINEL ? heldTokens.find((t) => t.address === effectiveSelectedAsset) : null;
  const tokenLoaded = effectiveSelectedAsset !== ETN_SENTINEL && active.length > 0 && active.every((w) => tokenHistoriesByAddress[w.address] != null);
  function fmtToken(v) {
    return `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${selectedTokenInfo?.symbol || "TOKEN"}`;
  }
  const tokenCombinedSparse = tokenLoaded ? mergeTokenBalanceHistories(active.map((w) => tokenHistoriesByAddress[w.address] || [])) : [];
  const hasTokenCombinedHistory = tokenCombinedSparse.length > 0;
  const tokenCombinedSeries = buildDailySeries(tokenCombinedSparse, WINDOW_DAYS, 0);
  function buildTokenWalletSeries(address) {
    const items = tokenHistoriesByAddress[address] || [];
    const sparse = items.map((d) => ({ label: d.date, value: Number(d.balance) }));
    return { series: buildDailySeries(sparse, WINDOW_DAYS, 0), hasHistory: sparse.length > 0 };
  }

  return (
    <CollapsibleCoreTierPanel
      icon={LineChart}
      title="Core Tier — Balance History"
      defaultCollapsed={false}
      headerRight={
        active.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {heldTokens.length > 0 && (
              <select
                value={effectiveSelectedAsset}
                onChange={(e) => setSelectedAsset(e.target.value)}
                aria-label="Which asset's balance history to show"
                style={{ padding: "5px 10px", borderRadius: 6, border: `1px solid ${border}`, background: panel2, color: "#fff", fontFamily: monoFont, fontSize: 11, fontWeight: 700, outline: "none" }}
              >
                <option value={ETN_SENTINEL}>ETN</option>
                {heldTokens.map((t) => (
                  <option key={t.address} value={t.address}>{t.symbol || t.name || t.address}</option>
                ))}
              </select>
            )}
            {effectiveSelectedAsset === ETN_SENTINEL && (
              <div style={{ display: "flex", gap: 6 }}>
                {VALUE_MODES.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setValueMode(m.id)}
                    disabled={m.id === "usd" && !usdReady}
                    title={m.id === "usd" && !usdReady ? "Loading price history…" : undefined}
                    style={{
                      padding: "5px 12px",
                      borderRadius: 6,
                      border: `1px solid ${m.id === valueMode ? green : border}`,
                      background: m.id === valueMode ? "rgba(24,187,26,0.12)" : panel2,
                      color: m.id === "usd" && !usdReady ? muted : m.id === valueMode ? green : mutedLight,
                      fontFamily: monoFont,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: m.id === "usd" && !usdReady ? "not-allowed" : "pointer",
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            )}
          </div>
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
        featureDescription="see full ETN balance history for your tracked wallets, combined and individually"
      >
        {active.length === 0 ? (
          <div style={{ fontSize: 12, color: mutedLight }}>
            No wallets tracked yet — add up to 3 under Core Tier — Portfolio above to see their
            balance history here.
          </div>
        ) : effectiveSelectedAsset !== ETN_SENTINEL ? (
          tokenHistoryError ? (
            <div style={{ fontSize: 12, color: "#ff6b6b" }}>{tokenHistoryError}</div>
          ) : !tokenLoaded ? (
            <div style={{ fontSize: 12, color: mutedLight }}>Loading balance history…</div>
          ) : (
            <div>
              {effectiveSelectedWallet === "combined" ? (
                <div>
                  <div style={{ fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 4 }}>
                    {active.length > 1 ? "Combined Balance History" : "Balance History"} — {selectedTokenInfo?.symbol || selectedTokenInfo?.name || "Token"}
                  </div>
                  <div style={{ fontSize: 10, color: muted, marginBottom: 10 }}>Last 12 months</div>
                  {!hasTokenCombinedHistory ? (
                    <div style={{ fontSize: 12, color: muted }}>No balance history yet.</div>
                  ) : (
                    <SparklineChart data={tokenCombinedSeries} height={140} formatValue={fmtToken} formatLabel={formatChartDate} />
                  )}
                </div>
              ) : (
                (() => {
                  const { series, hasHistory } = buildTokenWalletSeries(effectiveSelectedWallet);
                  return (
                    <div>
                      <div style={{ fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 4 }}>
                        {resolveName(effectiveSelectedWallet)} — {selectedTokenInfo?.symbol || selectedTokenInfo?.name || "Token"}
                      </div>
                      <div style={{ fontSize: 10, color: muted, marginBottom: 10 }}>Last 12 months</div>
                      {!hasHistory ? (
                        <div style={{ fontSize: 12, color: muted }}>No balance history yet.</div>
                      ) : (
                        <SparklineChart data={series} height={140} formatValue={fmtToken} formatLabel={formatChartDate} />
                      )}
                    </div>
                  );
                })()
              )}
            </div>
          )
        ) : error ? (
          <div style={{ fontSize: 12, color: "#ff6b6b" }}>{error}</div>
        ) : !loaded ? (
          <div style={{ fontSize: 12, color: mutedLight }}>Loading balance history…</div>
        ) : (
          <div>
            {effectiveSelectedWallet === "combined" ? (
              <div>
                <div style={{ fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 4 }}>
                  {active.length > 1 ? "Combined Balance History" : "Balance History"}
                </div>
                <div style={{ fontSize: 10, color: muted, marginBottom: 10 }}>Last 12 months</div>
                {!hasCombinedHistory ? (
                  <div style={{ fontSize: 12, color: muted }}>No balance history yet.</div>
                ) : (
                  <SparklineChart data={combinedSeries} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
                )}
              </div>
            ) : (
              (() => {
                const w = active.find((a) => a.address === effectiveSelectedWallet);
                const { series, hasHistory } = buildWalletSeries(effectiveSelectedWallet);
                return (
                  <div>
                    <div style={{ fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 4 }}>
                      {w?.isOwnWallet ? "You — " : ""}
                      {resolveName(effectiveSelectedWallet)}
                    </div>
                    <div style={{ fontSize: 10, color: muted, marginBottom: 10 }}>Last 12 months</div>
                    {!hasHistory ? (
                      <div style={{ fontSize: 12, color: muted }}>No balance history yet.</div>
                    ) : (
                      <SparklineChart data={series} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
                    )}
                  </div>
                );
              })()
            )}
          </div>
        )}
      </CoreTierGate>
    </CollapsibleCoreTierPanel>
  );
}
