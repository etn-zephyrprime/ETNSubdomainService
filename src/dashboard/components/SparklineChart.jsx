import React from "react";
import { green, greenGlow } from "../theme.js";

// Small hand-rolled SVG line chart — no charting library dependency for what's just a handful of
// points (Blockscout's chart endpoints return ~30-90 daily data points at most). `points` is an
// array of plain numbers, oldest first; nulls/undefined are skipped when computing the scale but
// still leave a gap in the line rather than being coerced to 0 (a missing day's data shouldn't
// visually read as "value crashed to zero").
export default function SparklineChart({ points, height = 60, width = 280 }) {
  const clean = points.filter((p) => typeof p === "number" && Number.isFinite(p));
  if (clean.length < 2) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#666" }}>
        Not enough data
      </div>
    );
  }

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);

  const coords = points.map((p, i) => {
    if (typeof p !== "number" || !Number.isFinite(p)) return null;
    const x = i * stepX;
    const y = height - ((p - min) / range) * height;
    return [x, y];
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

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none">
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
    </svg>
  );
}
