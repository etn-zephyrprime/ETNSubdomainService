import React from "react";
import InfoTooltip from "../../components/InfoTooltip.jsx";
import { formatUsdPrice, formatEtnAmount } from "../../utils/format.js";
import { green, muted, mutedLight, orange, border, panel2, error as errorColor, monoFont } from "../../theme.js";

// Shared building blocks for the Core Tier Scenarios tools (farm, rewards, backtest): inputs, stat
// cards, the always-visible assumptions panel and the hypothetical-estimate note.

export const AUTH_PURPOSE = "Premium Dashboard";

export const inputStyle = {
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
export const labelStyle = { fontFamily: monoFont, fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 4, display: "block" };
export const statLabel = { fontFamily: monoFont, fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 4 };
export const chipStyle = { background: "none", border: `1px solid ${border}`, borderRadius: 4, color: mutedLight, fontSize: 10, fontFamily: monoFont, padding: "3px 8px", cursor: "pointer" };

export const toggleStyle = (on) => ({
  ...chipStyle,
  fontSize: 11,
  padding: "6px 12px",
  fontWeight: 700,
  color: on ? "#000" : mutedLight,
  background: on ? green : "none",
  borderColor: on ? green : border,
});

export const signed = (n, fmt) => `${n >= 0 ? "+" : "−"}${fmt(Math.abs(n))}`;
export const etnFmt = (n) => `${formatEtnAmount(n)} ETN`;
export const colorOf = (n) => (n > 0 ? green : n < 0 ? errorColor : mutedLight);
export const tokenFmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: Math.abs(Number(n)) >= 100 ? 1 : 4 });
export const usdOrDash = (v) => (v == null ? "—" : formatUsdPrice(Number(v)));
export const multFmt = (m) => `${Number(m).toFixed(2)}×`;

export function Stat({ label, tooltip, children }) {
  return (
    <div style={{ flex: "1 1 170px", minWidth: 0, padding: "10px 12px", borderRadius: 6, border: `1px solid ${border}`, background: panel2 }}>
      <div style={{ ...statLabel, display: "flex", alignItems: "center", gap: 4 }}>
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </div>
      {children}
    </div>
  );
}

export function Warnings({ warnings }) {
  if (!warnings?.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {warnings.map((w) => (
        <div key={w} style={{ fontSize: 11, color: orange }}>⚠ {w}</div>
      ))}
    </div>
  );
}

/** The assumptions a result was computed under — every scenario result renders one. */
export function Assumptions({ assumptions }) {
  if (!assumptions) return null;
  const { pricedAt, etnUsd, ...rest } = assumptions;
  return (
    <div style={{ padding: "10px 12px", borderRadius: 6, border: `1px dashed ${border}`, fontSize: 11, color: mutedLight, lineHeight: 1.7 }}>
      <div style={statLabel}>Assumptions</div>
      {pricedAt && <div>Prices live at {new Date(pricedAt).toLocaleString()}{etnUsd && ` · ETN = $${Number(etnUsd).toFixed(6)}`}</div>}
      {Object.values(rest).filter(Boolean).map((line) => (
        <div key={line}>{line}</div>
      ))}
      <div style={{ color: muted, marginTop: 4 }}>Hypothetical estimate — not a quote, not a forecast, not a record, and not financial or tax advice. Nothing is saved.</div>
    </div>
  );
}

