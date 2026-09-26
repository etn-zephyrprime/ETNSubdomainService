import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { green, error as errorColor, muted, panel2, border, monoFont } from "../theme.js";
import TokenLogo from "./TokenLogo.jsx";
import { useTeamWalletsBalanceHistory } from "../hooks/useTeamWalletsBalanceHistory.js";
import { formatChartDate, formatEtnShort, shortHash } from "../utils/format.js";
import SparklineChart from "./SparklineChart.jsx";
import CornerBrackets from "./CornerBrackets.jsx";

// Rolling ~12-month chart of the combined ETN balance across every known Electroneum team wallet
// — backed entirely by backend/utils/teamWalletsBalanceHistory.js's R2-published series (real
// historical balances, walked from Blockscout's own per-event ledger; see that file's own header
// comment). Same current/high/low/change stat-row + SparklineChart layout as EtnPriceChart.jsx's
// long-range view, just for one fixed window (no range toggle — the published series already IS
// the requested 12-month window, nothing to pick between).
export default function TeamBalanceChart({ wallets = null }) {
  const { getBalanceHistory } = useTeamWalletsBalanceHistory();

  const [series, setSeries] = useState(null); // null = loading, [] = loaded but empty
  const [walletSeries, setWalletSeries] = useState({}); // lowercased address -> whole-ETN balance per day, aligned to `series`
  const [selected, setSelected] = useState("all");
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getBalanceHistory()
      .then((res) => { if (!cancelled) { setSeries(res.series); setWalletSeries(res.wallets || {}); } })
      .catch((err) => {
        console.error("Failed to load team wallets balance history:", err);
        if (!cancelled) setError("Couldn't load balance history — try again shortly.");
      });
    return () => { cancelled = true; };
  }, [getBalanceHistory]);

  const chartData = useMemo(() => {
    if (!Array.isArray(series)) return [];
    const perWallet = selected !== "all" ? walletSeries[selected] : null;
    return series
      .map((p, i) => {
        let value;
        try {
          value = perWallet ? perWallet[i] : parseFloat(ethers.formatEther(p.totalBalance));
        } catch {
          value = null;
        }
        return { label: p.date, value: Number.isFinite(value) ? value : null };
      })
      .filter((p) => p.value !== null);
  }, [series, walletSeries, selected]);

  // Filter options: every wallet the published series carries, largest current balance first. Empty until the
  // backend has republished with per-wallet data, in which case the dropdown just doesn't show.
  const walletOptions = useMemo(() => {
    const ens = new Map((wallets || []).map((w) => [w.address.toLowerCase(), w.ensName]));
    return Object.entries(walletSeries)
      .map(([address, values]) => ({ address, current: values[values.length - 1] ?? 0, label: ens.get(address) || shortHash(address) }))
      .sort((a, b) => b.current - a.current);
  }, [walletSeries, wallets]);

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

  const formatValue = (v) => `${formatEtnShort(v)} ETN`;

  return (
    <div style={{ position: "relative", padding: 16, borderRadius: 4, background: panel2, border: `1px solid ${border}`, marginBottom: 24 }}>
      <CornerBrackets color={green} />
      <div style={{ fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 14 }}>
        <TokenLogo address="NATIVE" label="ETN" size={16} spacing={7} />{selected === "all" ? "Combined ETN Balance" : "ETN Balance"} — Rolling 12 Months
      </div>

      {walletOptions.length > 0 && (
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="Filter by wallet"
          style={{ width: "100%", maxWidth: 360, marginBottom: 14, padding: "8px 12px", borderRadius: 6, border: `1px solid ${border}`, background: "#0b0b0b", color: "#fff", fontFamily: monoFont, fontSize: 12, fontWeight: 600, outline: "none" }}
        >
          <option value="all">All team wallets</option>
          {walletOptions.map((w) => (
            <option key={w.address} value={w.address}>{w.label} — {formatEtnShort(w.current)} ETN</option>
          ))}
        </select>
      )}

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
              <div style={{ fontFamily: monoFont, fontSize: 10, color: muted, textTransform: "uppercase" }}>Current</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatValue(stats.current)}</div>
            </div>
            <div>
              <div style={{ fontFamily: monoFont, fontSize: 10, color: muted, textTransform: "uppercase" }}>12M High</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatValue(stats.high)}</div>
            </div>
            <div>
              <div style={{ fontFamily: monoFont, fontSize: 10, color: muted, textTransform: "uppercase" }}>12M Low</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatValue(stats.low)}</div>
            </div>
            <div>
              <div style={{ fontFamily: monoFont, fontSize: 10, color: muted, textTransform: "uppercase" }}>12M Change</div>
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
