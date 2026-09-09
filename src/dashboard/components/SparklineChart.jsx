import React, { useRef, useState } from "react";
import { green, greenGlow, error, errorGlow, muted, mutedLight, panel, border } from "../theme.js";

const identity = (v) => String(v);

// Hand-rolled SVG line chart — no charting library dependency for what's just a handful of points
// (Blockscout's chart endpoints return ~30-90 points at most, dashboardStatsCache.js's hourly
// snapshots similarly small). `data` is an array of `{ label, value }`, oldest first — `label` is
// whatever formatLabel(label) can turn into a date/time string, `value` a number or null/undefined
// for a gap (a missing day's data shouldn't visually read as "value crashed to zero", so gaps
// break the line into separate segments rather than dropping to 0).
//
// Axis labels and the tooltip are plain HTML, not SVG <text> — deliberately. This SVG stretches
// non-uniformly to fill whatever width its card happens to render at (preserveAspectRatio="none",
// needed so the line/area genuinely fills the card), and SVG text glyphs stretch right along with
// it: on a card much wider than the chart's native viewBox, that reads as visibly distorted,
// oversized, ugly text — not a font problem, a "text living inside a non-uniformly scaled
// coordinate system" problem. HTML text outside the SVG never has that issue and just uses
// whatever font the rest of the page already does.
//
// formatValue/formatLabel are per-caller — the same chart component gets reused for wildly
// different units (ETN, gwei, seconds, plain counts) and granularities (daily vs hourly), so
// there's no one sensible default beyond "stringify it".
//
// colorBySign (opt-in, default off — every existing caller keeps its plain all-green line/area
// unchanged): colors the line/area red wherever the value is negative, green wherever it's >= 0
// (zero stays green), splitting each segment exactly at its zero-crossing — interpolated in value
// space between the two data points that straddle it, not just recolored at the nearest point —
// so the color boundary lands where the line actually crosses zero. Built for a PnL chart, where
// "am I currently up or down" is the whole point of the color.
export default function SparklineChart({ data, height = 140, width = 280, formatValue = identity, formatLabel = identity, colorBySign = false }) {
  const svgRef = useRef(null);
  const [hoverIndex, setHoverIndex] = useState(null);

  const clean = data.filter((d) => typeof d.value === "number" && Number.isFinite(d.value));
  if (clean.length < 2) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#666" }}>
        Not enough data
      </div>
    );
  }

  const min = Math.min(...clean.map((d) => d.value));
  const max = Math.max(...clean.map((d) => d.value));
  const mid = (min + max) / 2;
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const valueToY = (v) => height - ((v - min) / range) * height;

  const coords = data.map((d, i) => {
    if (typeof d.value !== "number" || !Number.isFinite(d.value)) return null;
    return [i * stepX, valueToY(d.value)];
  });

  // Break into separate polyline segments at any gap (null point) instead of one path — avoids
  // drawing a straight line across missing data. First grouped into gap-free "runs" by data
  // INDEX (not yet colored) — colorBySign then further splits each run at every zero-crossing;
  // without it, each run becomes exactly one 'positive'-tagged segment (identical to this
  // component's original, uncolored behavior).
  const runs = [];
  let currentRun = [];
  for (let i = 0; i < coords.length; i++) {
    if (coords[i]) {
      currentRun.push(i);
    } else if (currentRun.length) {
      runs.push(currentRun);
      currentRun = [];
    }
  }
  if (currentRun.length) runs.push(currentRun);

  const signOf = (i) => (data[i].value >= 0 ? "positive" : "negative"); // 0 counts as positive — stays green
  const zeroY = valueToY(0);

  const segments = []; // [{ points: [[x,y], ...], sign: 'positive' | 'negative' }]
  for (const run of runs) {
    if (!colorBySign) {
      segments.push({ points: run.map((i) => coords[i]), sign: "positive" });
      continue;
    }
    let piece = [coords[run[0]]];
    let pieceSign = signOf(run[0]);
    for (let k = 1; k < run.length; k++) {
      const i = run[k];
      const prevI = run[k - 1];
      const curSign = signOf(i);
      if (curSign !== pieceSign) {
        // Linear interpolation of the zero-crossing in VALUE space (not pixel space — same
        // result, since valueToY is itself linear, but this reads directly off the real values
        // rather than an already-transformed coordinate).
        const vPrev = data[prevI].value;
        const vCur = data[i].value;
        const t = vPrev / (vPrev - vCur); // vPrev/vCur have opposite signs here, so t is in (0, 1)
        const [x0] = coords[prevI];
        const [x1] = coords[i];
        const crossPoint = [x0 + t * (x1 - x0), zeroY];
        piece.push(crossPoint);
        segments.push({ points: piece, sign: pieceSign });
        piece = [crossPoint, coords[i]];
        pieceSign = curSign;
      } else {
        piece.push(coords[i]);
      }
    }
    segments.push({ points: piece, sign: pieceSign });
  }

  const areaPath = (points) => {
    const line = points.map((c) => c.join(",")).join(" ");
    const [firstX] = points[0];
    const [lastX] = points[points.length - 1];
    return `M${firstX},${height} L${line} L${lastX},${height} Z`;
  };

  // Only when colorBySign is actually splitting the line (the range genuinely straddles zero) —
  // an extra reference line right at the split, distinct from the plain min/mid/max ones, so it's
  // clear at a glance where "positive" ends and "negative" begins.
  const showZeroLine = colorBySign && min < 0 && max > 0;

  const updateHover = (clientX) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fraction = (clientX - rect.left) / rect.width;
    const index = Math.round(fraction * (data.length - 1));
    const clamped = Math.max(0, Math.min(data.length - 1, index));
    setHoverIndex(coords[clamped] ? clamped : null);
  };

  const hoverCoord = hoverIndex != null ? coords[hoverIndex] : null;
  const hoverPoint = hoverIndex != null ? data[hoverIndex] : null;

  // Flip the tooltip to the left half once the point is past the chart's midpoint, so it never
  // renders itself half off the edge of the card.
  const tooltipAlign = hoverCoord && hoverCoord[0] > width / 2 ? "right" : "left";

  return (
    <div style={{ display: "flex", gap: 8 }}>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height, flexShrink: 0 }}>
        {[max, mid, min].map((v, i) => (
          <div key={i} style={{ fontSize: 10, color: muted, textAlign: "right", lineHeight: 1 }}>{formatValue(v)}</div>
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
            {[max, mid, min].map((v, i) => (
              <line key={i} x1={0} y1={valueToY(v)} x2={width} y2={valueToY(v)} stroke={border} strokeWidth={0.5} strokeDasharray="2,2" />
            ))}
            {showZeroLine && (
              <line x1={0} y1={zeroY} x2={width} y2={zeroY} stroke={mutedLight} strokeWidth={0.75} strokeDasharray="4,2" />
            )}

            {segments.map((segment, i) => (
              <path key={`area-${i}`} d={areaPath(segment.points)} fill={segment.sign === "negative" ? errorGlow : greenGlow} stroke="none" />
            ))}
            {segments.map((segment, i) => (
              <polyline
                key={`line-${i}`}
                points={segment.points.map((c) => c.join(",")).join(" ")}
                fill="none"
                stroke={segment.sign === "negative" ? error : green}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}

            {hoverCoord && (
              <>
                <line x1={hoverCoord[0]} y1={0} x2={hoverCoord[0]} y2={height} stroke={mutedLight} strokeWidth={1} strokeDasharray="3,3" />
                <circle
                  cx={hoverCoord[0]}
                  cy={hoverCoord[1]}
                  r={4}
                  fill={colorBySign && hoverPoint?.value < 0 ? error : green}
                  stroke={panel}
                  strokeWidth={1.5}
                />
              </>
            )}
          </svg>

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
              <div style={{ color: "#fff", fontWeight: 700 }}>{formatValue(hoverPoint.value)}</div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
          <span style={{ fontSize: 10, color: muted }}>{formatLabel(data[0].label)}</span>
          <span style={{ fontSize: 10, color: muted }}>{formatLabel(data[Math.round((data.length - 1) / 2)].label)}</span>
          <span style={{ fontSize: 10, color: muted }}>{formatLabel(data[data.length - 1].label)}</span>
        </div>
      </div>
    </div>
  );
}