/** Reward projection rows: horizon, tokens, value at spot, if sold, and the sensitivity range. */
export function ProjectionTable({ rows, showMultiplier = true }) {
  if (!rows?.length) return null;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, color: mutedLight, minWidth: 560 }}>
        <thead>
          <tr style={{ textAlign: "right", color: muted, fontFamily: monoFont, fontSize: 10 }}>
            <th style={{ textAlign: "left", padding: "4px 6px" }}>Period</th>
            {showMultiplier && <th style={{ padding: "4px 6px" }}>Multiplier</th>}
            <th style={{ padding: "4px 6px" }}>Rewards</th>
            <th style={{ padding: "4px 6px" }}>At spot</th>
            <th style={{ padding: "4px 6px" }}>If sold</th>
            <th style={{ padding: "4px 6px" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                Range <InfoTooltip text="Spot value if everyone else's stake were half to double today's, and the reward price 50% lower to 50% higher." align="right" />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const spot = (Number(r.reward?.spotUsd) || 0) + (Number(r.partner?.spotUsd) || 0);
            const soldParts = [r.reward?.soldUsd, r.partner?.soldUsd].filter((v) => v != null);
            const sold = soldParts.length ? soldParts.reduce((a, v) => a + Number(v), 0) : null;
            return (
              <tr key={r.label} style={{ textAlign: "right", borderTop: `1px solid ${border}` }}>
                <td style={{ textAlign: "left", padding: "4px 6px", color: "#fff" }}>{r.label}</td>
                {showMultiplier && <td style={{ padding: "4px 6px" }}>{r.multiplierAt != null ? multFmt(r.multiplierAt) : "—"}</td>}
                <td style={{ padding: "4px 6px" }}>
                  {tokenFmt(r.rewardTokens)} {r.rewardSymbol}
                  {r.partnerTokens != null && r.partnerTokens > 0 && <span style={{ display: "block" }}>{tokenFmt(r.partnerTokens)} {r.partnerSymbol}</span>}
                </td>
                <td style={{ padding: "4px 6px" }}>{formatUsdPrice(spot)}</td>
                <td style={{ padding: "4px 6px" }}>{sold == null ? "—" : formatUsdPrice(sold)}</td>
                <td style={{ padding: "4px 6px" }}>
                  {formatUsdPrice(r.rangeUsd.low)} – {formatUsdPrice(r.rangeUsd.high)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- Investor-facing presentation pieces (shared by every Scenarios tool) ----------------------

export const TONES = { up: green, down: errorColor, neutral: mutedLight, warn: orange, info: "#3ea6ff" };
const toneOf = (n) => (n > 0 ? "up" : n < 0 ? "down" : "neutral");
export const toneFor = toneOf;

/** Card shell for a result: soft gradient surface, rounded, generous padding. */
export function ResultCard({ children, accent = green }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: 16,
        borderRadius: 12,
        border: `1px solid ${border}`,
        background: `linear-gradient(180deg, ${accent}14 0%, rgba(17,17,17,0) 140px), ${panel2}`,
      }}
    >
      {children}
    </div>
  );
}

/** Small uppercase eyebrow label. */
export function Eyebrow({ children, style }) {
  return <div style={{ ...statLabel, marginBottom: 6, ...style }}>{children}</div>;
}

/** Signed percentage pill, green/red. */
export function DeltaPill({ pct }) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const c = TONES[toneOf(pct)];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 800,
        color: c,
        background: `${c}1f`,
        border: `1px solid ${c}55`,
        fontFamily: monoFont,
        whiteSpace: "nowrap",
      }}
    >
      {pct > 0 ? "▲" : pct < 0 ? "▼" : "•"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/** The headline of a result: one big number, an optional "from" figure, a delta pill and a sub-line. */
export function Hero({ label, value, from, pct, sub, tone }) {
  const c = tone ? TONES[tone] : "#fff";
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        {from && <span style={{ fontSize: 16, fontWeight: 700, color: muted }}>{from} →</span>}
        <span style={{ fontSize: 30, lineHeight: 1.1, fontWeight: 900, color: c, letterSpacing: -0.5 }}>{value}</span>
        <DeltaPill pct={pct} />
      </div>
      {sub && <div style={{ fontSize: 12, color: mutedLight, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

/** Compact KPI tile for the row under the hero. */
export function Kpi({ label, value, sub, tone, tooltip }) {
  return (
    <div style={{ flex: "1 1 140px", minWidth: 0, padding: "10px 12px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: `1px solid ${border}` }}>
      <div style={{ ...statLabel, display: "flex", alignItems: "center", gap: 4 }}>
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </div>
      <div style={{ fontSize: 17, fontWeight: 800, color: tone ? TONES[tone] : "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: mutedLight, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function KpiRow({ children }) {
  return <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{children}</div>;
}

/** One highlighted note — only for the few messages that should change a decision. */
export function Callout({ tone = "warn", children }) {
  const c = TONES[tone];
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, background: `${c}12`, border: `1px solid ${c}44`, fontSize: 12, color: "#ddd", lineHeight: 1.5 }}>
      <span style={{ color: c, fontWeight: 900, fontSize: 13 }}>{tone === "warn" ? "!" : tone === "up" ? "✓" : "i"}</span>
      <div>{children}</div>
    </div>
  );
}

/** Horizontal bars, diverging around zero (contributions) or one-sided (values). */
export function BarList({ rows, format, max }) {
  const m = max ?? Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
  const diverging = rows.some((r) => r.value < 0) && rows.some((r) => r.value > 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {rows.map((r) => {
        const share = Math.abs(r.value) / m;
        const w = Math.max(1.5, share * (diverging ? 50 : 100));
        const c = r.color || TONES[toneOf(r.value)];
        const left = diverging ? (r.value < 0 ? `${50 - w}%` : "50%") : 0;
        return (
          <div key={r.key || r.label} style={{ display: "grid", gridTemplateColumns: "minmax(84px, 30%) 1fr auto", alignItems: "center", gap: 10, fontSize: 12 }}>
            <div style={{ color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {r.label}
              {r.tag && <span style={{ color: muted, fontSize: 10, marginLeft: 6 }}>{r.tag}</span>}
            </div>
            <div style={{ position: "relative", height: 10, borderRadius: 999, background: "rgba(255,255,255,0.05)" }}>
              {diverging && <div style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: border }} />}
              <div style={{ position: "absolute", top: 0, bottom: 0, borderRadius: 999, background: c, boxShadow: `0 0 8px ${c}55`, width: `${w}%`, left }} />
            </div>
            <div style={{ color: c, fontWeight: 800, fontFamily: monoFont, fontSize: 11, textAlign: "right", minWidth: 74 }}>{format(r.value)}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Low-to-high range with a marker for the base case (projections). */
export function RangeBar({ low, high, mid, format, scaleMax }) {
  const top = scaleMax ?? high;
  const pct = (v) => Math.min(100, Math.max(0, (v / (top || 1)) * 100));
  return (
    <div>
      <div style={{ position: "relative", height: 8, borderRadius: 999, background: "rgba(255,255,255,0.05)", margin: "10px 0 6px" }}>
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${pct(low)}%`, width: `${Math.max(1, pct(high) - pct(low))}%`, borderRadius: 999, background: `linear-gradient(90deg, ${green}55, ${green})` }} />
        {mid != null && <div style={{ position: "absolute", top: -3, width: 3, height: 14, borderRadius: 2, background: "#fff", left: `calc(${pct(mid)}% - 1px)` }} />}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: muted, fontFamily: monoFont }}>
        <span>{format(low)}</span>
        <span>{format(high)}</span>
      </div>
    </div>
  );
}

/** Duration multiplier track 1.0x to 2.5x: filled to the current value, optional marker for "after". */
export function MultiplierGauge({ value, next, min = 1, max = 2.5 }) {
  const pct = (v) => ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100;
  return (
    <div>
      <div style={{ position: "relative", height: 10, borderRadius: 999, background: "rgba(255,255,255,0.06)", margin: "10px 0 6px" }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct(value)}%`, borderRadius: 999, background: `linear-gradient(90deg, ${green}66, ${green})`, boxShadow: `0 0 10px ${green}55` }} />
        {next != null && Math.abs(next - value) > 1e-6 && <div style={{ position: "absolute", top: -4, width: 4, height: 18, borderRadius: 2, background: orange, left: `calc(${pct(next)}% - 2px)` }} />}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: muted, fontFamily: monoFont }}>
        <span>{min.toFixed(1)}×</span>
        <span>{max.toFixed(1)}× max</span>
      </div>
    </div>
  );
}

/** Collapsible extra detail (tables, full breakdowns). */
export function Details({ label = "Details", children }) {
  return (
    <details style={{ borderTop: `1px solid ${border}`, paddingTop: 10 }}>
      <summary style={{ cursor: "pointer", fontSize: 11, color: mutedLight, fontFamily: monoFont, letterSpacing: 0.5, textTransform: "uppercase", listStyle: "none" }}>▸ {label}</summary>
      <div style={{ marginTop: 10 }}>{children}</div>
    </details>
  );
}

/** Assumptions, compact: the key facts always visible as chips, the full list one click away. */
export function AssumptionsStrip({ assumptions, facts = [] }) {
  if (!assumptions) return null;
  const { pricedAt, etnUsd, ...rest } = assumptions;
  const chips = [
    pricedAt && `Live ${new Date(pricedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    etnUsd && `ETN $${Number(etnUsd).toFixed(5)}`,
    ...facts,
  ].filter(Boolean);
  return (
    <details style={{ borderRadius: 10, border: `1px dashed ${border}`, padding: "8px 12px" }}>
      <summary style={{ cursor: "pointer", listStyle: "none", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", fontSize: 10, color: muted, fontFamily: monoFont }}>
        <span style={{ textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700 }}>Assumptions ▸</span>
        {chips.map((c) => (
          <span key={c} style={{ padding: "1px 7px", borderRadius: 999, border: `1px solid ${border}`, color: mutedLight }}>{c}</span>
        ))}
        <span style={{ marginLeft: "auto" }}>Hypothetical · not advice</span>
      </summary>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: mutedLight, lineHeight: 1.6 }}>
        {Object.values(rest)
          .filter(Boolean)
          .map((line) => (
            <div key={line}>· {line}</div>
          ))}
        <div style={{ color: muted }}>Hypothetical estimate — not a quote, not a forecast, not a record, and not financial or tax advice. Nothing is saved.</div>
      </div>
    </details>
  );
}

/** Warnings, compact: one line each. */
export function WarningList({ warnings }) {
  if (!warnings?.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {warnings.map((w) => (
        <div key={w} style={{ display: "flex", gap: 6, fontSize: 11, color: "#cfa27a", lineHeight: 1.5 }}>
          <span style={{ color: orange, fontWeight: 900 }}>!</span>
          <span>{w}</span>
        </div>
      ))}
    </div>
  );
}

/** One-line intro under a tool's tabs. */
export function Intro({ children }) {
  return <div style={{ fontSize: 13, color: mutedLight, lineHeight: 1.5 }}>{children}</div>;
}

/** Compact USD: $1.2K / $3.4M above 10k, otherwise the normal price format. */
export function usdShort(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return `${n < 0 ? "−" : ""}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${n < 0 ? "−" : ""}$${(a / 1e3).toFixed(1)}K`;
  if (a >= 1000) return `${n < 0 ? "−" : ""}$${Math.round(a).toLocaleString()}`;
  return `${n < 0 ? "−" : ""}${formatUsdPrice(a)}`;
}

/** Signed percentage text, e.g. "+4.8%". */
export const pctText = (n) => (n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`);

/** Reward projection as one card per period: value at spot (headline), tokens, if-sold, and the
 * sensitivity range as a bar — all periods on the same scale so they compare at a glance. */
export function ProjectionCards({ rows, showMultiplier = true }) {
  if (!rows?.length) return null;
  const spotOf = (r) => (Number(r.reward?.spotUsd) || 0) + (Number(r.partner?.spotUsd) || 0);
  const soldOf = (r) => {
    const parts = [r.reward?.soldUsd, r.partner?.soldUsd].filter((v) => v != null);
    return parts.length ? parts.reduce((a, v) => a + Number(v), 0) : null;
  };
  const scaleMax = Math.max(...rows.map((r) => r.rangeUsd.high), 1e-9);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
      {rows.map((r) => {
        const spot = spotOf(r);
        const sold = soldOf(r);
        return (
          <div key={r.label} style={{ padding: "12px 12px 10px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: `1px solid ${border}` }}>
            <div style={{ ...statLabel, display: "flex", justifyContent: "space-between" }}>
              <span>{r.label}</span>
              {showMultiplier && r.multiplierAt != null && <span style={{ color: green }}>{Number(r.multiplierAt).toFixed(2)}×</span>}
            </div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#fff", letterSpacing: -0.3 }}>{usdShort(spot)}</div>
            <div style={{ fontSize: 11, color: mutedLight }}>
              {tokenFmt(r.rewardTokens)} {r.rewardSymbol}
              {r.partnerTokens != null && r.partnerTokens > 0 && ` + ${tokenFmt(r.partnerTokens)} ${r.partnerSymbol}`}
            </div>
            {sold != null && Math.abs(sold - spot) > 0.005 && (
              <div style={{ fontSize: 11, color: sold < spot * 0.95 ? orange : mutedLight, marginTop: 2 }}>{usdShort(sold)} if sold</div>
            )}
            <RangeBar low={r.rangeUsd.low} high={r.rangeUsd.high} mid={spot} format={usdShort} scaleMax={scaleMax} />
          </div>
        );
      })}
    </div>
  );
}

/** ETN amount for headlines: no decimals from 1,000 up, compact from a million. */
export function etnShort(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M ETN`;
  if (a >= 1000) return `${sign}${Math.round(a).toLocaleString()} ETN`;
  return `${sign}${a.toLocaleString(undefined, { maximumFractionDigits: 2 })} ETN`;
}
