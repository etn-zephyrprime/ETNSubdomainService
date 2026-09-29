import React, { useMemo, useRef, useState } from "react";
import { green, greenGlow, orange, blue, muted, mutedLight, panel, border } from "../theme.js";

// Burn history + CORE's own on-chain-confirmed tax schedule, on one chart — a dedicated component
// rather than extending SparklineChart.jsx (used by a dozen+ other features on this dashboard):
// this needs a genuinely different shape (a left axis for cumulative burned CORE, a SEPARATE right
// axis for tax %, and two extra lines drawn as STEPS rather than smoothly interpolated, since tax
// only ever changes at a discrete threshold crossing, never gradually) — safer to keep that
// entirely separate than risk regressing every other SparklineChart caller for one chart's needs.
//
// `burnSeries`: [{ label, value }] — same shape/order as TokenBurnChart.jsx's own cumulative-burned
// series (one point per UTC day that had a burn — SPARSE, not one point per calendar day). Plotted
// by INDEX position (evenly spaced), same convention SparklineChart itself uses — so the tax
// overlay below is computed by looking up each of THESE SAME dates against the tax schedule, not
// against a separate dense daily range, to stay aligned point-for-point on the shared X axis.
//
// `taxSteps`: coreTaxScheduleService.js's own step list — [{ supplyPct, buyTaxPct, sellTaxPct,
// crossedAt (ISO, null if not yet reached) }], in descending supplyPct (= chronological) order.
function taxRateAt(taxSteps, dateMs, key) {
  // Latest step whose crossedAt is on/before `dateMs` — steps are chronological, so a plain
  // reverse scan for the first match is a normal "as-of" lookup, same shape as this app's other
  // "closing value on the target date" queries (e.g. balanceHistory.js's own forward-fill).
  let applicable = null;
  for (const step of taxSteps) {
    if (step.crossedAt == null) continue;
    const crossedMs = new Date(step.crossedAt).getTime();
    if (crossedMs <= dateMs) applicable = step;
    else break;
  }
  return applicable ? applicable[key] : null;
}

function identity(v) {
  return String(v);
}

