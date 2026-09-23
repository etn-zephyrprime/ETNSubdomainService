import React, { useMemo, useRef, useState } from "react";
import { green, orange, blue, muted, mutedLight, border, monoFont } from "../theme.js";
import { formatCompact } from "../utils/format.js";
import { DEADLINE_MS, FALLBACK_START_DAY, monthTicks, valueAt, yTicks } from "../utils/bridgeSeries.js";

// ETN still waiting in the bridge, from the day the contract was deployed to the migration deadline. The
// x-axis is real TIME (not point index) and always runs to the deadline, so today sits part-way along and
// the stretch after it is deliberately empty — except for the dashed forecast (trailing-pace) and dotted
// "required" path (the straight line to 0 that would hit the goal on the deadline).
//
// Drawn in a 0-100 x 0-100 viewBox stretched to the container (preserveAspectRatio="none") with
// non-scaling strokes; every label/marker is an HTML overlay positioned in %, so text is never distorted
// — the same approach as SparklineChart.jsx.
const PAD_TOP = 4; // % of height kept clear above the max and below 0, so the goal line and the top gridline
const PAD_BOTTOM = 8; // aren't clipped by the frame
const HEIGHT = 260;
const Y_AXIS_WIDTH = 46;

const monthLabel = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
const dayLabel = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default function BridgeChart({ series, total, forecast, nowMs }) {
  const wrapRef = useRef(null);
  const [hoverT, setHoverT] = useState(null);

  const startMs = useMemo(() => {
    const creation = Date.parse(`${FALLBACK_START_DAY}T00:00:00Z`);
    return series.length ? Math.min(creation, series[0].t) : creation;
  }, [series]);
  const endMs = DEADLINE_MS;

  const x = (t) => ((t - startMs) / (endMs - startMs)) * 100;
  const y = (v) => PAD_TOP + (1 - v / total) * (100 - PAD_TOP - PAD_BOTTOM);

  const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(3)},${y(p.remaining).toFixed(3)}`).join(" ");
  const linePath = useMemo(() => path(series), [series, startMs, total]); // eslint-disable-line react-hooks/exhaustive-deps
  const areaPath = series.length
    ? `${linePath} L${x(series[series.length - 1].t).toFixed(3)},${y(0)} L${x(series[0].t).toFixed(3)},${y(0)} Z`
    : "";

  const xTicks = useMemo(() => monthTicks(startMs, endMs, 6, { avoidMs: endMs }), [startMs, endMs]);
  const last = series[series.length - 1];

  const onMove = (clientX) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setHoverT(startMs + f * (endMs - startMs));
  };

  // What the hover reads out: a recorded value inside the data range, or the projected/required values after it.
  let hover = null;
  if (hoverT !== null && last) {
    if (hoverT <= last.t) {
      const v = valueAt(series, hoverT);
      if (v !== null) hover = { t: hoverT, kind: "actual", value: v };
    } else if (forecast) {
      const f = (hoverT - last.t) / (endMs - last.t);
      hover = {
        t: hoverT,
        kind: "forecast",
        value: forecast.forecast.length ? last.remaining + (forecast.forecast[1].remaining - last.remaining) * f : null,
        required: last.remaining * (1 - f),
      };
    }
  }

  const plotStyle = { position: "relative", height: HEIGHT, marginLeft: Y_AXIS_WIDTH };

  return (
    <div>
      <div style={{ position: "relative", height: HEIGHT + 22 }}>
        {/* y axis labels */}
        <div style={{ position: "absolute", left: 0, top: 0, width: Y_AXIS_WIDTH - 6, height: HEIGHT }}>
          {yTicks(total).map((v) => (
            <div key={v} style={{ position: "absolute", right: 0, top: `${y(v)}%`, transform: "translateY(-50%)", fontSize: 10, color: v === 0 ? green : muted, fontWeight: v === 0 ? 700 : 400 }}>
              {v === 0 ? "0" : formatCompact(v)}
            </div>
          ))}
        </div>

        <div
          ref={wrapRef}
          style={{ ...plotStyle, touchAction: "pan-y", cursor: "crosshair" }}
          onMouseMove={(e) => onMove(e.clientX)}
          onMouseLeave={() => setHoverT(null)}
          onTouchStart={(e) => onMove(e.touches[0].clientX)}
          onTouchMove={(e) => onMove(e.touches[0].clientX)}
          onTouchEnd={() => setHoverT(null)}
        >
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}>
            <defs>
              <linearGradient id="bridgeFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={green} stopOpacity="0.28" />
                <stop offset="100%" stopColor={green} stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {yTicks(total).map((v) => (
              <line key={v} x1="0" x2="100" y1={y(v)} y2={y(v)} stroke={v === 0 ? green : border} strokeOpacity={v === 0 ? 0.9 : 0.5} strokeWidth={v === 0 ? 1.5 : 1} strokeDasharray={v === 0 ? "5 4" : undefined} vectorEffect="non-scaling-stroke" />
            ))}

            {areaPath && <path d={areaPath} fill="url(#bridgeFill)" />}
            {forecast?.requiredLine && <path d={path(forecast.requiredLine)} fill="none" stroke={blue} strokeWidth="1.5" strokeDasharray="2 5" strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity="0.85" />}
            {forecast?.forecast.length > 0 && <path d={path(forecast.forecast)} fill="none" stroke={orange} strokeWidth="2" strokeDasharray="7 5" vectorEffect="non-scaling-stroke" />}
            {linePath && <path d={linePath} fill="none" stroke={green} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}

            {/* today + deadline */}
            {last && <line x1={x(last.t)} x2={x(last.t)} y1={PAD_TOP} y2={100 - PAD_BOTTOM} stroke={mutedLight} strokeOpacity="0.5" strokeDasharray="1 4" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
            <line x1="100" x2="100" y1={PAD_TOP} y2={100 - PAD_BOTTOM} stroke={orange} strokeOpacity="0.7" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />

            {hover && <line x1={x(hover.t)} x2={x(hover.t)} y1={PAD_TOP} y2={100 - PAD_BOTTOM} stroke="#fff" strokeOpacity="0.35" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
          </svg>

          {/* markers (HTML, so they stay round however the chart is stretched) */}
          {last && (
            <div style={{ position: "absolute", left: `${x(last.t)}%`, top: `${y(last.remaining)}%`, width: 9, height: 9, borderRadius: "50%", background: green, boxShadow: `0 0 8px ${green}`, transform: "translate(-50%, -50%)", pointerEvents: "none" }} />
          )}
          {hover?.kind === "actual" && (
            <div style={{ position: "absolute", left: `${x(hover.t)}%`, top: `${y(hover.value)}%`, width: 8, height: 8, borderRadius: "50%", background: "#fff", transform: "translate(-50%, -50%)", pointerEvents: "none" }} />
          )}
          {hover?.kind === "forecast" && hover.value !== null && (
            <div style={{ position: "absolute", left: `${x(hover.t)}%`, top: `${y(hover.value)}%`, width: 8, height: 8, borderRadius: "50%", background: orange, transform: "translate(-50%, -50%)", pointerEvents: "none" }} />
          )}
          {last && (
            <div style={{ position: "absolute", left: `${x(last.t)}%`, top: 2, transform: "translateX(-50%)", fontFamily: monoFont, fontSize: 9, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: mutedLight, pointerEvents: "none", background: "rgba(15,15,15,0.7)", padding: "0 3px" }}>
              Today
            </div>
          )}
          <div style={{ position: "absolute", right: 4, top: 16, fontFamily: monoFont, fontSize: 9, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: orange, pointerEvents: "none" }}>
            Deadline
          </div>

          {hover && (
            <div
              style={{
                position: "absolute",
                top: 34,
                ...(x(hover.t) > 60 ? { right: `${100 - x(hover.t)}%`, marginRight: 10 } : { left: `${x(hover.t)}%`, marginLeft: 10 }),
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
              {hover.kind === "actual" ? (
                <div><span style={{ color: green, fontWeight: 800 }}>{Math.round(hover.value).toLocaleString()}</span> ETN remaining</div>
              ) : (
                <>
                  {hover.value !== null && <div><span style={{ color: orange, fontWeight: 800 }}>{Math.round(hover.value).toLocaleString()}</span> forecast at current pace</div>}
                  <div><span style={{ color: blue, fontWeight: 800 }}>{Math.round(hover.required).toLocaleString()}</span> on the path to 0</div>
                </>
              )}
            </div>
          )}
        </div>

        {/* x axis labels */}
        <div style={{ position: "absolute", left: Y_AXIS_WIDTH, right: 0, top: HEIGHT + 6, height: 14 }}>
          {xTicks.map((t) => (
            <div key={t} style={{ position: "absolute", left: `${x(t)}%`, transform: "translateX(-50%)", fontSize: 10, color: muted, whiteSpace: "nowrap" }}>{monthLabel(t)}</div>
          ))}
          <div style={{ position: "absolute", right: 0, fontSize: 10, color: orange, fontWeight: 700, whiteSpace: "nowrap" }}>31 Jan</div>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 12, fontSize: 11, color: mutedLight }}>
        <LegendItem color={green} label="ETN remaining in the bridge" />
        {forecast?.forecast.length > 0 && <LegendItem color={orange} label="Forecast at current pace" dashed />}
        {forecast && <LegendItem color={blue} label="Path needed to reach 0 by the deadline" dotted />}
      </div>
    </div>
  );
}

function LegendItem({ color, label, dashed, dotted }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 20, height: 0, borderTop: `2px ${dotted ? "dotted" : dashed ? "dashed" : "solid"} ${color}` }} />
      {label}
    </span>
  );
}
