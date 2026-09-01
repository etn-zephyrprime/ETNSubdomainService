import React, { useEffect, useMemo, useState } from "react";
import { green, error as errorColor, mutedLight, muted, panel2, border } from "../theme.js";
import { useCoinGecko } from "../hooks/useCoinGecko.js";
import { useEtnPriceHistory } from "../hooks/useEtnPriceHistory.js";
import { formatUsdPrice, formatCompact, formatChartDate } from "../utils/format.js";
import SparklineChart from "./SparklineChart.jsx";
import CandlestickChart, { alignVolumeToCandles } from "./CandlestickChart.jsx";

// 7D/30D/90D stay on live CoinGecko OHLC (real open/high/low/volume, comfortably within its free
// 365-day cap). 1Y/All are backed by this app's own price_points cache instead (see
// tokenChartRouter.js's /etn-price-history) — daily close only, no OHLC/volume, which is why
// they're rendered as a line chart rather than candles, same as the Market Cap toggle already is.
const RANGES = [
  { id: "7", label: "7D", days: 7 },
  { id: "30", label: "30D", days: 30 },
  { id: "90", label: "90D", days: 90 },
  { id: "1y", label: "1Y", longRange: true },
  { id: "all", label: "All", longRange: true },
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
// ever non-null). Price is real green/red OHLC candles (CandlestickChart.jsx) with volume bars
// underneath (CoinGecko's total_volumes, aligned to each candle's own time window — a different,
// finer granularity than the candles themselves, see alignVolumeToCandles()); Market Cap has no
// meaningful "candle" concept (nothing trades market cap directly), so that toggle stays a plain
// line/area chart.
export default function EtnPriceChart() {
  const { getMarketChart, getOhlc } = useCoinGecko();
  const { getEtnPriceHistory } = useEtnPriceHistory();

  const [range, setRange] = useState("30");
  const [metric, setMetric] = useState("price");
  const [chartData, setChartData] = useState(null);
  const [ohlc, setOhlc] = useState(null);
  const [longRangePoints, setLongRangePoints] = useState(null);
  const [error, setError] = useState(null);

  const rangeConfig = RANGES.find((r) => r.id === range);
  const isLongRange = rangeConfig.longRange === true;

  // Long range (1Y/All) forces the Price metric — there's no long-range market cap series backed
  // by price_points (it only ever stores a price, see pnlPricing.js), so Market Cap wouldn't have
  // anything to show.
  useEffect(() => {
    if (isLongRange && metric !== "price") setMetric("price");
  }, [isLongRange, metric]);

  useEffect(() => {
    let cancelled = false;
    setChartData(null);
    setOhlc(null);
    setLongRangePoints(null);
    setError(null);

    if (isLongRange) {
      getEtnPriceHistory(range)
        .then((res) => {
          if (cancelled) return;
          setLongRangePoints(res.points || []);
        })
        .catch((err) => {
          console.error("Failed to load long-range ETN price history:", err);
          if (!cancelled) setError("Couldn't load ETN price history — try again shortly.");
        });
      return () => { cancelled = true; };
    }

    const days = rangeConfig.days;
    Promise.all([getMarketChart(days), getOhlc(days)])
      .then(([marketRes, ohlcRes]) => {
        if (cancelled) return;
        setChartData(marketRes);
        setOhlc(ohlcRes);
      })
      .catch((err) => {
        console.error("Failed to load ETN price history:", err);
        if (!cancelled) setError("Couldn't load ETN price history — try again shortly.");
      });
    return () => { cancelled = true; };
  }, [range, isLongRange, rangeConfig, getMarketChart, getOhlc, getEtnPriceHistory]);

  const candles = useMemo(() => {
    if (!Array.isArray(ohlc)) return null;
    return ohlc.map(([ms, open, high, low, close]) => ({
      label: new Date(ms).toISOString(),
      timeMs: ms,
      open,
      high,
      low,
      close,
    }));
  }, [ohlc]);

  const volume = useMemo(() => {
    if (!candles || !chartData?.total_volumes) return null;
    return alignVolumeToCandles(candles, chartData.total_volumes);
  }, [candles, chartData]);

  const marketCapSeries = useMemo(() => {
    if (!chartData?.market_caps) return [];
    return chartData.market_caps.map(([ms, value]) => ({ label: new Date(ms).toISOString(), value }));
  }, [chartData]);

  // price_points rows are already oldest-first (see getPricePointsSince) with real ISO timestamps.
  const longRangeSeries = useMemo(() => {
    if (!Array.isArray(longRangePoints)) return [];
    return longRangePoints.map((p) => ({ label: p.timestamp, value: p.priceUsd }));
  }, [longRangePoints]);

  const stats = useMemo(() => {
    if (isLongRange) {
      if (longRangeSeries.length === 0) return null;
      const values = longRangeSeries.map((p) => p.value);
      const current = values[values.length - 1];
      const first = values[0];
      return { current, high: Math.max(...values), low: Math.min(...values), changePct: first ? ((current - first) / first) * 100 : 0 };
    }
    if (metric === "price") {
      if (!candles || candles.length === 0) return null;
      const current = candles[candles.length - 1].close;
      const first = candles[0].open;
      const high = Math.max(...candles.map((c) => c.high));
      const low = Math.min(...candles.map((c) => c.low));
      const changePct = first ? ((current - first) / first) * 100 : 0;
      return { current, high, low, changePct };
    }
    if (marketCapSeries.length === 0) return null;
    const values = marketCapSeries.map((p) => p.value);
    const current = values[values.length - 1];
    const first = values[0];
    return { current, high: Math.max(...values), low: Math.min(...values), changePct: first ? ((current - first) / first) * 100 : 0 };
  }, [isLongRange, metric, candles, marketCapSeries, longRangeSeries]);

  const formatValue = isLongRange || metric === "price" ? formatUsdPrice : (v) => `$${formatCompact(v)}`;

  return (
    <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 24 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted }}>
          ETN {isLongRange || metric === "price" ? "Price" : "Market Cap"}
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          {!isLongRange && (
            <div style={{ display: "flex", gap: 6 }}>
              {METRICS.map((m) => (
                <Pill key={m.id} active={m.id === metric} onClick={() => setMetric(m.id)}>{m.label}</Pill>
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
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>{rangeConfig.label} High</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatValue(stats.high)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>{rangeConfig.label} Low</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatValue(stats.low)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>{rangeConfig.label} Change</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: stats.changePct >= 0 ? green : errorColor }}>
                {stats.changePct >= 0 ? "+" : ""}{stats.changePct.toFixed(2)}%
              </div>
            </div>
          </div>

          {isLongRange ? (
            <SparklineChart data={longRangeSeries} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
          ) : metric === "price" ? (
            <CandlestickChart candles={candles} volume={volume} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
          ) : (
            <SparklineChart data={marketCapSeries} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
          )}
        </>
      )}
    </div>
  );
}
