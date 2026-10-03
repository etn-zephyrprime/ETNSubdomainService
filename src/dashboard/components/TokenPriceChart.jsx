import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { green, error as errorColor, mutedLight, muted, panel2, border } from "../theme.js";
import { useTokenChart } from "../hooks/useTokenChart.js";
import { formatUsdPrice, formatEtnPrice, formatCompact, formatChartDate } from "../utils/format.js";
import SparklineChart from "./SparklineChart.jsx";
import CandlestickChart from "./CandlestickChart.jsx";

const RANGES = [
  { id: "7", label: "7D" },
  { id: "30", label: "30D" },
  { id: "90", label: "90D" },
];
const METRICS = [
  { id: "price", label: "Price" },
  { id: "marketCap", label: "Market Cap" },
];
const CURRENCIES = [
  { id: "usd", label: "USD" },
  { id: "etn", label: "ETN" },
];

function Pill({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 14px",
        borderRadius: 8,
        border: `1px solid ${active ? green : border}`,
        background: active ? "rgba(24,187,26,0.12)" : panel2,
        color: active ? green : mutedLight,
        fontSize: 12,
        fontWeight: 700,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

// Per-token price chart on TokenDetail — via this app's own backend (useTokenChart.js), which
// proxies+caches GeckoTerminal's onchain OHLCV for whichever ElectroSwap pool has this token's
// deepest liquidity (see tokenChartRouter.js's header comment for why this needs a backend
// proxy at all, unlike every other dashboard data source). Market Cap isn't something
// GeckoTerminal tracks historically for an arbitrary long-tail token, so it's derived here
// instead: each candle's close price × this token's current total supply — an approximation
// (assumes supply hasn't materially changed across the shown window, true for most fixed-supply
// tokens but not a guarantee), not a second data source.
export default function TokenPriceChart({ address, decimals, totalSupply }) {
  const { getTokenChart } = useTokenChart();

  const [range, setRange] = useState("30");
  const [metric, setMetric] = useState("price");
  const [currency, setCurrency] = useState("usd"); // "usd" | "etn" — ETN only meaningful for the Price metric, see the toggle below
  const [chart, setChart] = useState(null); // { hasData, candles?, pool?, hasWetnPool } — always USD-denominated; drives Market Cap and the ETN toggle's availability
  const [wetnChart, setWetnChart] = useState(null); // same shape, WETN-denominated — only fetched once the ETN toggle is actually used
  const [wetnRateLimited, setWetnRateLimited] = useState(false); // true once retries are exhausted specifically on a 503 — see the fetch effect below
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setChart(null);
    setError(null);
    getTokenChart(address, range, "usd")
      .then((res) => { if (!cancelled) setChart(res); })
      .catch((err) => {
        console.error("Failed to load token chart:", err);
        if (!cancelled) setError(err.message || "Couldn't load chart data — try again shortly.");
      });
    return () => { cancelled = true; };
  }, [address, range, getTokenChart]);

  const etnToggleReady = chart?.hasWetnPool === true;

  // Only fetched once the ETN toggle is actually in use (and only possible when this token has a
  // real WETN pool) — denominated DIRECTLY in the pool's own WETN-reserve ratio, the same figure
  // GeckoTerminal's own site shows ("1 CORE = 13.74 WETN"), not derived by dividing this token's
  // USD price by ETN's separately-sourced USD price. CONFIRMED LIVE that division drifts from the
  // real on-chain ratio by a few percent (two independent markets — a DEX pool vs. KuCoin's
  // ETN-USDT spot — don't perfectly arbitrage against each other): reported 1 CORE = 13.74 WETN
  // on GeckoTerminal vs. 13.0248 "ETN" from the old division-based figure. Since WETN is 1:1
  // pegged to ETN (same assumption tokenLiquidityCache.js/lpPositionValuation.js already make),
  // the pool's own ratio IS the real ETN price, no cross-market round trip needed — see
  // tokenChartRouter.js's own loadTokenChart comment for the confirmed live numbers.
  useEffect(() => {
    if (metric !== "price" || currency !== "etn" || !etnToggleReady) return;
    let cancelled = false;
    let timer = null;
    setWetnChart(null);
    setWetnRateLimited(false);

    // A few retries, backing off each time, specifically for GeckoTerminal's shared rate limit
    // (503 — see tokenChartRouter.js's own err.rateLimited handling) — reported live: switching
    // to ETN tripped this. Expected to be MORE exposed to it than a plain USD range click: this
    // mode skips ElectroSwap's own (non-rate-limited) candles entirely — see loadTokenChart's own
    // comment on why there's no documented non-USD mode for that source — so it's often the
    // FIRST GeckoTerminal call for this token/range rather than one ElectroSwap already served,
    // landing on whatever's left of the shared budget. A transient burst like that usually clears
    // within a few seconds; every OTHER failure (400/502/no pool) is never worth retrying.
    function load(attempt = 0) {
      getTokenChart(address, range, "wetn")
        .then((res) => { if (!cancelled) setWetnChart(res); })
        .catch((err) => {
          console.error(`Failed to load WETN-denominated token chart (attempt ${attempt + 1}):`, err.message);
          if (err.status === 503 && attempt < 3) {
            timer = setTimeout(() => { if (!cancelled) load(attempt + 1); }, 4000 * (attempt + 1));
            return;
          }
          if (!cancelled) {
            setWetnChart({ hasData: false });
            setWetnRateLimited(err.status === 503);
          }
        });
    }
    load();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [address, range, metric, currency, etnToggleReady, getTokenChart]);

  const effectiveCurrency = metric === "price" && etnToggleReady && currency === "etn" ? "etn" : "usd";
  const activeChart = effectiveCurrency === "etn" ? wetnChart : chart;

  const supplyFloat = useMemo(() => {
    try {
      return parseFloat(ethers.formatUnits(totalSupply || "0", decimals == null ? 18 : Number(decimals)));
    } catch {
      return 0;
    }
  }, [totalSupply, decimals]);

  // Volume stays USD-only (and is simply omitted in ETN mode) — GeckoTerminal's own volume figure
  // switches denomination right along with `currency` (confirmed live: ~51,656 WETN vs. ~111 USD
  // for the same candle), so showing it unlabeled under a WETN-denominated chart would read as a
  // USD figure that's actually in WETN units. Not asked for here, so left out rather than guessed at.
  const volumeSeries = useMemo(() => {
    if (effectiveCurrency === "etn" || !chart?.candles) return null;
    return chart.candles.map((c) => ({ label: c.label, value: c.volumeUsd || 0 }));
  }, [chart, effectiveCurrency]);

  const marketCapSeries = useMemo(() => {
    if (!chart?.candles || !supplyFloat) return [];
    return chart.candles.map((c) => ({ label: c.label, value: c.close * supplyFloat }));
  }, [chart, supplyFloat]);

  const stats = useMemo(() => {
    if (metric === "price") {
      if (!activeChart?.candles || activeChart.candles.length === 0) return null;
      const candles = activeChart.candles;
      const current = candles[candles.length - 1].close;
      const first = candles[0].open;
      const high = Math.max(...candles.map((c) => c.high));
      const low = Math.min(...candles.map((c) => c.low));
      return { current, high, low, changePct: first ? ((current - first) / first) * 100 : 0 };
    }
    if (!chart?.candles || chart.candles.length === 0) return null;
    const values = marketCapSeries.map((p) => p.value);
    const current = values[values.length - 1];
    const first = values[0];
    return { current, high: Math.max(...values), low: Math.min(...values), changePct: first ? ((current - first) / first) * 100 : 0 };
  }, [chart, activeChart, metric, marketCapSeries]);

  const formatValue = metric === "price" ? (effectiveCurrency === "etn" ? formatEtnPrice : formatUsdPrice) : (v) => `$${formatCompact(v)}`;

  if (error) {
    return <div style={{ fontSize: 12, color: errorColor, padding: 16, textAlign: "center" }}>{error}</div>;
  }
  // Loading/no-data gating always reads off the USD chart — it's the one that's always fetched
  // (drives Market Cap and hasWetnPool regardless of the toggle), and both denominations come
  // from the same underlying pool/range so "no recent activity" is true for either one together.
  if (chart && !chart.hasData) {
    return (
      <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 24 }}>
        <div style={{ fontSize: 12, color: muted, textAlign: "center" }}>
          {chart.reason === "no_recent_activity"
            ? `No trades on ${chart.pool?.name || "ElectroSwap"} in the last ${range} days.`
            : "No ElectroSwap trading pair found for this token — no price chart available."}
        </div>
        {chart.reason === "no_recent_activity" && (
          <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 10 }}>
            {RANGES.filter((r) => r.id !== range).map((r) => (
              <Pill key={r.id} active={false} onClick={() => setRange(r.id)}>Try {r.label}</Pill>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 24 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted }}>
          {metric === "price" ? `Price${effectiveCurrency === "etn" ? " (ETN)" : ""}` : "Market Cap"}{chart?.pool ? ` · via ${chart.pool.name}` : ""}
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {METRICS.map((m) => (
              <Pill key={m.id} active={m.id === metric} onClick={() => setMetric(m.id)}>{m.label}</Pill>
            ))}
          </div>
          {metric === "price" && etnToggleReady && (
            <div style={{ display: "flex", gap: 6 }}>
              {CURRENCIES.map((c) => (
                <Pill key={c.id} active={c.id === currency} onClick={() => setCurrency(c.id)}>{c.label}</Pill>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            {RANGES.map((r) => (
              <Pill key={r.id} active={r.id === range} onClick={() => setRange(r.id)}>{r.label}</Pill>
            ))}
          </div>
        </div>
      </div>

      {effectiveCurrency === "etn" && wetnChart && !wetnChart.hasData ? (
        // Distinct from the generic "no pool"/"no recent activity" cases above (those are gated
        // on the USD chart, which already succeeded or this toggle wouldn't be showing at all) —
        // this is specifically the ETN-mode fetch having given up, after retries, usually on a
        // sustained rate limit. Without this, `stats` below would just stay null forever (no
        // candles to compute from) and the chart would show "Loading…" indefinitely instead of
        // telling the viewer what actually happened.
        <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted, textAlign: "center", padding: "0 16px" }}>
          {wetnRateLimited
            ? "Price data is temporarily rate-limited — try again in a moment, or switch back to USD."
            : "Couldn't load ETN-denominated pricing for this range — try again, or switch back to USD."}
        </div>
      ) : !stats ? (
        <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted }}>
          Loading…
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 10, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>Current</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatValue(stats.current)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>{range}D High</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatValue(stats.high)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>{range}D Low</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatValue(stats.low)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>{range}D Change</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: stats.changePct >= 0 ? green : errorColor }}>
                {stats.changePct >= 0 ? "+" : ""}{stats.changePct.toFixed(2)}%
              </div>
            </div>
          </div>

          {metric === "price" ? (
            <CandlestickChart candles={activeChart.candles} volume={volumeSeries} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
          ) : (
            <SparklineChart data={marketCapSeries} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
          )}
        </>
      )}
    </div>
  );
}
