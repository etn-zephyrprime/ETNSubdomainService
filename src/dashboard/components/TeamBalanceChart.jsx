import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { green, error as errorColor, muted, panel2, border } from "../theme.js";
import TokenLogo from "./TokenLogo.jsx";
import { useTeamWalletsBalanceHistory } from "../hooks/useTeamWalletsBalanceHistory.js";
import { formatChartDate } from "../utils/format.js";
import SparklineChart from "./SparklineChart.jsx";

// Rolling ~12-month chart of the combined ETN balance across every known Electroneum team wallet
// — backed entirely by backend/utils/teamWalletsBalanceHistory.js's R2-published series (real
// historical balances, walked from Blockscout's own per-event ledger; see that file's own header
// comment). Same current/high/low/change stat-row + SparklineChart layout as EtnPriceChart.jsx's
// long-range view, just for one fixed window (no range toggle — the published series already IS
// the requested 12-month window, nothing to pick between).
export default function TeamBalanceChart() {
  const { getBalanceHistory } = useTeamWalletsBalanceHistory();

  const [series, setSeries] = useState(null); // null = loading, [] = loaded but empty
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getBalanceHistory()
      .then((res) => { if (!cancelled) setSeries(res); })
      .catch((err) => {
        console.error("Failed to load team wallets balance history:", err);
        if (!cancelled) setError("Couldn't load balance history — try again shortly.");
      });
    return () => { cancelled = true; };
  }, [getBalanceHistory]);

  const chartData = useMemo(() => {
    if (!Array.isArray(series)) return [];
    return series
      .map((p) => {
        let value;
        try {
          value = parseFloat(ethers.formatEther(p.totalBalance));
        } catch {
          value = null;
        }
        return { label: p.date, value: Number.isFinite(value) ? value : null };
      })
      .filter((p) => p.value !== null);
  }, [series]);

  const stats = useMemo(() => {
    if (chartData.length === 0) return null;
    const values = chartData.map((p) => p.value);
    const current = values[values.length - 1];
    const first = values[0];
    return {
      current,
      high: Math.max(...values),
      low: Math.min(...values),
      changePct: first ? ((current - first) / first) * 100 : 0,
    };
  }, [chartData]);

  const formatValue = (v) => `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETN`;

  return (
    <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 24 }}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 14 }}>
        <TokenLogo address="NATIVE" label="ETN" size={16} spacing={7} />Combined ETN Balance — Rolling 12 Months
      </div>

      {error ? (
        <div style={{ fontSize: 12, color: errorColor, textAlign: "center", padding: 24 }}>{error}</div>
      ) : !stats ? (
        <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted }}>
          {series === null ? "Loading…" : "No balance history available yet."}
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 10, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>Current</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatValue(stats.current)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>12M High</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatValue(stats.high)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>12M Low</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatValue(stats.low)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>12M Change</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: stats.changePct >= 0 ? green : errorColor }}>
                {stats.changePct >= 0 ? "+" : ""}{stats.changePct.toFixed(2)}%
              </div>
            </div>
          </div>

          <SparklineChart data={chartData} height={140} formatValue={formatValue} formatLabel={formatChartDate} />
        </>
      )}
    </div>
  );
}
