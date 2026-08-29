import React, { useEffect, useMemo, useRef, useState } from "react";
import { border, green, muted, mutedLight, panel, panel2, VALIDATOR_PALETTE } from "../theme.js";
import { formatInt, formatEtnBalance, formatChartDate, shortHash } from "../utils/format.js";

const WIDTH = 560;
const HEIGHT = 200;
const DAYS_BACK = 90;
const DEFAULT_ENABLED_COUNT = 4; // top 4 validators by blocks produced, shown by default

// Same fixed palette as CalendarHeatmap.jsx (see theme.js) for the first 9 validators by rank;
// this chain's active validator set has run past that in practice (round-robin among a couple
// dozen), so ranks beyond the fixed palette get a deterministic HSL color instead of repeating —
// distinct enough to tell lines apart even when several unpaletted validators are toggled on
// together, without needing to hand-pick an arbitrarily long fixed list.
function colorForRank(rank) {
  if (rank < VALIDATOR_PALETTE.length) return VALIDATOR_PALETTE[rank];
  const hue = (rank * 47) % 360;
  return `hsl(${hue}, 65%, 60%)`;
}

// Line chart of blocks-produced-per-day, one line per validator, over the trailing 90 real days
// backend/utils/validatorRewardsCache.js has published — powers Overview.jsx's "Validators" tile.
// Every validator gets its own toggleable line (not merged into an "other" bucket the way
// CalendarHeatmap.jsx's legend does — the point here is per-validator filtering, not a bounded
// legend), defaulting to only the top 4 by total blocks in the window so the chart isn't an
// unreadable tangle of 20+ lines on first load.
//
// A day missing from `days` entirely (backfill hasn't reached it yet) renders as a real gap in
// every line (unknown, not zero); a day that's present but where a given validator simply didn't
// produce a block renders as a real 0 — those are different facts and this chart draws them
// differently, same "don't draw a gap as if it were a real zero" discipline as SparklineChart.js.
//
// `onSelectAddress` is optional (same pattern as AddressLookup.jsx's own `onSelectToken`) — when
// provided, each row's address becomes a link into the dashboard's Address Lookup tab for that
// validator's real ETN balance/activity (DashboardApp.jsx wires this the same way it already
// does for TokenDetail's "view holder" links). Omitted entirely, the address is plain text and
// the row's only behavior is the existing checkbox toggle.
export default function ValidatorLineChart({ days, onSelectAddress }) {
  const svgRef = useRef(null);
  const [hoverIndex, setHoverIndex] = useState(null);
  const [enabled, setEnabled] = useState(null); // null until the default top-4 selection is applied once
  const defaultAppliedRef = useRef(false);

  const { dates, ranked, seriesByAddr, maxValue } = useMemo(() => {
    const today = new Date();
    const dates = [];
    for (let i = DAYS_BACK - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    const totals = new Map(); // addr -> { blocks, rewardWei }
    for (const date of dates) {
      const entry = days?.[date];
      if (!entry) continue;
      for (const [addr, v] of Object.entries(entry.validators || {})) {
        const t = totals.get(addr) || { blocks: 0, rewardWei: 0n };
        t.blocks += v.blocks;
        t.rewardWei += BigInt(v.rewardWei);
        totals.set(addr, t);
      }
    }

    const ranked = [...totals.entries()]
      .sort((a, b) => b[1].blocks - a[1].blocks)
      .map(([addr, t], i) => ({ addr, blocks: t.blocks, rewardWei: t.rewardWei.toString(), color: colorForRank(i) }));

    const seriesByAddr = new Map(
      ranked.map(({ addr }) => [
        addr,
        dates.map((date) => {
          const entry = days?.[date];
          if (!entry) return { label: date, value: null }; // day not backfilled yet — unknown
          return { label: date, value: entry.validators?.[addr]?.blocks ?? 0 }; // present day, real 0 if this validator didn't produce
        }),
      ])
    );

    const maxValue = Math.max(1, ...ranked.map(({ addr }) => Math.max(0, ...seriesByAddr.get(addr).map((p) => p.value || 0))));

    return { dates, ranked, seriesByAddr, maxValue };
  }, [days]);

  // Apply the default top-4 selection exactly once, the first time real ranking data exists —
  // guarded by a ref (not just `enabled === null`) so a viewer's own toggles never get stomped
  // back to the default on a later refetch, including one that happens to briefly re-empty `days`.
  useEffect(() => {
    if (!defaultAppliedRef.current && ranked.length > 0) {
      defaultAppliedRef.current = true;
      setEnabled(new Set(ranked.slice(0, DEFAULT_ENABLED_COUNT).map((r) => r.addr)));
    }
  }, [ranked]);

  const visible = ranked.filter((r) => enabled?.has(r.addr));

  const stepX = WIDTH / (dates.length - 1);
  const valueToY = (v) => HEIGHT - (v / maxValue) * HEIGHT;

  const segmentsFor = (addr) => {
    const series = seriesByAddr.get(addr);
    const segments = [];
    let current = [];
    series.forEach((p, i) => {
      if (typeof p.value === "number") {
        current.push([i * stepX, valueToY(p.value)]);
      } else if (current.length) {
        segments.push(current);
        current = [];
      }
    });
    if (current.length) segments.push(current);
    return segments;
  };

  const updateHover = (clientX) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fraction = (clientX - rect.left) / rect.width;
    const index = Math.max(0, Math.min(dates.length - 1, Math.round(fraction * (dates.length - 1))));
    setHoverIndex(index);
  };

  const toggle = (addr) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });
  };

  if (!days || Object.keys(days).length === 0) {
    return (
      <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted }}>
        Collecting real validator data — check back shortly.
      </div>
    );
  }

  const hoverX = hoverIndex != null ? hoverIndex * stepX : null;

  return (
    <div>
      <div style={{ position: "relative" }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width="100%"
          height={HEIGHT}
          preserveAspectRatio="none"
          onMouseMove={(e) => updateHover(e.clientX)}
          onMouseLeave={() => setHoverIndex(null)}
          style={{ cursor: "crosshair", display: "block" }}
        >
          {[0, 0.5, 1].map((t) => (
            <line key={t} x1={0} y1={HEIGHT * t} x2={WIDTH} y2={HEIGHT * t} stroke={border} strokeWidth={0.5} strokeDasharray="2,2" />
          ))}

          {visible.map(({ addr, color }) =>
            segmentsFor(addr).map((segment, i) => (
              <polyline
                key={`${addr}-${i}`}
                points={segment.map((c) => c.join(",")).join(" ")}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))
          )}

          {hoverX != null && <line x1={hoverX} y1={0} x2={hoverX} y2={HEIGHT} stroke={mutedLight} strokeWidth={1} strokeDasharray="3,3" />}
          {hoverX != null &&
            visible.map(({ addr, color }) => {
              const v = seriesByAddr.get(addr)[hoverIndex]?.value;
              if (typeof v !== "number") return null;
              return <circle key={addr} cx={hoverX} cy={valueToY(v)} r={3.5} fill={color} stroke={panel} strokeWidth={1.5} />;
            })}
        </svg>

        {hoverIndex != null && visible.length > 0 && (
          <div
            style={{
              position: "absolute",
              left: `${Math.min(78, (hoverX / WIDTH) * 100)}%`,
              top: 4,
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
            <div style={{ color: mutedLight, marginBottom: 3 }}>{formatChartDate(dates[hoverIndex], true)}</div>
            {visible.map(({ addr, color }) => {
              const v = seriesByAddr.get(addr)[hoverIndex]?.value;
              return (
                <div key={addr} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: color }} />
                  <span style={{ color: mutedLight, fontFamily: "monospace" }}>{shortHash(addr)}</span>
                  <span style={{ color: "#fff", marginLeft: "auto", fontWeight: 700 }}>{typeof v === "number" ? `${v} blk` : "—"}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span style={{ fontSize: 10, color: muted }}>{formatChartDate(dates[0])}</span>
        <span style={{ fontSize: 10, color: muted }}>{formatChartDate(dates[Math.round((dates.length - 1) / 2)])}</span>
        <span style={{ fontSize: 10, color: muted }}>{formatChartDate(dates[dates.length - 1])}</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 14, paddingTop: 10, borderTop: `1px solid ${border}`, maxHeight: 220, overflowY: "auto" }}>
        {ranked.map(({ addr, blocks, rewardWei, color }) => {
          const isOn = enabled?.has(addr);
          return (
            <label
              key={addr}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11,
                padding: "4px 6px",
                borderRadius: 6,
                background: isOn ? panel2 : "transparent",
                cursor: "pointer",
                opacity: isOn ? 1 : 0.6,
              }}
            >
              <input type="checkbox" checked={!!isOn} onChange={() => toggle(addr)} style={{ accentColor: green, flexShrink: 0 }} />
              <span style={{ width: 9, height: 9, borderRadius: 2, flexShrink: 0, background: color }} />
              {onSelectAddress ? (
                <button
                  onClick={(e) => {
                    // preventDefault (not just stopPropagation) is what actually stops a click
                    // inside a <label> from also toggling its associated checkbox — a label's
                    // click-forwarding to its control is itself a default action, suppressed the
                    // same way a nested link's default navigation would be.
                    e.preventDefault();
                    e.stopPropagation();
                    onSelectAddress(addr);
                  }}
                  title="View this validator's balance and activity in Address Lookup"
                  style={{
                    color: mutedLight,
                    fontFamily: "monospace",
                    fontSize: 11,
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    textDecoration: "underline",
                    textDecorationColor: border,
                    textUnderlineOffset: 2,
                  }}
                >
                  {shortHash(addr)}
                </button>
              ) : (
                <span style={{ color: mutedLight, fontFamily: "monospace" }}>{shortHash(addr)}</span>
              )}
              <span style={{ color: muted, marginLeft: "auto" }}>{formatInt(blocks)} blocks</span>
              <span style={{ color: "#fff", fontWeight: 700, minWidth: 90, textAlign: "right" }}>{formatEtnBalance(rewardWei)} ETN</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
