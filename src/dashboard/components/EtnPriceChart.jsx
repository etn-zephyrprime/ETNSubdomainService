import React, { useEffect, useMemo, useState } from "react";
import { green, error as errorColor, mutedLight, muted, panel2, border } from "../theme.js";
import { useCoinGecko } from "../hooks/useCoinGecko.js";
import { formatUsdPrice, formatCompact, formatChartDate } from "../utils/format.js";
import SparklineChart from "./SparklineChart.jsx";

const RANGES = [
  { id: "7", label: "7D", days: 7 },
  { id: "30", label: "30D", days: 30 },
  { id: "90", label: "90D", days: 90 },
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

// ETN price + basic "chart analysis" (current/high/low/change over the shown range) — via
// CoinGecko directly (useCoinGecko.js), not Blockscout's own /stats/charts/market, whose
// closing_price field is mostly empty on this deployment (confirmed: only the most recent day is
// ever non-null). market_chart's response already includes both prices and market_caps in one
// call, so the metric toggle below doesn't need a second request.
export default function EtnPriceChart() {
  const { getMarketChart } = useCoinGecko();

  const [range, setRange] = useState("30");
  const [metric, setMetric] = useState("price");
  const [chartData, setChartData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setChartData(null);
    setError(null);
    const days = RANGES.find((r) => r.id === range).days;
    getMarketChart(days)
      .then((res) => { if (!cancelled) setChartData(res); })
      .catch((err) => {
        console.error("Failed to load ETN price history:", err);
        if (!cancelled) setError("Couldn't load ETN price history — try again shortly.");
      });
    return () => { cancelled = true; };
  }, [range, getMarketChart]);

  const series = useMemo(() => {
    if (!chartData) return null;
    const source = metric === "price" ? chartData.prices : chartData.market_caps;
    if (!Array.isArray(source)) return [];
    return source.map(([ms, value]) => ({ label: new Date(ms).toISOString(), value }));
  }, [chartData, metric]);

  const stats = useMemo(() => {
    if (!series || series.length === 0) return null;
    const values = series.map((p) => p.value);
    const current = values[values.length - 1];
    const first = values[0];
    const high = Math.max(...values);
    const low = Math.min(...values);
    const changePct = first ? ((current - first) / first) * 100 : 0;
    return { current, high, low, changePct };
  }, [series]);

  const formatValue = metric === "price" ? formatUsdPrice : (v) => `$${formatCompact(v)}`;

  return (
    <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 24 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted }}>
          ETN {metric === "price" ? "Price" : "Market Cap"}
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

      {error ? (
        <div style={{ fontSize: 12, color: errorColor, textAlign: "center", padding: 24 }}>{error}</div>
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

          <SparklineChart data={series} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
        </>
      )}
    </div>
  );
}
