import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { green, error as errorColor, mutedLight, muted, panel2, border } from "../theme.js";
import { useTokenChart } from "../hooks/useTokenChart.js";
import { formatUsdPrice, formatCompact, formatChartDate } from "../utils/format.js";
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
  const [chart, setChart] = useState(null); // { hasData, candles?, pool? }
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setChart(null);
    setError(null);
    getTokenChart(address, range)
      .then((res) => { if (!cancelled) setChart(res); })
      .catch((err) => {
        console.error("Failed to load token chart:", err);
        if (!cancelled) setError(err.message || "Couldn't load chart data — try again shortly.");
      });
    return () => { cancelled = true; };
  }, [address, range, getTokenChart]);

  const supplyFloat = useMemo(() => {
    try {
      return parseFloat(ethers.formatUnits(totalSupply || "0", decimals == null ? 18 : Number(decimals)));
    } catch {
      return 0;
    }
  }, [totalSupply, decimals]);

  const volumeSeries = useMemo(() => {
    if (!chart?.candles) return null;
    return chart.candles.map((c) => ({ label: c.label, value: c.volumeUsd || 0 }));
  }, [chart]);

  const marketCapSeries = useMemo(() => {
    if (!chart?.candles || !supplyFloat) return [];
    return chart.candles.map((c) => ({ label: c.label, value: c.close * supplyFloat }));
  }, [chart, supplyFloat]);

  const stats = useMemo(() => {
    if (!chart?.candles || chart.candles.length === 0) return null;
    const candles = chart.candles;
    if (metric === "price") {
      const current = candles[candles.length - 1].close;
      const first = candles[0].open;
      const high = Math.max(...candles.map((c) => c.high));
      const low = Math.min(...candles.map((c) => c.low));
      return { current, high, low, changePct: first ? ((current - first) / first) * 100 : 0 };
    }
    const values = marketCapSeries.map((p) => p.value);
    const current = values[values.length - 1];
    const first = values[0];
    return { current, high: Math.max(...values), low: Math.min(...values), changePct: first ? ((current - first) / first) * 100 : 0 };
  }, [chart, metric, marketCapSeries]);

  const formatValue = metric === "price" ? formatUsdPrice : (v) => `$${formatCompact(v)}`;

  if (error) {
    return <div style={{ fontSize: 12, color: errorColor, padding: 16, textAlign: "center" }}>{error}</div>;
  }
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
          {metric === "price" ? "Price" : "Market Cap"}{chart?.pool ? ` · via ${chart.pool.name}` : ""}
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ display: "flex", gap: 6 }}>
            {METRICS.map((m) => (
              <Pill key={m.id} active={m.id === metric} onClick={() => setMetric(m.id)}>{m.label}</Pill>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {RANGES.map((r) => (
              <Pill key={r.id} active={r.id === range} onClick={() => setRange(r.id)}>{r.label}</Pill>
            ))}
          </div>
        </div>
      </div>

      {!stats ? (
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
            <CandlestickChart candles={chart.candles} volume={volumeSeries} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
          ) : (
            <SparklineChart data={marketCapSeries} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
          )}
        </>
      )}
    </div>
  );
}
