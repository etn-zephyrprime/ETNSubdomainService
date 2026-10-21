import React, { useEffect, useMemo, useState } from "react";
import DashboardButton from "./DashboardButton.jsx";
import SparklineChart from "../../components/SparklineChart.jsx";
import { useScenarios } from "../../hooks/useScenarios.js";
import { formatUsdPrice, formatChartDate, formatUsdPricePrecise } from "../../utils/format.js";
import { muted, mutedLight, orange, border, error as errorColor, monoFont } from "../../theme.js";
import { AUTH_PURPOSE, inputStyle, labelStyle, toggleStyle, Stat, Assumptions, etnFmt, colorOf, signed, tokenFmt } from "./ScenarioBits.jsx";

const yearAgo = () => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
};
const pctFmt = (n) => (n == null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`);
const CHART_SERIES = [
  { id: "valueUsd", label: "Your position" },
  { id: "etnHoldUsd", label: "Hold ETN instead" },
  { id: "investedUsd", label: "Money put in" },
];

/** Scenarios — Tool 5: historical backtest, lump sum or DCA (backend/services/scenarioBacktest.js).
 * A look back, not a recommendation — no rankings, no "top performers". */
export default function CoreTierBacktest({ wallet, getAuthParams }) {
  const { runBacktest, getBacktestTokens } = useScenarios();
  const [tokens, setTokens] = useState(null);
  const [asset, setAsset] = useState("ETN");
  const [mode, setMode] = useState("lump");
  const [amountType, setAmountType] = useState("usd");
  const [amount, setAmount] = useState("1000");
  const [start, setStart] = useState(yearAgo());
  const [end, setEnd] = useState("");
  const [series, setSeries] = useState("valueUsd");
  const [showBuys, setShowBuys] = useState(false);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    getBacktestTokens()
      .then((r) => setTokens(r.tokens || []))
      .catch(() => setTokens([{ asset: "ETN", symbol: "ETN" }]));
  }, [getBacktestTokens]);

  const symbol = tokens?.find((t) => t.asset === asset)?.symbol || "tokens";
  const run = async () => {
    setError(null);
    setRunning(true);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      setResult(await runBacktest(wallet.account, signature, timestamp, { asset, amountType, amount: Number(amount), start, end: end || undefined, mode }));
      setShowBuys(false);
    } catch (err) {
      setResult(null);
      setError(err.message || "Couldn't run the backtest");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 12, color: mutedLight, lineHeight: 1.6 }}>
        What a past purchase — once, or the same amount every week or month — would be worth today, against simply holding ETN or keeping the dollars. A look back at real prices, not a prediction.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setMode("lump")} style={toggleStyle(mode === "lump")}>One purchase</button>
        <button type="button" onClick={() => setMode("weekly")} style={toggleStyle(mode === "weekly")}>Every week</button>
        <button type="button" onClick={() => setMode("monthly")} style={toggleStyle(mode === "monthly")}>Every month</button>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 160px", minWidth: 0 }}>
          <label style={labelStyle}>Token</label>
          <select value={asset} onChange={(e) => setAsset(e.target.value)} disabled={!tokens} style={inputStyle}>
            {(tokens || [{ asset: "ETN", symbol: "ETN" }]).map((t) => (
              <option key={t.asset} value={t.asset}>{t.symbol}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: "1 1 160px", minWidth: 0 }}>
          <label style={labelStyle}>{mode === "lump" ? "Amount" : "Amount each time"}</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} style={inputStyle} />
            <select value={amountType} onChange={(e) => setAmountType(e.target.value)} style={{ ...inputStyle, width: 96 }}>
              <option value="usd">USD</option>
              <option value="etn">ETN</option>
              <option value="tokens">{symbol}</option>
            </select>
          </div>
        </div>
        <div style={{ flex: "1 1 140px", minWidth: 0 }}>
          <label style={labelStyle}>{mode === "lump" ? "Bought on" : "Starting"}</label>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ flex: "1 1 140px", minWidth: 0 }}>
          <label style={labelStyle}>Until (blank = today)</label>
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} style={inputStyle} />
        </div>
      </div>
      {error && <div style={{ fontSize: 12, color: errorColor }}>{error}</div>}
      <DashboardButton onClick={run} disabled={running} style={{ alignSelf: "flex-start", padding: "8px 16px", fontSize: 12 }}>
        {running ? "Running…" : "Run backtest"}
      </DashboardButton>
      {result && <BacktestResult r={result} series={series} setSeries={setSeries} showBuys={showBuys} setShowBuys={setShowBuys} />}
    </div>
  );
}

function BacktestResult({ r, series, setSeries, showBuys, setShowBuys }) {
  const t = r.totals;
  const cov = r.coverage;
  const chartData = useMemo(() => r.chart.map((p) => ({ label: p.date, value: p[series] })), [r, series]);
  const isEtn = r.symbol === "ETN";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 12, borderTop: `1px solid ${border}` }}>
      <div style={{ fontSize: 13, color: "#fff", fontWeight: 700 }}>
        {r.mode === "lump" ? `${r.symbol} bought ${r.window.start}` : `${r.symbol} bought ${r.mode === "weekly" ? "weekly" : "monthly"}, ${r.window.start} → ${r.window.end}`} · {r.buys.length} purchase{r.buys.length === 1 ? "" : "s"}
      </div>
      <div style={{ fontSize: 11, color: cov.carriedDays > 0 ? orange : mutedLight }}>
        Data coverage: {r.symbol} prices from {cov.earliest} · {cov.days} days in this window, {cov.carriedDays} without their own price (carried forward{cov.longestCarried > 1 ? `, longest ${cov.longestCarried} days` : ""})
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Stat label="Put in → worth now (USD)">
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{formatUsdPrice(t.costUsd)} → {formatUsdPrice(t.valueUsd)}</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: colorOf(t.returnUsd) }}>{signed(t.returnUsd, formatUsdPrice)} ({pctFmt(t.returnPct)})</div>
        </Stat>
        <Stat label="Put in → worth now (ETN)" tooltip="The same result measured in ETN: what the purchases cost in ETN at the time, against what the position is worth in ETN now.">
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{etnFmt(t.costEtn)} → {etnFmt(t.valueEtn)}</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: colorOf(t.returnEtn) }}>{signed(t.returnEtn, etnFmt)} ({pctFmt(t.returnEtnPct)})</div>
        </Stat>
        <Stat label="Compared with">
          {!isEtn && <div style={{ fontSize: 12, color: mutedLight }}>Holding ETN instead: <span style={{ color: colorOf(r.benchmarks.holdEtn.returnPct), fontWeight: 700 }}>{pctFmt(r.benchmarks.holdEtn.returnPct)}</span> ({formatUsdPrice(r.benchmarks.holdEtn.valueUsd)})</div>}
          <div style={{ fontSize: 12, color: mutedLight }}>Keeping the dollars: <span style={{ fontWeight: 700 }}>0.0%</span> ({formatUsdPrice(r.benchmarks.holdUsd.valueUsd)})</div>
          <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>
            {tokenFmt(t.tokens)} {r.symbol} at an average {formatUsdPricePrecise(t.avgCostUsd)}
          </div>
        </Stat>
      </div>

      <div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
          {CHART_SERIES.filter((s) => !(isEtn && s.id === "etnHoldUsd")).map((s) => (
            <button key={s.id} type="button" onClick={() => setSeries(s.id)} style={{ ...toggleStyle(series === s.id), fontSize: 10, padding: "3px 8px" }}>{s.label}</button>
          ))}
        </div>
        <SparklineChart data={chartData} height={120} formatValue={(v) => formatUsdPrice(v)} formatLabel={formatChartDate} />
      </div>

      {r.liquidity?.lowLiquidity && (
        <div style={{ fontSize: 12, color: orange, lineHeight: 1.6 }}>
          ⚠ {r.symbol} is thin: selling this position today would move its price {r.liquidity.sellImpactPct != null ? `about ${r.liquidity.sellImpactPct.toFixed(1)}%` : "by an unknown amount"}. These results assume every purchase filled at the day's price with no price impact, so they look better than a real trade would have.
        </div>
      )}
      {t.taxTokens > 0 && (
        <div style={{ fontSize: 11, color: mutedLight }}>
          Buy tax paid along the way: {tokenFmt(t.taxTokens)} {r.symbol}, at each purchase date's rate.
        </div>
      )}
      {r.notes.map((n) => (
        <div key={n} style={{ fontSize: 11, color: orange }}>⚠ {n}</div>
      ))}

      {r.buys.length > 1 && (
        <div>
          <button type="button" onClick={() => setShowBuys(!showBuys)} style={{ ...toggleStyle(false), fontSize: 10, padding: "3px 8px" }}>
            {showBuys ? "Hide purchases" : `Show all ${r.buys.length} purchases`}
          </button>
          {showBuys && (
            <div style={{ overflowX: "auto", marginTop: 6 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: mutedLight, minWidth: 460 }}>
                <thead>
                  <tr style={{ textAlign: "right", color: muted, fontFamily: monoFont, fontSize: 10 }}>
                    <th style={{ textAlign: "left", padding: "4px 6px" }}>Date</th>
                    <th style={{ padding: "4px 6px" }}>Price</th>
                    <th style={{ padding: "4px 6px" }}>Spent</th>
                    <th style={{ padding: "4px 6px" }}>Received</th>
                    {r.buys.some((b) => b.taxBps > 0) && <th style={{ padding: "4px 6px" }}>Buy tax</th>}
                  </tr>
                </thead>
                <tbody>
                  {r.buys.map((b) => (
                    <tr key={b.date} style={{ textAlign: "right", borderTop: `1px solid ${border}` }}>
                      <td style={{ textAlign: "left", padding: "4px 6px" }}>{b.date}</td>
                      <td style={{ padding: "4px 6px" }}>{formatUsdPricePrecise(b.priceUsd)}</td>
                      <td style={{ padding: "4px 6px" }}>{formatUsdPrice(b.costUsd)}</td>
                      <td style={{ padding: "4px 6px" }}>{tokenFmt(b.tokens)} {r.symbol}</td>
                      {r.buys.some((x) => x.taxBps > 0) && <td style={{ padding: "4px 6px" }}>{(b.taxBps / 100).toFixed(2)}%</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <Assumptions assumptions={r.assumptions} />
    </div>
  );
}
