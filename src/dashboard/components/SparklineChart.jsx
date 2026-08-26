import React, { useRef, useState } from "react";
import { green, greenGlow, muted, mutedLight, panel, border } from "../theme.js";

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
export default function SparklineChart({ data, height = 140, width = 280, formatValue = identity, formatLabel = identity }) {
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
    return `M${firstX},${height} L${line} L${lastX},${height} Z`;
  };

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
                <line x1={hoverCoord[0]} y1={0} x2={hoverCoord[0]} y2={height} stroke={mutedLight} strokeWidth={1} strokeDasharray="3,3" />
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
