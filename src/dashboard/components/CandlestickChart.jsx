import React, { useRef, useState } from "react";
import { green, greenGlow, error as red, muted, mutedLight, panel, border } from "../theme.js";

const identity = (v) => String(v);
const RED_GLOW = "rgba(255,107,107,0.35)";

/**
 * Buckets `volumePoints` (CoinGecko's total_volumes, finer-grained than the OHLC candles — e.g.
 * hourly volume points against 4-hour candles) into one summed figure per candle, matched to
 * each candle's own time window. Returns null if there's no volume data, so callers can render
 * the price chart alone without a volume sub-chart.
 */
export function alignVolumeToCandles(candles, volumePoints) {
  if (!Array.isArray(volumePoints) || volumePoints.length === 0 || candles.length === 0) return null;
  return candles.map((candle, i) => {
    const start = candle.timeMs;
    const end = i < candles.length - 1 ? candles[i + 1].timeMs : Infinity;
    const sum = volumePoints.reduce((acc, [ms, v]) => (ms >= start && ms < end ? acc + v : acc), 0);
    return { label: candle.label, value: sum };
  });
}

// Real green/red OHLC candlesticks + an optional volume sub-chart underneath, same hover-tooltip
// and HTML-axis-label approach as SparklineChart.jsx (see that file's header comment for why axis
// text is plain HTML rather than SVG <text> — same non-uniform-scaling distortion problem would
// apply here too). `candles` is `{ label, timeMs, open, high, low, close }[]`, oldest first.
export default function CandlestickChart({ candles, volume, height = 140, width = 280, formatValue = identity, formatLabel = identity }) {
  const svgRef = useRef(null);
  const [hoverIndex, setHoverIndex] = useState(null);

  if (!candles || candles.length < 2) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#666" }}>
        Not enough data
      </div>
    );
  }

  const hasVolume = Array.isArray(volume) && volume.length === candles.length;
  const volumeHeight = hasVolume ? Math.round(height * 0.22) : 0;
  const volumeGap = hasVolume ? 8 : 0;
  const priceHeight = height - volumeHeight - volumeGap;

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const priceMin = Math.min(...lows);
  const priceMax = Math.max(...highs);
  const priceMid = (priceMin + priceMax) / 2;
  const priceRange = priceMax - priceMin || 1;
  const priceToY = (v) => priceHeight - ((v - priceMin) / priceRange) * priceHeight;

  const maxVolume = hasVolume ? Math.max(...volume.map((v) => v.value)) : 0;
  const volumeToBarHeight = (v) => (maxVolume ? (v / maxVolume) * volumeHeight : 0);

  const stepX = width / candles.length;
  const candleWidth = Math.max(1, stepX * 0.6);
  const candleX = (i) => i * stepX + stepX / 2;

  const updateHover = (clientX) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fraction = (clientX - rect.left) / rect.width;
    const index = Math.round(fraction * candles.length - 0.5);
    setHoverIndex(Math.max(0, Math.min(candles.length - 1, index)));
  };

  const hoverCandle = hoverIndex != null ? candles[hoverIndex] : null;
  const hoverVolume = hoverIndex != null && hasVolume ? volume[hoverIndex] : null;
  const hoverX = hoverIndex != null ? candleX(hoverIndex) : null;
  const tooltipAlign = hoverX != null && hoverX > width / 2 ? "right" : "left";

  return (
    <div style={{ display: "flex", gap: 8 }}>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: priceHeight, flexShrink: 0 }}>
        {[priceMax, priceMid, priceMin].map((v, i) => (
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
            {[priceMax, priceMid, priceMin].map((v, i) => (
              <line key={i} x1={0} y1={priceToY(v)} x2={width} y2={priceToY(v)} stroke={border} strokeWidth={0.5} strokeDasharray="2,2" />
            ))}

            {candles.map((c, i) => {
              const isUp = c.close >= c.open;
              const color = isUp ? green : red;
              const bodyTop = priceToY(Math.max(c.open, c.close));
              const bodyBottom = priceToY(Math.min(c.open, c.close));
              const x = candleX(i);
              return (
                <g key={i}>
                  <line x1={x} x2={x} y1={priceToY(c.high)} y2={priceToY(c.low)} stroke={color} strokeWidth={1} />
                  <rect x={x - candleWidth / 2} y={bodyTop} width={candleWidth} height={Math.max(1, bodyBottom - bodyTop)} fill={color} />
                </g>
              );
            })}

            {hasVolume && volume.map((v, i) => {
              const barH = volumeToBarHeight(v.value);
              const isUp = candles[i].close >= candles[i].open;
              const x = candleX(i);
              return (
                <rect
                  key={i}
                  x={x - candleWidth / 2}
                  y={height - barH}
                  width={candleWidth}
                  height={barH}
                  fill={isUp ? greenGlow : RED_GLOW}
                />
              );
            })}

            {hoverX != null && (
              <line x1={hoverX} y1={0} x2={hoverX} y2={height} stroke={mutedLight} strokeWidth={1} strokeDasharray="3,3" />
            )}
          </svg>

          {hoverCandle && (
            <div
              style={{
                position: "absolute",
                left: `${(hoverX / width) * 100}%`,
                top: 0,
                transform: `translate(${tooltipAlign === "right" ? "-100%" : "0%"}, -100%)`,
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
              <div style={{ color: mutedLight, marginBottom: 2 }}>{formatLabel(hoverCandle.label, true)}</div>
              <div style={{ color: "#fff" }}>O <strong>{formatValue(hoverCandle.open)}</strong> H <strong>{formatValue(hoverCandle.high)}</strong></div>
              <div style={{ color: "#fff" }}>L <strong>{formatValue(hoverCandle.low)}</strong> C <strong style={{ color: hoverCandle.close >= hoverCandle.open ? green : red }}>{formatValue(hoverCandle.close)}</strong></div>
              {hoverVolume && (
                <div style={{ color: mutedLight, marginTop: 2 }}>Vol <span style={{ color: "#fff" }}>${Math.round(hoverVolume.value).toLocaleString()}</span></div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
          <span style={{ fontSize: 10, color: muted }}>{formatLabel(candles[0].label)}</span>
          <span style={{ fontSize: 10, color: muted }}>{formatLabel(candles[Math.round((candles.length - 1) / 2)].label)}</span>
          <span style={{ fontSize: 10, color: muted }}>{formatLabel(candles[candles.length - 1].label)}</span>
        </div>
      </div>
    </div>
  );
}
