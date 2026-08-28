import React, { useMemo, useState } from "react";
import { border, muted, mutedLight, panel } from "../theme.js";
import { formatInt, formatEtnBalance } from "../utils/format.js";

const CELL_SIZE = 20;
const CELL_GAP = 3;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function intensityColor(value, max) {
  if (!max || !value) return "#1a1a1a";
  const t = Math.min(1, value / max);
  const lightness = 14 + t * 42;
  return `hsl(120, 65%, ${lightness}%)`;
}

const DAY_LABEL = (dateStr) => new Date(`${dateStr}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: "UTC" });

// Day (row) × hour-of-day (column) activity grid for the trailing 7 real UTC days — same
// brightness-by-tx-count convention as CalendarHeatmap.jsx, at hourly instead of daily
// granularity. Real ETN volume transferred (hourlyActivityCache.js — nothing else tracks this at
// all, see that file's header comment) shows in the tooltip alongside tx count, hour by hour.
export default function WeekHourHeatmap({ hours }) {
  const [hoverKey, setHoverKey] = useState(null);

  const { rows, maxTx } = useMemo(() => {
    const today = new Date();
    const rows = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      rows.push({
        date: dateStr,
        cells: HOURS.map((h) => {
          const key = `${dateStr}T${String(h).padStart(2, "0")}`;
          return { key, hour: h, entry: hours?.[key] || null };
        }),
      });
    }
    const maxTx = Math.max(1, ...rows.flatMap((r) => r.cells.map((c) => c.entry?.txCount || 0)));
    return { rows, maxTx };
  }, [hours]);

  const hoveredCell = hoverKey ? rows.flatMap((r) => r.cells).find((c) => c.key === hoverKey) : null;

  if (!hours || Object.keys(hours).length === 0) {
    return (
      <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted }}>
        Collecting real hourly activity data — check back shortly.
      </div>
    );
  }

  return (
    <div>
      <div style={{ overflowX: "auto", paddingBottom: 4 }}>
        <div style={{ display: "inline-flex", flexDirection: "column", gap: CELL_GAP }}>
          {rows.map((row) => (
            <div key={row.date} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 56, flexShrink: 0, fontSize: 10, color: mutedLight, textAlign: "right" }}>{DAY_LABEL(row.date)}</div>
              <div style={{ display: "flex", gap: CELL_GAP }}>
                {row.cells.map((c) => (
                  <div
                    key={c.key}
                    onMouseEnter={() => setHoverKey(c.key)}
                    onMouseLeave={() => setHoverKey((k) => (k === c.key ? null : k))}
                    style={{
                      width: CELL_SIZE,
                      height: CELL_SIZE,
                      borderRadius: 3,
                      background: intensityColor(c.entry?.txCount || 0, maxTx),
                      cursor: c.entry ? "pointer" : "default",
                      outline: hoverKey === c.key ? `1px solid ${mutedLight}` : "none",
                    }}
                  />
                ))}
              </div>
            </div>
          ))}

          <div style={{ display: "flex", gap: CELL_GAP, marginLeft: 64 }}>
            {HOURS.map((h) => (
              <div key={h} style={{ width: CELL_SIZE, fontSize: 9, color: muted, textAlign: "center" }}>
                {h % 6 === 0 ? h : ""}
              </div>
            ))}
          </div>
        </div>
      </div>

      {hoveredCell && (
        <div
          style={{
            marginTop: 10,
            display: "inline-block",
            background: panel,
            border: `1px solid ${border}`,
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 11,
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            minWidth: 200,
          }}
        >
          <div style={{ color: "#fff", fontWeight: 700, marginBottom: 4 }}>
            {hoveredCell.key.replace("T", " ")}:00 UTC
          </div>
          {hoveredCell.entry ? (
            <>
              <div style={{ color: mutedLight }}>{formatInt(hoveredCell.entry.txCount)} txs</div>
              <div style={{ color: mutedLight }}>{formatEtnBalance(hoveredCell.entry.etnVolumeWei)} ETN transferred</div>
            </>
          ) : (
            <div style={{ color: mutedLight }}>No data yet</div>
          )}
        </div>
      )}
    </div>
  );
}
