import React from "react";
import { green, greenGlow, muted, mutedLight, panel2, border } from "../theme.js";
import SparklineChart from "./SparklineChart.jsx";

// A row of clickable stat tiles sharing one chart underneath — clicking a tile swaps which
// series the chart shows, rather than one static chart per metric. Used by both Overview.jsx
// (network-wide stats) and AddressLookup.jsx (per-wallet stats); the two just feed it different
// tiles/series.
export default function TileChart({ tiles, activeId, onSelect, data, formatValue, formatLabel, chartCaption, loading }) {
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
                textAlign: "left",
                padding: 14,
                borderRadius: 12,
                background: panel2,
                border: `1px solid ${isActive ? green : border}`,
                boxShadow: isActive ? `0 0 12px ${greenGlow}` : "none",
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: isActive ? green : muted, marginBottom: 6 }}>
                {tile.label}
              </div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#fff" }}>{tile.value}</div>
            </button>
          );
        })}
      </div>

      <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}` }}>
        <div style={{ fontSize: 11, color: mutedLight, marginBottom: 8 }}>{chartCaption}</div>
        {loading ? (
          <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted }}>
            Loading…
          </div>
        ) : (
          <SparklineChart data={data} height={140} formatValue={formatValue} formatLabel={formatLabel} />
        )}
      </div>
    </div>
  );
}
