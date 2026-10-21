import React, { useState } from "react";
import DashboardButton from "./DashboardButton.jsx";
import InfoTooltip from "../../components/InfoTooltip.jsx";
import { useScenarios } from "../../hooks/useScenarios.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { formatUsdPrice, formatEtnAmount } from "../../utils/format.js";
import { green, muted, mutedLight, orange, border, panel2, error as errorColor, monoFont } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";

const inputStyle = {
  padding: "10px 12px",
  borderRadius: 6,
  border: `1px solid ${border}`,
  background: panel2,
  color: "#fff",
  fontFamily: monoFont,
  fontSize: 13,
  fontWeight: 600,
  boxSizing: "border-box",
  outline: "none",
  width: "100%",
};
const labelStyle = { fontFamily: monoFont, fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 4, display: "block" };
const chipStyle = { background: "none", border: `1px solid ${border}`, borderRadius: 4, color: mutedLight, fontSize: 10, fontFamily: monoFont, padding: "3px 8px", cursor: "pointer" };
const statLabel = { fontFamily: monoFont, fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 4 };

const PRESETS = [
  { label: "ETN −30%", etn: "-30", all: "0" },
  { label: "Tokens −50% vs ETN", etn: "0", all: "-50" },
  { label: "ETN +50%", etn: "50", all: "0" },
  { label: "Reset", etn: "0", all: "0" },
];
const KIND_LABELS = { token: "Token", lp: "Liquidity", farm: "Farm", staking: "Staking", v3: "V3" };

const signed = (n, fmt) => `${n >= 0 ? "+" : "−"}${fmt(Math.abs(n))}`;
const pct = (n) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;
const etnFmt = (n) => `${formatEtnAmount(n)} ETN`;
const colorOf = (n) => (n > 0 ? green : n < 0 ? errorColor : mutedLight);

function Stat({ label, tooltip, children }) {
  return (
    <div style={{ flex: "1 1 180px", minWidth: 0, padding: "10px 12px", borderRadius: 6, border: `1px solid ${border}`, background: panel2 }}>
      <div style={{ ...statLabel, display: "flex", alignItems: "center", gap: 4 }}>
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </div>
      {children}
    </div>
  );
}

/** Scenarios — Tool 1, portfolio stress test (backend/services/scenarioStressTest.js). Hypothetical:
 * nothing is saved, and the assumptions it ran under are always shown with the result. */
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
  const [showAllRows, setShowAllRows] = useState(false);

  const run = async () => {
    setError(null);
    setRunning(true);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const overrides = Object.fromEntries(Object.entries(tokenPct).filter(([, v]) => v !== "" && v != null));
      setResult(await runStressTest(wallet.account, signature, timestamp, { scope, shocks: { etnPct, allTokensPct: allPct, tokenPct: overrides } }));
      setShowAllRows(false);
    } catch (err) {
      setError(err.message || "Couldn't run the stress test");
    } finally {
      setRunning(false);
    }
  };

  const shockableTokens = (result?.tokens || []).filter((t) => !t.pegged && !t.native);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 12, color: mutedLight, lineHeight: 1.6 }}>
        What your portfolio would be worth if prices moved. Token prices here are set in ETN pools, so there are two dials: ETN against the US dollar, and each token against ETN. A token flat against ETN still falls in dollars when ETN does. Liquidity and farm positions are revalued along the pool curve, so impermanent loss is included.
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <label style={labelStyle}>Wallets</label>
          <select value={scope} onChange={(e) => setScope(e.target.value)} style={inputStyle}>
            <option value="all">All tracked wallets</option>
            {active.map((w) => (
              <option key={w.address} value={w.address}>{resolveWalletName(w.address)}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: "1 1 140px", minWidth: 0 }}>
          <label style={labelStyle}>ETN vs USD (%)</label>
          <input type="number" step="any" value={etnPct} onChange={(e) => setEtnPct(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ flex: "1 1 140px", minWidth: 0 }}>
          <label style={labelStyle}>All tokens vs ETN (%)</label>
          <input type="number" step="any" value={allPct} onChange={(e) => setAllPct(e.target.value)} style={inputStyle} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 10, color: muted, fontFamily: monoFont }}>PRESETS</span>
        {PRESETS.map((p) => (
          <button key={p.label} type="button" style={chipStyle} onClick={() => { setEtnPct(p.etn); setAllPct(p.all); if (p.label === "Reset") setTokenPct({}); }}>
            {p.label}
          </button>
        ))}
      </div>

      {shockableTokens.length > 0 && (
        <div>
          <div style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 4 }}>
            Per-token vs ETN (%) <InfoTooltip text="Overrides the all-tokens figure for one token. Leave blank to use the all-tokens figure. USD-pegged tokens stay at $1 and ETN itself only follows the ETN vs USD dial." />
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {shockableTokens.map((t) => (
              <label key={t.token} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: mutedLight }}>
                {t.symbol}
                <input
                  type="number"
                  step="any"
                  placeholder={allPct || "0"}
                  value={tokenPct[t.token] ?? ""}
                  onChange={(e) => setTokenPct((m) => ({ ...m, [t.token]: e.target.value }))}
                  style={{ ...inputStyle, width: 80, padding: "6px 8px", fontSize: 12 }}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: errorColor }}>{error}</div>}
      <DashboardButton onClick={run} disabled={running || active.length === 0} style={{ alignSelf: "flex-start", padding: "8px 16px", fontSize: 12 }}>
        {running ? "Running…" : "Run stress test"}
      </DashboardButton>

      {result && <StressResult result={result} showAllRows={showAllRows} setShowAllRows={setShowAllRows} resolveWalletName={resolveWalletName} />}
    </div>
  );
}

