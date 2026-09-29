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
// by ACTUAL ELAPSED TIME (not index position, unlike SparklineChart) — deliberately different from
// that component's own convention: this chart can show a sparse, irregularly-spaced real-history
// segment right next to an evenly-spaced 12-point forecast segment (see TokenBurnChart.jsx's own
// forecast builder), and plotting THAT by index would give the 90 real days and the 365 forecast
// days equal visual width regardless of how much time each actually spans — confirmed live: it
// made 90 days of history look like a LONGER stretch than the 365-day forecast, exactly backwards.
// Real elapsed time is what a reader actually expects "how long is this stretch" to mean here.
// The tax overlay below is computed by looking up each of THESE SAME dates against the tax
// schedule, so it stays aligned point-for-point with the burn line on the shared time axis.
//
// `taxSteps`: coreTaxScheduleService.js's own step list — [{ supplyPct, buyTaxPct, sellTaxPct,
// crossedAt (ISO, null if not yet reached) }], in descending supplyPct (= chronological) order.
export function taxRateAt(taxSteps, dateMs, key) {
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

// `forecastFromIndex` (optional): the index in `burnSeries` where real history ends and the
// projected continuation begins — everything up to and including that index draws solid/filled,
// everything from it onward draws dashed/lighter, sharing that one point so the line reads as
// continuous rather than two disconnected pieces. Omit entirely for a pure-history chart (every
// point solid, the original behavior).
export default function CoreBurnTaxChart({ burnSeries, taxSteps, formatBurnValue = identity, formatLabel = identity, height = 140, width = 280, forecastFromIndex = null }) {
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
  const burnToY = (v) => height - ((v - burnMin) / burnRange) * height;

  // X position by real elapsed time, not index — see this file's own header comment for why.
  const timesMs = clean.map((d) => new Date(d.label).getTime());
  const startMs = timesMs[0];
  const endMs = timesMs[timesMs.length - 1];
  const totalMs = endMs - startMs || 1;
  const dateToX = (ms) => ((ms - startMs) / totalMs) * width;

  // Right axis: shared scale across BOTH tax lines (they're the same unit, %), from 0 (taxes never
  // go negative) to the highest rate either line ever showed — not each line's own independent min,
  // so "0% buy tax" reads as flat-at-the-bottom rather than an arbitrary floating baseline.
  const taxValues = [...buySeries, ...sellSeries].filter((v) => v != null);
  const taxMax = taxValues.length > 0 ? Math.max(...taxValues) : 1;
  const taxToY = (v) => height - (v / (taxMax || 1)) * height;

  const burnCoords = clean.map((d, i) => [dateToX(timesMs[i]), burnToY(d.value)]);
  // Step (not linear) interpolation: a tax line holds flat at its current rate until the exact
  // point it changes, then jumps — linear interpolation between two different rates would draw a
  // gradual ramp that never actually existed on-chain.
  function stepCoords(series) {
    const points = [];
    for (let i = 0; i < series.length; i++) {
      if (series[i] == null) continue;
      const x = dateToX(timesMs[i]);
      const y = taxToY(series[i]);
      if (points.length > 0) points.push([x, points[points.length - 1][1]]); // flat line up to this point in time
      points.push([x, y]);
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
    const targetMs = startMs + fraction * totalMs;
    // Nearest point by actual elapsed time, not by uniform index spacing — with points spread
    // unevenly across time (sparse history, evenly-spaced-but-far-apart forecast months), the
    // point under the cursor isn't necessarily at round(fraction * (length - 1)) anymore.
    let closest = 0;
    let closestDist = Infinity;
    for (let i = 0; i < timesMs.length; i++) {
      const dist = Math.abs(timesMs[i] - targetMs);
      if (dist < closestDist) {
        closestDist = dist;
        closest = i;
      }
    }
    setHoverIndex(closest);
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

              {forecastFromIndex != null && forecastFromIndex < burnCoords.length - 1 ? (
                <>
                  {/* Real history: solid line, filled area, up to and including the split point. */}
                  <path d={areaPath(burnCoords.slice(0, forecastFromIndex + 1))} fill={greenGlow} stroke="none" />
                  <polyline points={linePath(burnCoords.slice(0, forecastFromIndex + 1))} fill="none" stroke={green} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                  {/* Projected continuation: dashed, no fill, starting FROM the split point so the line stays continuous. */}
                  <polyline
                    points={linePath(burnCoords.slice(forecastFromIndex))}
                    fill="none"
                    stroke={green}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray="6,4"
                    opacity={0.85}
                  />
                </>
              ) : (
                <>
                  <path d={areaPath(burnCoords)} fill={greenGlow} stroke="none" />
                  <polyline points={linePath(burnCoords)} fill="none" stroke={green} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                </>
              )}

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

          <div style={{ position: "relative", height: 12, marginTop: 4 }}>
            {/* Positioned by real elapsed time (same dateToX the chart itself uses), not an even
                3-way split — with an uneven mix of sparse history and far-apart forecast points,
                the true time-midpoint usually isn't the index-midpoint. */}
            <span style={{ position: "absolute", left: 0, fontSize: 10, color: muted }}>{formatLabel(clean[0].label)}</span>
            <span style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", fontSize: 10, color: muted }}>
              {formatLabel(new Date(startMs + totalMs / 2).toISOString().slice(0, 10))}
            </span>
            <span style={{ position: "absolute", right: 0, fontSize: 10, color: muted }}>{formatLabel(clean[clean.length - 1].label)}</span>
          </div>
        </div>
      </div>

      {hasTax && (
        <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 10, color: mutedLight, flexWrap: "wrap" }}>
          <span><span style={{ display: "inline-block", width: 10, height: 2, background: green, marginRight: 5, verticalAlign: "middle" }} />Cumulative burned</span>
          <span><span style={{ display: "inline-block", width: 10, height: 2, background: orange, marginRight: 5, verticalAlign: "middle" }} />Buy tax</span>
          <span><span style={{ display: "inline-block", width: 10, height: 2, background: blue, marginRight: 5, verticalAlign: "middle" }} />Sell tax</span>
        </div>
      )}
      {forecastFromIndex != null && (
        <div style={{ fontSize: 10, color: mutedLight, marginTop: 6, fontStyle: "italic" }}>
          Solid = actual history, dashed = projected (not a guarantee) — assumes burns continue at the recent daily rate. See the note above for exactly how it's calculated.
        </div>
      )}
    </div>
  );
}
