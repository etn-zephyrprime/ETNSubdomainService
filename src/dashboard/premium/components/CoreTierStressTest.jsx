import React, { useState } from "react";
import DashboardButton from "./DashboardButton.jsx";
import InfoTooltip from "../../components/InfoTooltip.jsx";
import { useScenarios } from "../../hooks/useScenarios.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { formatUsdPrice } from "../../utils/format.js";
import { muted, mutedLight, border, error as errorColor, monoFont } from "../../theme.js";
import {
  AUTH_PURPOSE,
  inputStyle,
  labelStyle,
  chipStyle,
  ResultCard,
  Hero,
  Kpi,
  KpiRow,
  Eyebrow,
  BarList,
  Callout,
  Details,
  AssumptionsStrip,
  Intro,
  usdShort,
  etnFmt,
  signed,
  toneFor,
  pctText,
} from "./ScenarioBits.jsx";

const PRESETS = [
  { label: "ETN −30%", etn: "-30", all: "0" },
  { label: "ETN −50%", etn: "-50", all: "0" },
  { label: "Alts −50% vs ETN", etn: "0", all: "-50" },
  { label: "ETN +50%", etn: "50", all: "0" },
  { label: "Reset", etn: "0", all: "0" },
];
const KIND_LABELS = { token: "token", lp: "liquidity", farm: "farm", staking: "staking", v3: "V3" };
const pctOf = (from, to) => (from > 0 ? ((to - from) / from) * 100 : null);

/** Scenarios — Tool 1, portfolio stress test (backend/services/scenarioStressTest.js). */
export default function CoreTierStressTest({ wallet, getAuthParams, active }) {
  const { runStressTest } = useScenarios();
  const { resolve: resolveWalletName } = useDisplayNames(active.map((w) => w.address));
  const [scope, setScope] = useState("all");
  const [etnPct, setEtnPct] = useState("-30");
  const [allPct, setAllPct] = useState("0");
  const [tokenPct, setTokenPct] = useState({}); // token -> string
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const run = async () => {
    setError(null);
    setRunning(true);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const overrides = Object.fromEntries(Object.entries(tokenPct).filter(([, v]) => v !== "" && v != null));
      setResult(await runStressTest(wallet.account, signature, timestamp, { scope, shocks: { etnPct, allTokensPct: allPct, tokenPct: overrides } }));
    } catch (err) {
      setError(err.message || "Couldn't run the stress test");
    } finally {
      setRunning(false);
    }
  };

  const shockableTokens = (result?.tokens || []).filter((t) => !t.pegged && !t.native);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Intro>See what your portfolio is worth if prices move — liquidity and farm positions included.</Intro>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <label style={labelStyle}>Wallets</label>
          <select value={scope} onChange={(e) => setScope(e.target.value)} style={inputStyle}>
            <option value="all">All tracked wallets</option>
            {active.map((w) => (
              <option key={w.address} value={w.address}>{resolveWalletName(w.address)}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: "1 1 130px", minWidth: 0 }}>
          <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 4 }}>
            ETN vs USD % <InfoTooltip text="Moves ETN's dollar price. Tokens priced in ETN follow it, so a token flat against ETN still falls in dollars when ETN does. USD stablecoins stay at $1." />
          </label>
          <input type="number" step="any" value={etnPct} onChange={(e) => setEtnPct(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ flex: "1 1 130px", minWidth: 0 }}>
          <label style={labelStyle}>Tokens vs ETN %</label>
          <input type="number" step="any" value={allPct} onChange={(e) => setAllPct(e.target.value)} style={inputStyle} />
        </div>
        <DashboardButton onClick={run} disabled={running || active.length === 0} style={{ padding: "10px 18px", fontSize: 12 }}>
          {running ? "Running…" : "Run"}
        </DashboardButton>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {PRESETS.map((p) => (
          <button key={p.label} type="button" style={chipStyle} onClick={() => { setEtnPct(p.etn); setAllPct(p.all); if (p.label === "Reset") setTokenPct({}); }}>
            {p.label}
          </button>
        ))}
      </div>
      {shockableTokens.length > 0 && (
        <Details label="Shock individual tokens">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {shockableTokens.map((t) => (
              <label key={t.token} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: mutedLight }}>
                {t.symbol}
                <input
                  type="number"
                  step="any"
                  placeholder={allPct || "0"}
                  value={tokenPct[t.token] ?? ""}
                  onChange={(e) => setTokenPct((m) => ({ ...m, [t.token]: e.target.value }))}
                  style={{ ...inputStyle, width: 74, padding: "6px 8px", fontSize: 12 }}
                />
              </label>
            ))}
          </div>
        </Details>
      )}

      {error && <div style={{ fontSize: 12, color: errorColor }}>{error}</div>}
      {result && <StressResult result={result} resolveWalletName={resolveWalletName} />}
    </div>
  );
}

