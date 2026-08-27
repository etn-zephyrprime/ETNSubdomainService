import React, { useRef, useState } from "react";
import { green, blue, muted, mutedLight, panel, border } from "../theme.js";

const identity = (v) => String(v);

// Hand-rolled SVG combo chart — bars for one series, an overlaid line for a second, sharing one
// Y-axis. Same conventions as SparklineChart.jsx (HTML tooltip/axis labels outside the SVG, for
// the same non-uniform-scaling-distorts-<text> reason). Built specifically for "domain
// activations + subname registrations per day" — bars for activations (discrete, usually small
// counts) with subname registrations as a line on top, rather than either blending both into one
// number or stacking them (a stack implies "these sum to a meaningful total," which they don't —
// they're two different kinds of event, just sharing a day axis). `data` is `{ label, a, b }[]`,
// oldest first — `a` renders as bars, `b` as a line.
export default function ActivityComboChart({
  data,
  height = 140,
  width = 280,
  formatLabel = identity,
  seriesALabel = "A",
  seriesBLabel = "B",
  colorA = green,
  colorB = blue,
}) {
  const svgRef = useRef(null);
  const [hoverIndex, setHoverIndex] = useState(null);

  const clean = data.filter((d) => Number.isFinite(d.a) && Number.isFinite(d.b));
  if (clean.length < 2) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#666" }}>
        Not enough data
      </div>
    );
  }

  const max = Math.max(...data.map((d) => d.a || 0), ...data.map((d) => d.b || 0), 1);
  const mid = max / 2;
  const valueToY = (v) => height - (v / max) * height;

  const barGap = 2;
  const barWidth = Math.max(1, width / data.length - barGap);
  const stepX = width / data.length;

  // Line points sit at each bar's horizontal center, so the two series visually line up on the
  // same day rather than the line looking offset from its own bar.
  const linePoints = data.map((d, i) => [i * stepX + stepX / 2, valueToY(d.b || 0)]);

  const updateHover = (clientX) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fraction = (clientX - rect.left) / rect.width;
    const index = Math.floor(fraction * data.length);
    setHoverIndex(Math.max(0, Math.min(data.length - 1, index)));
  };

  const hoverPoint = hoverIndex != null ? data[hoverIndex] : null;
  const hoverX = hoverIndex != null ? hoverIndex * stepX + stepX / 2 : null;
  const tooltipAlign = hoverX != null && hoverX > width / 2 ? "right" : "left";

  return (
    <div>
      <div style={{ display: "flex", gap: 14, marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: mutedLight }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: colorA, display: "inline-block" }} />
          {seriesALabel}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: mutedLight }}>
          <span style={{ width: 8, height: 2, background: colorB, display: "inline-block" }} />
          {seriesBLabel}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height, flexShrink: 0 }}>
          {[max, mid, 0].map((v, i) => (
            <div key={i} style={{ fontSize: 10, color: muted, textAlign: "right", lineHeight: 1 }}>{Math.round(v)}</div>
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
              {[max, mid, 0].map((v, i) => (
                <line key={i} x1={0} y1={valueToY(v)} x2={width} y2={valueToY(v)} stroke={border} strokeWidth={0.5} strokeDasharray="2,2" />
              ))}

              {data.map((d, i) => {
                const barHeight = height - valueToY(d.a || 0);
                if (barHeight <= 0) return null;
                const x = i * stepX + barGap / 2;
                const isHovered = hoverIndex === i;
                return (
                  <rect
                    key={i}
                    x={x}
                    y={valueToY(d.a || 0)}
                    width={barWidth}
                    height={barHeight}
                    fill={colorA}
                    opacity={hoverIndex == null || isHovered ? 1 : 0.45}
                  />
                );
              })}

              <polyline
                points={linePoints.map((c) => c.join(",")).join(" ")}
                fill="none"
                stroke={colorB}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {linePoints.map(([x, y], i) => (
                <circle key={i} cx={x} cy={y} r={hoverIndex === i ? 3.5 : 2} fill={colorB} />
              ))}

              {hoverX != null && (
                <line x1={hoverX} y1={0} x2={hoverX} y2={height} stroke={mutedLight} strokeWidth={1} strokeDasharray="3,3" />
              )}
            </svg>

            {hoverPoint && hoverX != null && (
              <div
                style={{
                  position: "absolute",
                  left: `${(hoverX / width) * 100}%`,
                  top: 0,
                  transform: `translate(${tooltipAlign === "right" ? "-100%" : "0%"}, -8px)`,
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
                <div style={{ color: colorA, fontWeight: 700 }}>{seriesALabel}: {hoverPoint.a || 0}</div>
                <div style={{ color: colorB, fontWeight: 700 }}>{seriesBLabel}: {hoverPoint.b || 0}</div>
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
    </div>
  );
}
