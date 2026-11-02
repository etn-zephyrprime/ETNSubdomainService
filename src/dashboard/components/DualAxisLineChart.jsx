import React, { useRef, useState } from "react";
import { blue, orange, muted, mutedLight, panel, border } from "../theme.js";

const identity = (v) => String(v);

// Two lines, each on its own y-axis (left for `a`, right for `b`) — for two quantities in different
// units that move against each other, e.g. an LP position's token0 vs token1 amounts. Same
// hand-rolled SVG conventions as SparklineChart.jsx (see its header comment): the SVG stretches to
// fill its card, so axis labels and the tooltip are HTML, never SVG text, and the strokes are
// non-scaling so a steep line doesn't get fatter on a wide card.
//
// data: [{ label, a, b }] oldest first. a/b: { name, format(value) } for each series.
export default function DualAxisLineChart({ data, a, b, height = 160, width = 300, formatLabel = identity }) {
  const svgRef = useRef(null);
  const [hoverIndex, setHoverIndex] = useState(null);

  if (!data || data.length < 2) {
    return <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#666" }}>Not enough data</div>;
  }

  const scale = (key) => {
    const vals = data.map((d) => d[key]).filter((v) => Number.isFinite(v));
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (min === max) {
      min = min === 0 ? 0 : min * 0.95;
      max = max === 0 ? 1 : max * 1.05;
    }
    const pad = (max - min) * 0.06; // keep the lines off the top/bottom edge
    min = Math.max(0, min - pad);
    max += pad;
    return { min, max, mid: (min + max) / 2, y: (v) => height - ((v - min) / (max - min)) * height };
  };
  const sa = scale("a");
  const sb = scale("b");
  const stepX = width / (data.length - 1);
  const pts = (key, s) => data.map((d, i) => (Number.isFinite(d[key]) ? `${i * stepX},${s.y(d[key])}` : null)).filter(Boolean).join(" ");

  const updateHover = (clientX) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const i = Math.round(((clientX - rect.left) / rect.width) * (data.length - 1));
    setHoverIndex(Math.max(0, Math.min(data.length - 1, i)));
  };
  const hover = hoverIndex != null ? data[hoverIndex] : null;
  const hoverX = hoverIndex != null ? hoverIndex * stepX : null;
  const alignRight = hoverX != null && hoverX > width / 2;

  const axis = (s, fmt, color, align) => (
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height, flexShrink: 0 }}>
      {[s.max, s.mid, s.min].map((v, i) => (
        <div key={i} style={{ fontSize: 10, color, textAlign: align, lineHeight: 1 }}>{fmt(v)}</div>
      ))}
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 6, fontSize: 11, fontWeight: 700 }}>
        <span style={{ color: blue }}>━ {a.name} (left)</span>
        <span style={{ color: orange }}>{b.name} (right) ━</span>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {axis(sa, a.format, blue, "right")}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ position: "relative" }}>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${width} ${height}`}
              width="100%"
              height={height}
              preserveAspectRatio="none"
              onMouseMove={(e) => updateHover(e.clientX)}
              onTouchMove={(e) => e.touches[0] && updateHover(e.touches[0].clientX)}
              onMouseLeave={() => setHoverIndex(null)}
              style={{ cursor: "crosshair", display: "block" }}
            >
              {[0, height / 2, height].map((y, i) => (
                <line key={i} x1={0} y1={y} x2={width} y2={y} stroke={border} strokeWidth={0.5} strokeDasharray="2,2" vectorEffect="non-scaling-stroke" />
              ))}
              <polyline points={pts("a", sa)} fill="none" stroke={blue} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
              <polyline points={pts("b", sb)} fill="none" stroke={orange} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
              {hover && (
                <>
                  <line x1={hoverX} y1={0} x2={hoverX} y2={height} stroke={mutedLight} strokeWidth={1} strokeDasharray="3,3" vectorEffect="non-scaling-stroke" />
                  {Number.isFinite(hover.a) && <circle cx={hoverX} cy={sa.y(hover.a)} r={3.5} fill={blue} stroke={panel} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
                  {Number.isFinite(hover.b) && <circle cx={hoverX} cy={sb.y(hover.b)} r={3.5} fill={orange} stroke={panel} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
                </>
              )}
            </svg>
            {hover && (
              <div
                style={{
                  position: "absolute",
                  left: `${(hoverX / width) * 100}%`,
                  top: 4,
                  transform: `translateX(${alignRight ? "-100%" : "0%"})`,
                  marginLeft: alignRight ? -8 : 8,
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
                <div style={{ color: mutedLight, marginBottom: 2 }}>{formatLabel(hover.label, true)}</div>
                <div style={{ color: blue, fontWeight: 700 }}>{a.format(hover.a)} {a.name}</div>
                <div style={{ color: orange, fontWeight: 700 }}>{b.format(hover.b)} {b.name}</div>
              </div>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            <span style={{ fontSize: 10, color: muted }}>{formatLabel(data[0].label)}</span>
            <span style={{ fontSize: 10, color: muted }}>{formatLabel(data[Math.round((data.length - 1) / 2)].label)}</span>
            <span style={{ fontSize: 10, color: muted }}>{formatLabel(data[data.length - 1].label)}</span>
          </div>
        </div>
        {axis(sb, b.format, orange, "left")}
      </div>
    </div>
  );
}
