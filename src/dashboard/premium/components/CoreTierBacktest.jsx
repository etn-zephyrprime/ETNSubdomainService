import React, { useEffect, useMemo, useState } from "react";
import DashboardButton from "./DashboardButton.jsx";
import SparklineChart from "../../components/SparklineChart.jsx";
import { useScenarios } from "../../hooks/useScenarios.js";
import { formatUsdPrice, formatChartDate, formatUsdPricePrecise } from "../../utils/format.js";
import { muted, mutedLight, border, error as errorColor, monoFont } from "../../theme.js";
import { AUTH_PURPOSE, inputStyle, labelStyle, toggleStyle, etnFmt, signed, tokenFmt, ResultCard, Hero, Kpi, KpiRow, Callout, Details, AssumptionsStrip, Intro, usdShort, toneFor, pctText } from "./ScenarioBits.jsx";

const yearAgo = () => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
};
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
    } catch (err) {
      setResult(null);
      setError(err.message || "Couldn't run the backtest");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Intro>What a past purchase — once, or every week or month — would be worth today, against simply holding ETN.</Intro>
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
      {result && <BacktestResult r={result} series={series} setSeries={setSeries} />}
    </div>
  );
}

export function BacktestResult({ r, series, setSeries }) {
  const t = r.totals;
  const cov = r.coverage;
  const chartData = useMemo(() => r.chart.map((p) => ({ label: p.date, value: p[series] })), [r, series]);
  const isEtn = r.symbol === "ETN";
  const vsEtn = isEtn ? null : t.returnPct - r.benchmarks.holdEtn.returnPct;
  const title = r.mode === "lump" ? `${r.symbol} bought ${r.window.start}` : `${r.symbol} every ${r.mode === "weekly" ? "week" : "month"} since ${r.window.start}`;
  const gapsMatter = cov.days > 0 && (cov.carriedDays / cov.days > 0.1 || cov.longestCarried > 7);
  const anyTax = r.buys.some((b) => b.taxBps > 0);

  return (
    <ResultCard>
      <Hero label={`${title} · ${r.buys.length} purchase${r.buys.length === 1 ? "" : "s"}`} from={usdShort(t.costUsd)} value={usdShort(t.valueUsd)} pct={t.returnPct} tone={toneFor(t.returnUsd)} sub={`${signed(t.returnUsd, usdShort)} · today's value`} />
      <KpiRow>
        <Kpi label="In ETN terms" value={pctText(t.returnEtnPct)} sub={`${etnFmt(t.costEtn)} → ${etnFmt(t.valueEtn)}`} tone={toneFor(t.returnEtn)} tooltip="What the purchases cost in ETN at the time, against what the position is worth in ETN now." />
        {!isEtn && <Kpi label="vs holding ETN" value={vsEtn == null ? "—" : `${vsEtn >= 0 ? "+" : "−"}${Math.abs(vsEtn).toFixed(1)} pts`} sub={`ETN instead: ${pctText(r.benchmarks.holdEtn.returnPct)}`} tone={toneFor(vsEtn)} tooltip="The same dollars spent on ETN on the same days." />}
        <Kpi label="Average cost" value={formatUsdPricePrecise(t.avgCostUsd)} sub={`${tokenFmt(t.tokens)} ${r.symbol}`} />
      </KpiRow>

      <div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {CHART_SERIES.filter((s) => !(isEtn && s.id === "etnHoldUsd")).map((s) => (
            <button key={s.id} type="button" onClick={() => setSeries(s.id)} style={{ ...toggleStyle(series === s.id), fontSize: 10, padding: "3px 10px" }}>{s.label}</button>
          ))}
        </div>
        <SparklineChart data={chartData} height={170} formatValue={(v) => formatUsdPrice(v)} formatLabel={formatChartDate} />
      </div>

      {r.liquidity?.lowLiquidity && (
        <Callout>
          {r.symbol} is thin — selling this position today would move the price {r.liquidity.sellImpactPct != null ? `~${r.liquidity.sellImpactPct.toFixed(1)}%` : "an unknown amount"}. Past buys assume no price impact, so real results would be lower.
        </Callout>
      )}
      {gapsMatter && <Callout tone="info">{cov.carriedDays} of {cov.days} days had no trades and reuse the previous price (longest gap {cov.longestCarried} days).</Callout>}
      {r.notes.map((n) => (
        <Callout key={n} tone="info">{n}</Callout>
      ))}

      {r.buys.length > 1 && (
        <Details label={`All ${r.buys.length} purchases`}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: mutedLight, minWidth: 420 }}>
              <thead>
                <tr style={{ textAlign: "right", color: muted, fontFamily: monoFont, fontSize: 10 }}>
                  <th style={{ textAlign: "left", padding: "4px 6px" }}>Date</th>
                  <th style={{ padding: "4px 6px" }}>Price</th>
                  <th style={{ padding: "4px 6px" }}>Spent</th>
                  <th style={{ padding: "4px 6px" }}>Received</th>
                  {anyTax && <th style={{ padding: "4px 6px" }}>Buy tax</th>}
                </tr>
              </thead>
              <tbody>
                {r.buys.map((b) => (
                  <tr key={b.date} style={{ textAlign: "right", borderTop: `1px solid ${border}` }}>
                    <td style={{ textAlign: "left", padding: "4px 6px" }}>{b.date}</td>
                    <td style={{ padding: "4px 6px" }}>{formatUsdPricePrecise(b.priceUsd)}</td>
                    <td style={{ padding: "4px 6px" }}>{formatUsdPrice(b.costUsd)}</td>
                    <td style={{ padding: "4px 6px" }}>{tokenFmt(b.tokens)}</td>
                    {anyTax && <td style={{ padding: "4px 6px" }}>{(b.taxBps / 100).toFixed(2)}%</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Details>
      )}
      <AssumptionsStrip
        assumptions={r.assumptions}
        facts={[`Data from ${cov.earliest}`, `${cov.carriedDays} gap day${cov.carriedDays === 1 ? "" : "s"}`, anyTax ? "Buy tax at each date" : null, "No price impact"]}
      />
    </ResultCard>
  );
}
