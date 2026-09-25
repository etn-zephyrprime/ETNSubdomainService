import React, { useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { border, green, muted, mutedLight, panel, panel2, VALIDATOR_PALETTE } from "../theme.js";
import { formatChartDate, shortHash } from "../utils/format.js";

const WIDTH = 560;
const HEIGHT = 200;

// Same fixed-identity-then-deterministic-HSL-overflow palette as ValidatorLineChart.jsx's own
// colorForRank — see that file's own comment. Reused here rather than duplicated by value so the
// two charts' color assignment logic can't quietly drift apart.
function colorForRank(rank) {
  if (rank < VALIDATOR_PALETTE.length) return VALIDATOR_PALETTE[rank];
  const hue = (rank * 47) % 360;
  return `hsl(${hue}, 65%, 60%)`;
}

function etnValue(wei) {
  try {
    return parseFloat(ethers.formatEther(wei));
  } catch {
    return 0;
  }
}

function fmtEtn(v) {
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ETN`;
}

// Per-CEX toggleable balance-over-time chart — one line per known CEX/bridge address (see
// cexBalanceHistory.js's own per-address `series`), so a member can isolate or compare individual
// exchanges instead of only ever seeing CexBalancesTab.jsx's own combined total. Built specifically
// to answer "who is reducing their ETN" — every line drawn at once, ranked/colored consistently,
// with a real value readout on hover, makes a falling line for one specific exchange visible even
// while everyone else's balance is flat or rising. Structurally a close sibling of
// ValidatorLineChart.jsx (same hand-rolled SVG + toggle-legend + hover-tooltip shape), adapted for
// real calendar dates and ETN balances instead of a fixed 90-day window of block counts.
export default function CexBalanceLineChart({ addresses }) {
  const svgRef = useRef(null);
  const [hoverIndex, setHoverIndex] = useState(null);
  // All enabled by default — unlike ValidatorLineChart.jsx's top-4 default (a validator SET this
  // chain actually has dozens of), a CEX/bridge list is short enough that showing every line at
  // once is still readable, and "show me everyone, let me turn OFF the ones I don't care about" is
  // the more useful default for spot-checking who's moving.
  const [disabled, setDisabled] = useState(() => new Set());

  const { dates, ranked, seriesByAddr, maxValue } = useMemo(() => {
    const dates = (addresses[0]?.series || []).map((p) => p.date);

    const ranked = addresses
      .map((a) => ({ address: a.address.toLowerCase(), label: a.label, balanceEtn: etnValue(a.balance) }))
      .sort((a, b) => b.balanceEtn - a.balanceEtn)
      .map((a, i) => ({ ...a, color: colorForRank(i) }));

    const seriesByAddr = new Map(
      addresses.map((a) => [
        a.address.toLowerCase(),
        (a.series || []).map((p) => ({ label: p.date, value: etnValue(p.balance) })),
      ])
    );

    const maxValue = Math.max(1, ...ranked.map((r) => Math.max(0, ...(seriesByAddr.get(r.address) || []).map((p) => p.value))));

    return { dates, ranked, seriesByAddr, maxValue };
  }, [addresses]);

  const visible = ranked.filter((r) => !disabled.has(r.address));

  const stepX = dates.length > 1 ? WIDTH / (dates.length - 1) : WIDTH;
  const valueToY = (v) => HEIGHT - (v / maxValue) * HEIGHT;

  const pointsFor = (address) => (seriesByAddr.get(address) || []).map((p, i) => [i * stepX, valueToY(p.value)]);

  const updateHover = (clientX) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || dates.length === 0) return;
    const fraction = (clientX - rect.left) / rect.width;
    const index = Math.max(0, Math.min(dates.length - 1, Math.round(fraction * (dates.length - 1))));
    setHoverIndex(index);
  };

  const toggle = (address) => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  };

  if (dates.length < 2) {
    return (
      <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted }}>
        Not enough history yet for a trend line.
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

          {visible.map(({ address, color }) => (
            <polyline
              key={address}
              points={pointsFor(address).map((c) => c.join(",")).join(" ")}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {hoverX != null && <line x1={hoverX} y1={0} x2={hoverX} y2={HEIGHT} stroke={mutedLight} strokeWidth={1} strokeDasharray="3,3" />}
          {hoverX != null &&
            visible.map(({ address, color }) => {
              const v = seriesByAddr.get(address)?.[hoverIndex]?.value;
              if (typeof v !== "number") return null;
              return <circle key={address} cx={hoverX} cy={valueToY(v)} r={3.5} fill={color} stroke={panel} strokeWidth={1.5} />;
            })}
        </svg>

        {hoverIndex != null && visible.length > 0 && (
          <div
            style={{
              position: "absolute",
              left: `${Math.min(72, (hoverX / WIDTH) * 100)}%`,
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
            {visible.map(({ address, label, color }) => {
              const v = seriesByAddr.get(address)?.[hoverIndex]?.value;
              return (
                <div key={address} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: color }} />
                  <span style={{ color: mutedLight }}>{label}</span>
                  <span style={{ color: "#fff", marginLeft: "auto", fontWeight: 700 }}>{typeof v === "number" ? fmtEtn(v) : "—"}</span>
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

      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 14, paddingTop: 10, borderTop: `1px solid ${border}` }}>
        {ranked.map(({ address, label, balanceEtn, color }) => {
          const isOn = !disabled.has(address);
          return (
            <label
              key={address}
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
              <input type="checkbox" checked={isOn} onChange={() => toggle(address)} style={{ accentColor: green, flexShrink: 0 }} />
              <span style={{ width: 9, height: 9, borderRadius: 2, flexShrink: 0, background: color }} />
              <span style={{ color: "#fff", fontWeight: 700 }}>{label}</span>
              <span style={{ color: muted, fontFamily: "monospace", fontSize: 10 }}>{shortHash(address)}</span>
              <span style={{ color: "#fff", fontWeight: 700, marginLeft: "auto" }}>{fmtEtn(balanceEtn)}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
