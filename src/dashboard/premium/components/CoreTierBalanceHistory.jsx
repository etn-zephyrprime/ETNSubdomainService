import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { LineChart } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import SparklineChart from "../../components/SparklineChart.jsx";
import { useCoreTierAccess } from "../../hooks/useCoreTierAccess.js";
import { useBlockscout } from "../../hooks/useBlockscout.js";
import { useEtnPriceHistory } from "../../hooks/useEtnPriceHistory.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { mergeBalanceHistories, buildEtnPriceLookup, convertSeriesToUsd, buildDailySeries } from "../../utils/balanceHistory.js";
import { getHistoricalBalance } from "../../utils/historicalBalance.js";
import { formatChartDate, formatUsdPrice } from "../../utils/format.js";
import { green, muted, mutedLight, border, panel2 } from "../../theme.js";

function fmtEtn(v) {
  return `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETN`;
}

const VALUE_MODES = [
  { id: "etn", label: "ETN" },
  { id: "usd", label: "USD" },
];

// Every chart on this page shares this exact window — a rolling 12 months ending today — so
// they're always directly comparable to each other, not each showing however far back that one
// wallet's own history happens to reach.
const WINDOW_DAYS = 365;

// Core Tier's second feature: full ETN balance history — combined across every tracked wallet,
// plus each wallet's own — reusing the exact same Blockscout endpoint (coin-balance-history-by-
// day) AddressLookup.jsx already charts for a single free-tier lookup, just fanned out across the
// tracked-wallet list and merged (see balanceHistory.js for why that merge needs to forward-fill
// rather than just sum whatever lands on the same date). Deliberately ETN-only, not per-token:
// Blockscout has no equivalent historical-balance endpoint for ERC-20/721/1155 holdings, only the
// live snapshot CoreTierPortfolio.jsx already shows — reconstructing token balance-over-time would
// mean indexing every transfer ourselves, a materially bigger feature than this one.
//
// The ETN/USD toggle converts using the REAL historical price on each date (useEtnPriceHistory's
// own dense, gap-free daily series — confirmed live back to 2019-07-10), not today's price applied
// retroactively — the latter would just be a rescaled copy of the ETN chart, not an actual "what
// was this worth" answer.
//
// Shares useCoreTierAccess with CoreTierPortfolio.jsx (same membershipVersion prop, passed down
// from PortfolioDashboardSection.jsx) rather than each maintaining its own copy of "is this member
// allowed, and which wallets do they track" — see that hook's own header comment.
export default function CoreTierBalanceHistory({ wallet, membershipVersion = 0, getAuthParams }) {
  const {
    hasAccess, accessError, awaitingActivation, manualCheckLoading,
    active, checkAccessOnce,
  } = useCoreTierAccess(wallet, membershipVersion, getAuthParams);
  const { getAddressCoinBalanceHistory } = useBlockscout();
  const { getEtnPriceHistory } = useEtnPriceHistory();
  const { resolve: resolveName } = useDisplayNames(active.map((w) => w.address));

  const [historiesByAddress, setHistoriesByAddress] = useState({}); // address -> items[] | null (loading)
  const [error, setError] = useState(null);
  const [pricePoints, setPricePoints] = useState(null); // null until loaded
  const [valueMode, setValueMode] = useState("etn");
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

  return (
    <DashboardPanel>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <LineChart size={18} color={green} />
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
            Core Tier — Balance History
          </div>
        </div>
        {loaded && active.length > 0 && (
          <div style={{ display: "flex", gap: 6 }}>
            {VALUE_MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setValueMode(m.id)}
                disabled={m.id === "usd" && !usdReady}
                title={m.id === "usd" && !usdReady ? "Loading price history…" : undefined}
                style={{
                  padding: "5px 12px",
                  borderRadius: 8,
                  border: `1px solid ${m.id === valueMode ? green : border}`,
                  background: m.id === valueMode ? "rgba(24,187,26,0.12)" : panel2,
                  color: m.id === "usd" && !usdReady ? muted : m.id === valueMode ? green : mutedLight,
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
        ) : error ? (
          <div style={{ fontSize: 12, color: "#ff6b6b" }}>{error}</div>
        ) : !loaded ? (
          <div style={{ fontSize: 12, color: mutedLight }}>Loading balance history…</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 4 }}>
                {active.length > 1 ? "Combined Balance History" : "Balance History"}
              </div>
              <div style={{ fontSize: 10, color: muted, marginBottom: 10 }}>Last 12 months</div>
              {!hasCombinedHistory ? (
                <div style={{ fontSize: 12, color: muted }}>No balance history yet.</div>
              ) : (
                <SparklineChart data={combinedSeries} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
              )}
            </div>

            {active.length > 1 &&
              active.map((w) => {
                const items = historiesByAddress[w.address] || [];
                const sparse = items.map((d) => ({ label: d.date, value: parseFloat(ethers.formatEther(d.value)) }));
                const seedEtn = historicalSeeds[w.address] || 0;
                const seriesEtn = buildDailySeries(sparse, WINDOW_DAYS, seedEtn);
                const series = showUsd ? convertSeriesToUsd(seriesEtn, priceLookup) : seriesEtn;
                return (
                  <div key={w.address}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
                      {w.address.toLowerCase() === wallet.account?.toLowerCase() ? "You — " : ""}
                      {resolveName(w.address)}
                    </div>
                    {sparse.length === 0 && seedEtn === 0 ? (
                      <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>No balance history yet.</div>
                    ) : (
                      <SparklineChart data={series} height={100} formatValue={formatValue} formatLabel={formatChartDate} />
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </CoreTierGate>
    </DashboardPanel>
  );
}
