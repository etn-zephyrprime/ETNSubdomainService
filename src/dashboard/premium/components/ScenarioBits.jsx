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
