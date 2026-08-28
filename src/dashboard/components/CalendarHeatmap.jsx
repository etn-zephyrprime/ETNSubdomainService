import React, { useMemo, useState } from "react";
import { border, muted, mutedLight, panel, VALIDATOR_PALETTE } from "../theme.js";
import { formatInt, shortHash } from "../utils/format.js";

const CELL_SIZE = 11;
const CELL_GAP = 3;
const TOP_VALIDATORS = 9; // + "Other" as a 10th bucket — bounds the legend regardless of how many validators actually produced blocks in the window
const OTHER_COLOR = muted;

function intensityColor(value, max) {
  if (!max || !value) return "#1a1a1a"; // no data / zero that day — flat dark neutral, not "0% green"
  const t = Math.min(1, value / max);
  const lightness = 14 + t * 42; // 14% (dark) → 56% (bright), same hue throughout
  return `hsl(120, 65%, ${lightness}%)`;
}

// GitHub-contribution-style calendar: one column per week, one row per day-of-week (Sun..Sat),
// covering the trailing `daysBack` real days found in `days` (dailyBlockStatsCache.js's published
// map — thin at first while that cache's backfill is still running, growing toward the full
// window over several hours, same "starts thin" shape as this app's other on-chain caches).
//
// Cell brightness = that day's tx count (as asked — darker for lower, brighter for higher).
// Validators deliberately aren't the cell's own color: confirmed live that this chain's block
// producers round-robin fast enough (4 different validators in 4 consecutive blocks) that a
// single color per *day* couldn't meaningfully represent "which validator" anyway — every day
// mixes dozens of them roughly evenly. Instead, the legend assigns the window's most active
// validators a fixed color each, and hovering a day shows that day's real breakdown against it.
export default function CalendarHeatmap({ days }) {
  const [hoverDate, setHoverDate] = useState(null);

  const { cells, weeks, maxTx, validatorColors, topValidators } = useMemo(() => {
    const daysBack = 90;
    const today = new Date();
    const list = [];
    for (let i = daysBack - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      list.push({ date: dateStr, dayOfWeek: d.getUTCDay(), entry: days?.[dateStr] || null });
    }

    const maxTx = Math.max(1, ...list.map((d) => d.entry?.txCount || 0));

    // Rank validators by total blocks produced across the whole visible window, not per-day —
    // a consistent global ranking is what makes the legend (and each day's color-coded breakdown)
    // mean the same thing on every cell, rather than reshuffling colors day to day.
    const totals = new Map();
    for (const d of list) {
      if (!d.entry) continue;
      for (const [addr, count] of Object.entries(d.entry.validators || {})) {
        totals.set(addr, (totals.get(addr) || 0) + count);
      }
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const topValidators = ranked.slice(0, TOP_VALIDATORS).map(([addr]) => addr);
    const validatorColors = new Map(topValidators.map((addr, i) => [addr, VALIDATOR_PALETTE[i]]));

    // Pad the front so the first real day lands in its correct day-of-week row (Sun=0..Sat=6).
    const leadingPad = list.length ? list[0].dayOfWeek : 0;
    const padded = [...Array(leadingPad).fill(null), ...list];
    const weeks = Math.ceil(padded.length / 7);
    const cells = padded;

    return { cells, weeks, maxTx, validatorColors, topValidators };
  }, [days]);

  const hovered = hoverDate ? cells.find((c) => c?.date === hoverDate) : null;

  if (!days || Object.keys(days).length === 0) {
    return (
      <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted }}>
        Collecting real daily block data — check back shortly.
      </div>
    );
  }

  return (
    <div>
      <div style={{ position: "relative", overflowX: "auto", paddingBottom: 4 }}>
        <div style={{ display: "grid", gridTemplateRows: `repeat(7, ${CELL_SIZE}px)`, gridAutoFlow: "column", gap: CELL_GAP, width: "max-content" }}>
          {cells.map((c, i) => {
            const tx = c?.entry?.txCount || 0;
            return (
              <div
                key={i}
                onMouseEnter={() => c && setHoverDate(c.date)}
                onMouseLeave={() => setHoverDate((d) => (d === c?.date ? null : d))}
                style={{
                  width: CELL_SIZE,
                  height: CELL_SIZE,
                  borderRadius: 2,
                  background: c ? intensityColor(tx, maxTx) : "transparent",
                  cursor: c?.entry ? "pointer" : "default",
                  outline: hoverDate === c?.date ? `1px solid ${mutedLight}` : "none",
                }}
              />
            );
          })}
        </div>

        {hovered && (
          <div
            style={{
              position: "sticky",
              left: 0,
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
            <div style={{ color: "#fff", fontWeight: 700, marginBottom: 4 }}>{hovered.date}</div>
            <div style={{ color: mutedLight, marginBottom: hovered.entry ? 6 : 0 }}>
              {hovered.entry ? `${formatInt(hovered.entry.txCount)} txs · ${formatInt(hovered.entry.blockCount)} blocks` : "No data yet"}
            </div>
            {hovered.entry && Object.keys(hovered.entry.validators || {}).length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {Object.entries(hovered.entry.validators)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 6)
                  .map(([addr, count]) => (
                    <div key={addr} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: validatorColors.get(addr) || OTHER_COLOR }} />
                      <span style={{ color: mutedLight, fontFamily: "monospace" }}>{shortHash(addr)}</span>
                      <span style={{ color: "#fff", marginLeft: "auto" }}>{count}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>

      {topValidators.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", marginTop: 14, paddingTop: 10, borderTop: `1px solid ${border}` }}>
          {topValidators.map((addr) => (
            <div key={addr} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: mutedLight }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: validatorColors.get(addr) }} />
              <span style={{ fontFamily: "monospace" }}>{shortHash(addr)}</span>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: mutedLight }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: OTHER_COLOR }} />
            <span>Other validators</span>
          </div>
        </div>
      )}
    </div>
  );
}
