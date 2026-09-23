import React, { useMemo, useRef, useState } from "react";
import { green, error as red, muted, mutedLight, border } from "../theme.js";
import { formatUsdCompact } from "../utils/format.js";
import { barRange, niceTicks } from "../utils/hyperlaneSeries.js";
import { monthTicks } from "../utils/bridgeSeries.js";

// Net USD flow per day over the rolling window: a bar UP (green) for a day more came onto Electroneum than
// left, DOWN (red) for the opposite. Drawn in a 0-100 x 0-100 viewBox stretched to the container with every
// label/marker as an HTML overlay positioned in % — same approach as BridgeChart.jsx/SparklineChart.jsx.
const PAD = 6; // % kept clear above the tallest bar / below the lowest
const Y_AXIS_WIDTH = 50;

export const signedUsd = (v) => (v < 0 ? "−" : v > 0 ? "+" : "") + formatUsdCompact(Math.abs(v));
const usdFull = (v) => formatUsdCompact(v);
const dayLabel = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const monthLabel = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
const shortDayLabel = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

// The 12-month view labels months; the 7/30/90-day views label days instead (a month tick would leave a 7-day
// chart with no labels at all). `step` keeps roughly 5-7 labels on the axis. Each day tick sits mid-bar.
const DAY_MS = 86400000;
const MONTH_VIEW_MIN_DAYS = 120;
function axisTicks(rows, startMs, endMs) {
  const n = rows.length;
  if (n >= MONTH_VIEW_MIN_DAYS) return monthTicks(startMs, endMs, 2).map((t) => ({ t, label: monthLabel(t) }));
  const step = n <= 7 ? 1 : n <= 31 ? 5 : 15;
  const ticks = [];
  for (let i = 0; i < n; i += step) ticks.push({ t: rows[i].t + DAY_MS / 2, label: shortDayLabel(rows[i].t) });
  return ticks;
}

// `height` is the plot height in px; `compact` = a small per-chain panel (fewer y ticks); `showXAxis` = month labels
// under the plot (only the bottom panel of a stack needs them).
export default function HyperlaneChart({ rows, height = 240, compact = false, showXAxis = true }) {
  const HEIGHT = height;
  const wrapRef = useRef(null);
  const [hoverIndex, setHoverIndex] = useState(null);

  const [lo, hi] = useMemo(() => barRange(rows), [rows]);
  const n = rows.length;
  const startMs = rows[0].t;
  const endMs = rows[n - 1].t + 86400000;

  const y = (v) => PAD + ((hi - v) / (hi - lo)) * (100 - 2 * PAD);
  const xPct = (i) => (i / n) * 100;
  const barW = (100 / n) * 0.78;

  const quiet = useMemo(() => rows.every((r) => r.net === 0), [rows]); // nothing to scale: just the zero line
  const yTickValues = useMemo(() => (quiet ? [0] : niceTicks(lo, hi, compact ? 2 : 5)), [lo, hi, quiet, compact]);
  const xTicks = useMemo(() => axisTicks(rows, startMs, endMs), [rows, startMs, endMs]);

  const onMove = (clientX) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const f = Math.min(0.999999, Math.max(0, (clientX - rect.left) / rect.width));
    setHoverIndex(Math.floor(f * n));
  };
  const hover = hoverIndex === null ? null : rows[hoverIndex];

  return (
    <div style={{ position: "relative", height: HEIGHT + (showXAxis ? 22 : 0) }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: Y_AXIS_WIDTH - 6, height: HEIGHT }}>
        {yTickValues.map((v) => (
          <div key={v} style={{ position: "absolute", right: 0, top: `${y(v)}%`, transform: "translateY(-50%)", fontSize: 10, color: v === 0 ? mutedLight : muted, fontWeight: v === 0 ? 700 : 400, whiteSpace: "nowrap" }}>
            {v === 0 ? "0" : signedUsd(v)}
          </div>
        ))}
      </div>

      <div
        ref={wrapRef}
        style={{ position: "relative", height: HEIGHT, marginLeft: Y_AXIS_WIDTH, touchAction: "pan-y", cursor: "crosshair" }}
        onMouseMove={(e) => onMove(e.clientX)}
        onMouseLeave={() => setHoverIndex(null)}
        onTouchStart={(e) => onMove(e.touches[0].clientX)}
        onTouchMove={(e) => onMove(e.touches[0].clientX)}
        onTouchEnd={() => setHoverIndex(null)}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}>
          {yTickValues.filter((v) => v !== 0).map((v) => (
            <line key={v} x1="0" x2="100" y1={y(v)} y2={y(v)} stroke={border} strokeOpacity="0.5" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          {rows.map((r, i) => {
            if (r.net === 0) return null;
            const top = r.net > 0 ? y(r.net) : y(0);
            const h = Math.max(Math.abs(y(r.net) - y(0)), 0.4); // hairline minimum so a tiny day is still visible
            return (
              <rect key={r.date} x={xPct(i) + (100 / n - barW) / 2} y={top} width={barW} height={h} fill={r.net > 0 ? green : red} opacity={hoverIndex === i ? 1 : 0.85} />
            );
          })}
          <line x1="0" x2="100" y1={y(0)} y2={y(0)} stroke={mutedLight} strokeOpacity="0.8" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {hover && <line x1={xPct(hoverIndex) + 50 / n} x2={xPct(hoverIndex) + 50 / n} y1={PAD} y2={100 - PAD} stroke="#fff" strokeOpacity="0.3" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
        </svg>

        {hover && (
          <div
            style={{
              position: "absolute",
              top: 4,
              ...(xPct(hoverIndex) > 55 ? { right: `${100 - xPct(hoverIndex)}%`, marginRight: 10 } : { left: `${xPct(hoverIndex)}%`, marginLeft: 10 }),
              background: "rgba(10,10,10,0.95)",
              border: `1px solid ${border}`,
              borderRadius: 4,
              padding: "6px 9px",
              fontSize: 11,
              color: "#fff",
              pointerEvents: "none",
              whiteSpace: "nowrap",
              zIndex: 2,
            }}
          >
            <div style={{ color: mutedLight, marginBottom: 3 }}>{dayLabel(hover.t)}</div>
            <div>Net <span style={{ color: hover.net > 0 ? green : hover.net < 0 ? red : "#fff", fontWeight: 800 }}>{signedUsd(hover.net)}</span></div>
            <div style={{ color: mutedLight }}>In {usdFull(hover.inflow)} · Out {usdFull(hover.outflow)}</div>
            {hover.count > 0 && <div style={{ color: muted }}>{hover.count} transfer{hover.count === 1 ? "" : "s"}</div>}
          </div>
        )}
      </div>

      {showXAxis && (
        <div style={{ position: "absolute", left: Y_AXIS_WIDTH, right: 0, top: HEIGHT + 6, height: 14 }}>
          {xTicks.map((tick) => (
            <div key={tick.t} style={{ position: "absolute", left: `${((tick.t - startMs) / (endMs - startMs)) * 100}%`, transform: "translateX(-50%)", fontSize: 10, color: muted, whiteSpace: "nowrap" }}>{tick.label}</div>
          ))}
        </div>
      )}
    </div>
  );
}