export default function CoreBurnTaxChart({ burnSeries, taxSteps, formatBurnValue = identity, formatLabel = identity, height = 140, width = 280 }) {
  const svgRef = useRef(null);
  const [hoverIndex, setHoverIndex] = useState(null);

  const clean = burnSeries.filter((d) => typeof d.value === "number" && Number.isFinite(d.value));

  const { buySeries, sellSeries } = useMemo(() => {
    if (!taxSteps || taxSteps.length === 0) return { buySeries: [], sellSeries: [] };
    return {
      buySeries: clean.map((d) => taxRateAt(taxSteps, new Date(d.label).getTime(), "buyTaxPct")),
      sellSeries: clean.map((d) => taxRateAt(taxSteps, new Date(d.label).getTime(), "sellTaxPct")),
    };
  }, [clean, taxSteps]);

  const hasTax = buySeries.some((v) => v != null) || sellSeries.some((v) => v != null);

  if (clean.length < 2) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#666" }}>
        Not enough data
      </div>
    );
  }

  const burnMin = Math.min(...clean.map((d) => d.value));
  const burnMax = Math.max(...clean.map((d) => d.value));
  const burnRange = burnMax - burnMin || 1;
  const stepX = width / (clean.length - 1);
  const burnToY = (v) => height - ((v - burnMin) / burnRange) * height;

  // Right axis: shared scale across BOTH tax lines (they're the same unit, %), from 0 (taxes never
  // go negative) to the highest rate either line ever showed — not each line's own independent min,
  // so "0% buy tax" reads as flat-at-the-bottom rather than an arbitrary floating baseline.
  const taxValues = [...buySeries, ...sellSeries].filter((v) => v != null);
  const taxMax = taxValues.length > 0 ? Math.max(...taxValues) : 1;
  const taxToY = (v) => height - (v / (taxMax || 1)) * height;

  const burnCoords = clean.map((d, i) => [i * stepX, burnToY(d.value)]);
  // Step (not linear) interpolation: a tax line holds flat at its current rate until the exact
  // point it changes, then jumps — linear interpolation between two different rates would draw a
  // gradual ramp that never actually existed on-chain.
  function stepCoords(series) {
    const points = [];
    for (let i = 0; i < series.length; i++) {
      if (series[i] == null) continue;
      const y = taxToY(series[i]);
      if (points.length > 0) points.push([i * stepX, points[points.length - 1][1]]); // flat line up to this index
      points.push([i * stepX, y]);
    }
    return points;
  }
  const buyCoords = stepCoords(buySeries);
  const sellCoords = stepCoords(sellSeries);

  const areaPath = (points) => {
    const line = points.map((c) => c.join(",")).join(" ");
    const [firstX] = points[0];
    const [lastX] = points[points.length - 1];
    return `M${firstX},${height} L${line} L${lastX},${height} Z`;
  };
  const linePath = (points) => points.map((c) => c.join(",")).join(" ");

  const updateHover = (clientX) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fraction = (clientX - rect.left) / rect.width;
    const index = Math.max(0, Math.min(clean.length - 1, Math.round(fraction * (clean.length - 1))));
    setHoverIndex(index);
  };

  const hoverCoord = hoverIndex != null ? burnCoords[hoverIndex] : null;
  const hoverPoint = hoverIndex != null ? clean[hoverIndex] : null;
  const tooltipAlign = hoverCoord && hoverCoord[0] > width / 2 ? "right" : "left";

  return (
    <div>
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height, flexShrink: 0 }}>
          {[burnMax, (burnMax + burnMin) / 2, burnMin].map((v, i) => (
            <div key={i} style={{ fontSize: 10, color: muted, textAlign: "right", lineHeight: 1 }}>{formatBurnValue(v)}</div>
          ))}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ position: "relative" }}>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${width} ${height}`}
              width="100%"
              height={height}
              preserveAspectRatio="none"
              onMouseMove={(e) => updateHover(e.clientX)}
              onMouseLeave={() => setHoverIndex(null)}
              style={{ cursor: "crosshair", display: "block" }}
            >
              {[burnMax, (burnMax + burnMin) / 2, burnMin].map((v, i) => (
                <line key={i} x1={0} y1={burnToY(v)} x2={width} y2={burnToY(v)} stroke={border} strokeWidth={0.5} strokeDasharray="2,2" />
              ))}

              <path d={areaPath(burnCoords)} fill={greenGlow} stroke="none" />
              <polyline points={linePath(burnCoords)} fill="none" stroke={green} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

              {sellCoords.length > 1 && (
                <polyline points={linePath(sellCoords)} fill="none" stroke={blue} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeDasharray="4,3" />
              )}
              {buyCoords.length > 1 && (
                <polyline points={linePath(buyCoords)} fill="none" stroke={orange} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeDasharray="4,3" />
              )}

              {hoverCoord && (
                <>
                  <line x1={hoverCoord[0]} y1={0} x2={hoverCoord[0]} y2={height} stroke={mutedLight} strokeWidth={1} strokeDasharray="3,3" />
                  <circle cx={hoverCoord[0]} cy={hoverCoord[1]} r={4} fill={green} stroke={panel} strokeWidth={1.5} />
                </>
              )}
            </svg>

            {hasTax && (
              <div style={{ position: "absolute", top: 0, right: 0, display: "flex", flexDirection: "column", justifyContent: "space-between", height, textAlign: "right", pointerEvents: "none" }}>
                <span style={{ fontSize: 10, color: muted }}>{taxMax.toFixed(1)}%</span>
                <span style={{ fontSize: 10, color: muted }}>0%</span>
              </div>
            )}

            {hoverPoint && hoverCoord && (
              <div
                style={{
                  position: "absolute",
                  left: `${(hoverCoord[0] / width) * 100}%`,
                  top: `${(hoverCoord[1] / height) * 100}%`,
                  transform: `translate(${tooltipAlign === "right" ? "-100%" : "0%"}, -130%)`,
                  marginLeft: tooltipAlign === "right" ? -8 : 8,
                  background: panel,
                  border: `1px solid ${border}`,
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  pointerEvents: "none",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                  zIndex: 1,
                }}
              >
                <div style={{ color: mutedLight, marginBottom: 2 }}>{formatLabel(hoverPoint.label, true)}</div>
                <div style={{ color: "#fff", fontWeight: 700 }}>{formatBurnValue(hoverPoint.value)}</div>
                {hoverIndex != null && buySeries[hoverIndex] != null && (
                  <div style={{ color: orange }}>Buy tax: {buySeries[hoverIndex]}%</div>
                )}
                {hoverIndex != null && sellSeries[hoverIndex] != null && (
                  <div style={{ color: blue }}>Sell tax: {sellSeries[hoverIndex]}%</div>
                )}
              </div>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            <span style={{ fontSize: 10, color: muted }}>{formatLabel(clean[0].label)}</span>
            <span style={{ fontSize: 10, color: muted }}>{formatLabel(clean[Math.round((clean.length - 1) / 2)].label)}</span>
            <span style={{ fontSize: 10, color: muted }}>{formatLabel(clean[clean.length - 1].label)}</span>
          </div>
        </div>
      </div>

      {hasTax && (
        <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 10, color: mutedLight }}>
          <span><span style={{ display: "inline-block", width: 10, height: 2, background: green, marginRight: 5, verticalAlign: "middle" }} />Cumulative burned</span>
          <span><span style={{ display: "inline-block", width: 10, height: 2, background: orange, marginRight: 5, verticalAlign: "middle" }} />Buy tax</span>
          <span><span style={{ display: "inline-block", width: 10, height: 2, background: blue, marginRight: 5, verticalAlign: "middle" }} />Sell tax</span>
        </div>
      )}
    </div>
  );
}
