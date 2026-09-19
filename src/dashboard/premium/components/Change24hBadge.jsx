import React from "react";
import { green, error as errorColor, mutedLight } from "../../theme.js";

// "24h +20.00%" marker — green up, red down, muted when flat. `coverage` < 1 (some holdings had no
// known 24h price change and are left out of the figure — see portfolioChange.js) is flagged with
// "≈", same convention as the balance figures next to it.
export default function Change24hBadge({ change, fontSize = 11 }) {
  if (!change) return null;
  const { pct, coverage } = change;
  const pctDisplay = pct * 100;
  const rounded = Math.abs(pctDisplay) < 0.005 ? 0 : pctDisplay;
  const color = rounded > 0 ? green : rounded < 0 ? errorColor : mutedLight;
  const arrow = rounded > 0 ? "▲" : rounded < 0 ? "▼" : "";
  const partial = coverage < 0.999;
  return (
    <span
      style={{ fontSize, fontWeight: 700, color, whiteSpace: "nowrap" }}
      title={partial ? `Based on the ${Math.round(coverage * 100)}% of this value with a known 24h price change` : "Price change over the last 24 hours, at current holdings"}
    >
      {arrow} {partial ? "≈ " : ""}{rounded > 0 ? "+" : ""}{rounded.toFixed(2)}% <span style={{ color: mutedLight, fontWeight: 600 }}>24h</span>
    </span>
  );
}
