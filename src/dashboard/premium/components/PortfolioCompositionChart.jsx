import React, { useState } from "react";
import { green, blue, orange, mutedLight, muted } from "../../theme.js";
import { formatUsdPrice } from "../../utils/format.js";

// Fixed, category-identity palette (not a heat/intensity scale) — same "identity, not quantity"
// reasoning as theme.js's own VALIDATOR_PALETTE. Green stays the brand-primary color (used
// everywhere else for "this wallet is yours"/positive figures), so it's assigned to Native ETN —
// this dashboard's own base asset — rather than picked arbitrarily.
const SLICE_COLORS = { native: green, tokens: blue, liquidity: orange, staking: "#c792ea" };

/** Donut chart breaking down a member's Total Portfolio Balance by category — Native ETN, regular
 * fungible Tokens, Liquidity Positions (V2 LP + V3, held directly), Staking/Yield Farms (locked in
 * a farm/staking contract). Hand-rolled SVG, no charting library — same reasoning as
 * SparklineChart.jsx's own header comment (a handful of wedges, not worth a dependency).
 *
 * `slices`: `[{ key, label, value }]`, value in USD — a category with value 0 (rather than being
 * omitted) still gets a labeled legend row showing $0.00, since silently dropping a category could
 * read as "you have nothing here" when the real answer might just be "not priced yet" — the
 * DISTINCTION between those two is carried by `hasUnpriced` (shows a "≈" prefix on the total, same
 * convention as the rest of this panel), not by hiding slices.
 */
export default function PortfolioCompositionChart({ slices, hasUnpriced, size = 150 }) {
  const [hoverKey, setHoverKey] = useState(null);
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const radius = size / 2;
  const innerRadius = radius * 0.6; // donut hole — leaves room for the total figure in the center
  const cx = radius;
  const cy = radius;

  if (total <= 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: size, fontSize: 11, color: muted, textAlign: "center", padding: "0 12px" }}>
        Nothing priced yet — check back once your holdings' values have resolved.
      </div>
    );
  }

  // Each wedge as an SVG path — standard "polar to cartesian" donut-slice construction, one pass
  // accumulating the running start angle. A single-slice portfolio (everything in one category)
  // draws as a full ring via a dedicated <circle> pair instead — an SVG arc path can't describe a
  // 360° sweep (the start and end points coincide, so the arc command degenerates to nothing).
  let angle = -90; // 12 o'clock start, clockwise — the conventional pie-chart orientation
  const wedges = [];
  for (const s of slices) {
    if (s.value <= 0) continue;
    const fraction = s.value / total;
    const sweep = fraction * 360;
    const startAngle = angle;
    const endAngle = angle + sweep;
    angle = endAngle;
    if (fraction >= 0.9999) {
      wedges.push({ ...s, fullCircle: true });
      continue;
    }
    const toRad = (deg) => (deg * Math.PI) / 180;
    const outerStart = { x: cx + radius * Math.cos(toRad(startAngle)), y: cy + radius * Math.sin(toRad(startAngle)) };
    const outerEnd = { x: cx + radius * Math.cos(toRad(endAngle)), y: cy + radius * Math.sin(toRad(endAngle)) };
    const innerStart = { x: cx + innerRadius * Math.cos(toRad(endAngle)), y: cy + innerRadius * Math.sin(toRad(endAngle)) };
    const innerEnd = { x: cx + innerRadius * Math.cos(toRad(startAngle)), y: cy + innerRadius * Math.sin(toRad(startAngle)) };
    const largeArc = sweep > 180 ? 1 : 0;
    const path = [
      `M ${outerStart.x} ${outerStart.y}`,
      `A ${radius} ${radius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
      `L ${innerStart.x} ${innerStart.y}`,
      `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerEnd.x} ${innerEnd.y}`,
      "Z",
    ].join(" ");
    wedges.push({ ...s, path, fraction });
  }

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {wedges.map((w) =>
            w.fullCircle ? (
              <circle
                key={w.key}
                cx={cx}
                cy={cy}
                r={(radius + innerRadius) / 2}
                fill="none"
                stroke={SLICE_COLORS[w.key] || mutedLight}
                strokeWidth={radius - innerRadius}
                opacity={hoverKey && hoverKey !== w.key ? 0.35 : 1}
                onMouseEnter={() => setHoverKey(w.key)}
                onMouseLeave={() => setHoverKey(null)}
                style={{ cursor: "pointer", transition: "opacity 0.15s" }}
              />
            ) : (
              <path
                key={w.key}
                d={w.path}
                fill={SLICE_COLORS[w.key] || mutedLight}
                opacity={hoverKey && hoverKey !== w.key ? 0.35 : 1}
                onMouseEnter={() => setHoverKey(w.key)}
                onMouseLeave={() => setHoverKey(null)}
                style={{ cursor: "pointer", transition: "opacity 0.15s" }}
              />
            )
          )}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none", textAlign: "center" }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: muted }}>Total</div>
          <div style={{ fontSize: 13, fontWeight: 900, color: "#fff" }}>
            {hasUnpriced ? "≈ " : ""}{formatUsdPrice(total)}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 160px", minWidth: 140 }}>
        {slices.map((s) => (
          <div
            key={s.key}
            onMouseEnter={() => setHoverKey(s.key)}
            onMouseLeave={() => setHoverKey(null)}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12, opacity: hoverKey && hoverKey !== s.key ? 0.5 : 1, transition: "opacity 0.15s", cursor: "default" }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 6, color: mutedLight, minWidth: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: SLICE_COLORS[s.key] || mutedLight, flexShrink: 0 }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</span>
            </span>
            <span style={{ display: "flex", alignItems: "baseline", gap: 6, flexShrink: 0 }}>
              <span style={{ color: "#fff", fontWeight: 700 }}>{formatUsdPrice(s.value)}</span>
              <span style={{ color: muted, fontSize: 10 }}>{total > 0 ? `${Math.round((s.value / total) * 100)}%` : "—"}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
