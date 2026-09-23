import React from "react";
import { green, greenGlow, muted, mutedLight, panel2, border, error as red, monoFont } from "../theme.js";
import SparklineChart from "./SparklineChart.jsx";
import CornerBrackets from "./CornerBrackets.jsx";

// A row of clickable stat tiles sharing one chart underneath — clicking a tile swaps which
// series the chart shows, rather than one static chart per metric. Used by both Overview.jsx
// (network-wide stats) and AddressLookup.jsx (per-wallet stats); the two just feed it different
// tiles/series.
// `renderChart` is an escape hatch for tiles whose active metric isn't a plain over-time line —
// Overview.jsx's "Total Blocks" (a 90-day calendar heatmap) and "Txs Last 7 Days" (a day×hour
// heatmap) both need an entirely different chart type, not just different data, when they're the
// active tile. Omit it (or return a falsy value) to keep the default SparklineChart — every
// existing caller (AddressLookup.jsx, Overview.jsx's other 4 metrics) is unaffected.
export default function TileChart({ tiles, activeId, onSelect, data, formatValue, formatLabel, chartCaption, loading, renderChart, strokeWidth, nonScalingStroke }) {
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
        {tiles.map((tile) => {
          const isActive = tile.id === activeId;
          return (
            <button
              key={tile.id}
              onClick={() => onSelect(tile.id)}
              style={{
                position: "relative",
                textAlign: "left",
                padding: 14,
                borderRadius: 4,
                background: panel2,
                border: `1px solid ${isActive ? green : border}`,
                boxShadow: isActive ? `0 0 12px ${greenGlow}` : "none",
                cursor: "pointer",
              }}
            >
              <CornerBrackets color={isActive ? green : border} />
              <div style={{ fontFamily: monoFont, fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: isActive ? green : muted, marginBottom: 6 }}>
                [ {tile.label} ]
              </div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#fff" }}>{tile.value}</div>
              {/* Optional small 7-day change marker (Overview passes it; per-wallet tiles don't). `change7d` null =
                  not enough history yet, shown as an em dash. */}
              {tile.changeText !== undefined && (
                <div style={{ fontSize: 10, fontWeight: 700, marginTop: 3, color: tile.change7d == null || tile.changeNeutral || Math.abs(tile.change7d) < 0.05 ? mutedLight : tile.change7d > 0 ? green : red }}>
                  <span style={{ color: muted, fontWeight: 600 }}>7D</span> {tile.changeText}
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ position: "relative", padding: 16, borderRadius: 4, background: panel2, border: `1px solid ${border}` }}>
        <CornerBrackets color={green} />
        <div style={{ fontSize: 11, color: mutedLight, marginBottom: 8 }}>{chartCaption}</div>
        {loading ? (
          <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted }}>
            Loading…
          </div>
        ) : renderChart ? (
          renderChart()
        ) : (
          <SparklineChart data={data} height={140} formatValue={formatValue} formatLabel={formatLabel} strokeWidth={strokeWidth} nonScalingStroke={nonScalingStroke} />
        )}
      </div>
    </div>
  );
}
