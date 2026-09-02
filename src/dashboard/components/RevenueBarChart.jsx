import React, { useRef, useState } from "react";
import { green, muted, mutedLight, panel, border } from "../theme.js";

const identity = (v) => String(v);

// Hand-rolled SVG bar chart — single series, own Y-axis. Deliberately NOT reusing
// ActivityComboChart.jsx despite the near-identical bar-drawing code: that component always
// renders a second series as an overlaid line sharing the SAME Y-axis scale as the bars, which
// works for "two different counts of small numbers" (activations vs. registrations) but would be
// actively misleading here — mixing an ETN revenue amount with an event count on one axis would
// squash whichever series has the smaller range into an unreadable flat line. Same conventions as
// SparklineChart.jsx/ActivityComboChart.jsx otherwise (HTML tooltip/axis labels outside the SVG,
// non-uniform scaling). `data` is `{ label, value }[]`, oldest first.
export default function RevenueBarChart({ data, height = 140, width = 280, formatValue = identity, formatLabel = identity, color = green }) {
  const svgRef = useRef(null);
  const [hoverIndex, setHoverIndex] = useState(null);

  const clean = data.filter((d) => Number.isFinite(d.value));
  if (clean.length < 2) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#666" }}>
        Not enough data
      </div>
    );
  }

  const max = Math.max(...data.map((d) => d.value || 0), 1);
  const mid = max / 2;
  const valueToY = (v) => height - (v / max) * height;

  const barGap = 2;
  const barWidth = Math.max(1, width / data.length - barGap);
  const stepX = width / data.length;

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
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height, flexShrink: 0 }}>
          {[max, mid, 0].map((v, i) => (
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
              {[max, mid, 0].map((v, i) => (
                <line key={i} x1={0} y1={valueToY(v)} x2={width} y2={valueToY(v)} stroke={border} strokeWidth={0.5} strokeDasharray="2,2" />
              ))}

              {data.map((d, i) => {
                const barHeight = height - valueToY(d.value || 0);
                if (barHeight <= 0) return null;
                const x = i * stepX + barGap / 2;
                const isHovered = hoverIndex === i;
                return (
                  <rect
                    key={i}
                    x={x}
                    y={valueToY(d.value || 0)}
                    width={barWidth}
                    height={barHeight}
                    fill={color}
                    opacity={hoverIndex == null || isHovered ? 1 : 0.45}
                  />
                );
              })}

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
                <div style={{ color, fontWeight: 700 }}>{formatValue(hoverPoint.value || 0)}</div>
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