function StressResult({ result, showAllRows, setShowAllRows, resolveWalletName }) {
  const baseUsd = Number(result.baseline.usd);
  const scenUsd = Number(result.scenario.usd);
  const chUsd = Number(result.change.usd);
  const chPct = result.change.pct != null ? Number(result.change.pct) : null;
  const chEtn = Number(result.change.etn);
  const chEtnPct = result.change.etnPct != null ? Number(result.change.etnPct) : null;
  const before = Number(result.unrealized.beforeUsd);
  const after = Number(result.unrealized.afterUsd);
  const rows = showAllRows ? result.rows : result.rows.slice(0, 8);
  const biggest = result.rows.filter((r) => Number(r.deltaUsd) !== 0).slice(0, 3);
  const pendBase = Number(result.pendingRewards.baselineUsd);
  const baselineDiff = Math.abs(Number(result.baselineCheck.diffUsd));
  const a = result.assumptions;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 12, borderTop: `1px solid ${border}` }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Stat label="Value now → scenario (USD)" tooltip="Now = your Current Value on the PnL page, priced live. Scenario = the same holdings at the shocked prices.">
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>
            {formatUsdPrice(baseUsd)} → {formatUsdPrice(scenUsd)}
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: colorOf(chUsd) }}>
            {signed(chUsd, formatUsdPrice)}{chPct != null && ` (${pct(chPct)})`}
          </div>
        </Stat>
        <Stat label="Value now → scenario (ETN)" tooltip="The same holdings measured in ETN. If ETN itself moves, this changes differently from the USD figure — a USD move and an ETN move are different signals.">
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>
            {etnFmt(Number(result.baseline.etn))} → {etnFmt(Number(result.scenario.etn))}
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: colorOf(chEtn) }}>
            {signed(chEtn, etnFmt)}{chEtnPct != null && ` (${pct(chEtnPct)})`}
          </div>
        </Stat>
        <Stat label="Unrealized P&L" tooltip="Value minus what the holdings cost you (FIFO cost basis from your ledger, unchanged by the scenario). Realized P&L doesn't change — nothing is sold.">
          <div style={{ fontSize: 16, fontWeight: 800, color: colorOf(after) }}>
            {signed(before, formatUsdPrice)} → {signed(after, formatUsdPrice)}
          </div>
          <div style={{ fontSize: 11, color: mutedLight }}>Realized P&L unchanged — nothing sold</div>
        </Stat>
      </div>

      {biggest.length > 0 && (
        <div style={{ fontSize: 12, color: mutedLight }}>
          Biggest moves:{" "}
          {biggest.map((r, i) => (
            <span key={r.key + i}>
              {i > 0 && " · "}
              <span style={{ color: "#fff", fontWeight: 700 }}>{r.label}</span> <span style={{ color: colorOf(Number(r.deltaUsd)) }}>{signed(Number(r.deltaUsd), formatUsdPrice)}</span>
            </span>
          ))}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: mutedLight, minWidth: 520 }}>
          <thead>
            <tr style={{ textAlign: "right", color: muted, fontFamily: monoFont, fontSize: 10 }}>
              <th style={{ textAlign: "left", padding: "4px 6px" }}>Holding</th>
              <th style={{ padding: "4px 6px" }}>Now</th>
              <th style={{ padding: "4px 6px" }}>Scenario</th>
              <th style={{ padding: "4px 6px" }}>Change</th>
              <th style={{ padding: "4px 6px" }}>USD move</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.key}-${i}`} style={{ textAlign: "right", borderTop: `1px solid ${border}` }}>
                <td style={{ textAlign: "left", padding: "4px 6px" }}>
                  <span style={{ color: "#fff" }}>{r.label}</span> <span style={{ color: muted, fontSize: 10 }}>{KIND_LABELS[r.kind]}</span>
                  {r.wallet && <span style={{ display: "block", fontSize: 10, color: muted }}>{resolveWalletName(r.wallet)}</span>}
                </td>
                <td style={{ padding: "4px 6px" }}>{formatUsdPrice(Number(r.baselineUsd))}</td>
                <td style={{ padding: "4px 6px" }}>{formatUsdPrice(Number(r.scenarioUsd))}</td>
                <td style={{ padding: "4px 6px", color: colorOf(Number(r.deltaUsd)) }}>{signed(Number(r.deltaUsd), formatUsdPrice)}</td>
                <td style={{ padding: "4px 6px" }}>{pct((r.factor - 1) * 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {result.rows.length > 8 && (
          <button type="button" style={{ ...chipStyle, marginTop: 6 }} onClick={() => setShowAllRows(!showAllRows)}>
            {showAllRows ? "Show fewer" : `Show all ${result.rows.length}`}
          </button>
        )}
      </div>

      <div style={{ fontSize: 11, color: mutedLight, lineHeight: 1.7 }}>
        {pendBase > 0 && (
          <>
            Pending farm rewards &amp; fees (not part of Current Value): {formatUsdPrice(pendBase)} → {formatUsdPrice(Number(result.pendingRewards.scenarioUsd))}.{" "}
          </>
        )}
        {result.unpriced.count > 0 && <>{result.unpriced.count} holding{result.unpriced.count === 1 ? "" : "s"} with no price excluded ({result.unpriced.items.map((u) => u.symbol).join(", ")}).</>}
      </div>
      {baselineDiff > 0.01 && (
        <div style={{ fontSize: 11, color: orange }}>
          ⚠ The baseline differs from your live Current Value by {formatUsdPrice(baselineDiff)} — prices moved while it ran. Run it again for a matching baseline.
        </div>
      )}

      <div style={{ padding: "10px 12px", borderRadius: 6, border: `1px dashed ${border}`, fontSize: 11, color: mutedLight, lineHeight: 1.7 }}>
        <div style={statLabel}>Assumptions</div>
        <div>Prices live at {new Date(a.pricedAt).toLocaleString()} · ETN = ${Number(a.etnUsd).toFixed(6)}</div>
        <div>{a.model}</div>
        <div>Held at $1: {a.pegged.join(", ")}.</div>
        <div>{a.liquidity}</div>
        {a.v3Approximation && <div style={{ color: orange }}>{a.v3Approximation}</div>}
        <div>{a.pendingRewards}</div>
        <div>{a.realized}</div>
        <div>{a.coverage}</div>
      </div>
      <div style={{ fontSize: 10, color: muted }}>
        Hypothetical estimate — not a quote, not a record, and not financial or tax advice. Nothing is saved.
      </div>
    </div>
  );
}