export function StressResult({ result, resolveWalletName }) {
  const baseUsd = Number(result.baseline.usd);
  const scenUsd = Number(result.scenario.usd);
  const before = Number(result.unrealized.beforeUsd);
  const after = Number(result.unrealized.afterUsd);
  const pendBase = Number(result.pendingRewards.baselineUsd);
  const pendScen = Number(result.pendingRewards.scenarioUsd);
  const movers = result.rows.filter((r) => Math.abs(Number(r.deltaUsd)) > 0.005).slice(0, 8);
  const s = result.shocks;
  const shockLabel = [s.etnPct ? `ETN ${s.etnPct > 0 ? "+" : ""}${s.etnPct}%` : null, s.allTokensPct ? `tokens ${s.allTokensPct > 0 ? "+" : ""}${s.allTokensPct}% vs ETN` : null, Object.keys(s.tokenPct || {}).length ? `${Object.keys(s.tokenPct).length} custom` : null].filter(Boolean).join(" · ") || "no change";
  const baselineDiff = Math.abs(Number(result.baselineCheck.diffUsd));

  return (
    <ResultCard>
      <Hero label={`Portfolio value · ${shockLabel}`} from={usdShort(baseUsd)} value={usdShort(scenUsd)} pct={pctOf(baseUsd, scenUsd)} sub={`${signed(scenUsd - baseUsd, formatUsdPrice)} vs today`} tone={toneFor(scenUsd - baseUsd)} />
      <KpiRow>
        <Kpi label="In ETN" value={etnFmt(Number(result.scenario.etn))} sub={`${pctText(pctOf(Number(result.baseline.etn), Number(result.scenario.etn)))} vs today`} tone={toneFor(Number(result.change.etn))} tooltip="The same holdings measured in ETN. A USD move and an ETN move are different signals." />
        <Kpi label="Unrealized P&L" value={signed(after, usdShort)} sub={`today ${signed(before, usdShort)}`} tone={toneFor(after)} tooltip="Value minus what the holdings cost you (FIFO). Realized P&L doesn't change — nothing is sold." />
        {pendBase > 0 && <Kpi label="Pending rewards" value={usdShort(pendScen)} sub={`today ${usdShort(pendBase)} · not in value`} tooltip="Unclaimed farm rewards and fees — not part of Current Value, repriced the same way." />}
      </KpiRow>

      {movers.length > 0 && (
        <div>
          <Eyebrow>What moves it</Eyebrow>
          <BarList
            rows={movers.map((r) => ({ key: `${r.key}${r.wallet || ""}`, label: r.label, tag: KIND_LABELS[r.kind], value: Number(r.deltaUsd) }))}
            format={(v) => signed(v, usdShort)}
          />
        </div>
      )}

      {result.assumptions.v3Approximation && <Callout>{result.assumptions.v3Approximation}</Callout>}
      {baselineDiff > 0.01 && <Callout>Prices moved while this ran ({formatUsdPrice(baselineDiff)} off your live value) — run it again for an exact baseline.</Callout>}

      <Details label={`All holdings (${result.rows.length})${result.unpriced.count ? ` · ${result.unpriced.count} unpriced` : ""}`}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: mutedLight, minWidth: 480 }}>
            <thead>
              <tr style={{ textAlign: "right", color: muted, fontFamily: monoFont, fontSize: 10 }}>
                <th style={{ textAlign: "left", padding: "4px 6px" }}>Holding</th>
                <th style={{ padding: "4px 6px" }}>Today</th>
                <th style={{ padding: "4px 6px" }}>Scenario</th>
                <th style={{ padding: "4px 6px" }}>Price move</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r, i) => (
                <tr key={`${r.key}-${i}`} style={{ textAlign: "right", borderTop: `1px solid ${border}` }}>
                  <td style={{ textAlign: "left", padding: "4px 6px" }}>
                    <span style={{ color: "#fff" }}>{r.label}</span> <span style={{ color: muted, fontSize: 10 }}>{KIND_LABELS[r.kind]}</span>
                    {r.wallet && <span style={{ display: "block", fontSize: 10, color: muted }}>{resolveWalletName(r.wallet)}</span>}
                  </td>
                  <td style={{ padding: "4px 6px" }}>{formatUsdPrice(Number(r.baselineUsd))}</td>
                  <td style={{ padding: "4px 6px" }}>{formatUsdPrice(Number(r.scenarioUsd))}</td>
                  <td style={{ padding: "4px 6px" }}>{`${r.factor >= 1 ? "+" : "−"}${Math.abs((r.factor - 1) * 100).toFixed(1)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {result.unpriced.count > 0 && <div style={{ fontSize: 11, color: muted, marginTop: 6 }}>No price, excluded: {result.unpriced.items.map((u) => u.symbol).join(", ")}</div>}
      </Details>

      <AssumptionsStrip assumptions={result.assumptions} facts={[`Stablecoins held at $1`, "LP/farms on the pool curve", "Realized P&L unchanged"]} />
    </ResultCard>
  );
}
