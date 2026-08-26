import React, { useRef, useState } from "react";
import { green, greenGlow, muted, mutedLight, panel, border } from "../theme.js";

// Reserved space (in viewBox units) for axis labels — the actual line/area only ever gets drawn
// inside [AXIS_LEFT, width] x [AXIS_TOP, height - AXIS_BOTTOM], everything outside that is text.
// AXIS_TOP exists solely so the topmost Y-axis label (vertically centered on the max-value
// gridline, which otherwise sits exactly on y=0) has room to render without its top half getting
// clipped by whatever sits directly above the chart.
const AXIS_LEFT = 46;
const AXIS_TOP = 7;
const AXIS_BOTTOM = 16;

const identity = (v) => String(v);

// Hand-rolled SVG line chart — no charting library dependency for what's just a handful of points
// (Blockscout's chart endpoints return ~30-90 points at most, dashboardStatsCache.js's hourly
// snapshots similarly small). `data` is an array of `{ label, value }`, oldest first — `label` is
// whatever formatLabel(label) can turn into a date/time string, `value` a number or null/undefined
// for a gap (a missing day's data shouldn't visually read as "value crashed to zero", so gaps
// break the line into separate segments rather than dropping to 0).
//
// formatValue/formatLabel are per-caller — the same chart component gets reused for wildly
// different units (ETN, gwei, seconds, plain counts) and granularities (daily vs hourly), so
// there's no one sensible default beyond "stringify it".
export default function SparklineChart({ data, height = 60, width = 280, formatValue = identity, formatLabel = identity }) {
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

  const plotWidth = width - AXIS_LEFT;
  const plotBottom = height - AXIS_BOTTOM;
  const plotHeight = plotBottom - AXIS_TOP;
  const stepX = plotWidth / (data.length - 1);
  const valueToY = (v) => plotBottom - ((v - min) / range) * plotHeight;

  const coords = data.map((d, i) => {
    if (typeof d.value !== "number" || !Number.isFinite(d.value)) return null;
    const x = AXIS_LEFT + i * stepX;
    return [x, valueToY(d.value)];
  });

  // Break into separate polyline segments at any gap (null point) instead of one path — avoids
  // drawing a straight line across missing data.
  const segments = [];
  let current = [];
  for (const c of coords) {
    if (c) {
      current.push(c);
    } else if (current.length) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);

  const areaPath = (segment) => {
    const line = segment.map((c) => c.join(",")).join(" ");
    const [firstX] = segment[0];
    const [lastX] = segment[segment.length - 1];
    return `M${firstX},${plotBottom} L${line} L${lastX},${plotBottom} Z`;
  };

  // X-axis ticks at start/~1/3/~2/3/end — few enough to never overlap even on a narrow card.
  const xTickIndexes = [...new Set([0, Math.round((data.length - 1) / 3), Math.round(((data.length - 1) * 2) / 3), data.length - 1])];

  const updateHover = (clientX) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewBoxX = ((clientX - rect.left) / rect.width) * width;
    const fraction = (viewBoxX - AXIS_LEFT) / plotWidth;
    const index = Math.round(fraction * (data.length - 1));
    const clamped = Math.max(0, Math.min(data.length - 1, index));
    setHoverIndex(coords[clamped] ? clamped : null);
  };

  const hoverCoord = hoverIndex != null ? coords[hoverIndex] : null;
  const hoverPoint = hoverIndex != null ? data[hoverIndex] : null;

  // Flip the tooltip to the left half once the point is past the chart's midpoint, so it never
  // renders itself half off the edge of the card.
  const tooltipAlign = hoverCoord && hoverCoord[0] > AXIS_LEFT + plotWidth / 2 ? "right" : "left";

  return (
    <div style={{ position: "relative" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        onMouseMove={(e) => updateHover(e.clientX)}
        onMouseLeave={() => setHoverIndex(null)}
        style={{ cursor: "crosshair" }}
      >
        {/* Y-axis labels + gridlines */}
        {[max, mid, min].map((v, i) => {
          const y = valueToY(v);
          return (
            <g key={i}>
              <line x1={AXIS_LEFT} y1={y} x2={width} y2={y} stroke={border} strokeWidth={0.5} strokeDasharray="2,2" />
              <text x={AXIS_LEFT - 6} y={y} dy="0.32em" textAnchor="end" fontSize={9} fill={muted}>
                {formatValue(v)}
              </text>
            </g>
          );
        })}

        {/* X-axis labels */}
        {xTickIndexes.map((i) => (
          <text
            key={i}
            x={coords[i] ? coords[i][0] : AXIS_LEFT + i * stepX}
            y={height - 2}
            textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"}
            fontSize={9}
            fill={muted}
          >
            {formatLabel(data[i].label)}
          </text>
        ))}

        {segments.map((segment, i) => (
          <path key={`area-${i}`} d={areaPath(segment)} fill={greenGlow} stroke="none" />
        ))}
        {segments.map((segment, i) => (
          <polyline
            key={`line-${i}`}
            points={segment.map((c) => c.join(",")).join(" ")}
            fill="none"
            stroke={green}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {hoverCoord && (
          <>
            <line x1={hoverCoord[0]} y1={AXIS_TOP} x2={hoverCoord[0]} y2={plotBottom} stroke={mutedLight} strokeWidth={1} strokeDasharray="3,3" />
            <circle cx={hoverCoord[0]} cy={hoverCoord[1]} r={4} fill={green} stroke={panel} strokeWidth={1.5} />
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
          }}
        >
          <div style={{ color: mutedLight, marginBottom: 2 }}>{formatLabel(hoverPoint.label, true)}</div>
          <div style={{ color: "#fff", fontWeight: 700 }}>{formatValue(hoverPoint.value)}</div>
        </div>
      )}
    </div>
  );
}
