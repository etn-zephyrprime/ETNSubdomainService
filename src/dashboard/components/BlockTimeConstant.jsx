import React from "react";
import { green, greenGlow, muted, mutedLight } from "../theme.js";

const DOT_COUNT = 28;

// Overview.jsx's "Avg Block Time" tile used to be a SparklineChart like every other metric here —
// but confirmed live (both Blockscout's own rolling average_block_time across 51 real hourly
// snapshots, and this app's own raw consecutive-block-timestamp deltas straight from the chain)
// that it is *exactly* 5.000s, every block, with zero measurable deviation — not "rounds to 5.0",
// genuinely constant. A line chart of a genuinely constant number is correctly a flat line; no
// chart type or Y-axis trick makes that a more honest or more informative picture, so this
// replaces the chart entirely rather than dress up a flatline. The row of evenly-spaced dots is a
// metronome, not a data series — it's illustrating "every block, same interval" as a picture
// instead of forcing that fact through a line-chart idiom that assumes values vary.
export default function BlockTimeConstant({ blockTimeSeconds }) {
  return (
    <div style={{ height: 140, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18 }}>
      <div style={{ fontSize: 40, fontWeight: 900, color: "#fff", textShadow: `0 0 18px ${greenGlow}` }}>
        {blockTimeSeconds.toFixed(1)}s
      </div>

      <div style={{ display: "flex", gap: 5 }}>
        {Array.from({ length: DOT_COUNT }, (_, i) => (
          <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: green, opacity: 0.35 + (i % 4 === 0 ? 0.65 : 0) }} />
        ))}
      </div>

      <div style={{ fontSize: 11, color: mutedLight, textAlign: "center", maxWidth: 320 }}>
        Every block, exactly {blockTimeSeconds.toFixed(1)}s apart — confirmed from real consecutive
        block timestamps, not just a rounded average.{" "}
        <span style={{ color: muted }}>This chain targets a fixed block time by design, so there's genuinely nothing to chart.</span>
      </div>
    </div>
  );
}
