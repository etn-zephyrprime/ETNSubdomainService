import React from "react";
import { green, greenGlow, muted, mutedLight } from "../theme.js";

const DOT_COUNT = 28;

// Overview.jsx's "Avg Block Time" tile is a SparklineChart like every other metric here *unless*
// every real hourly reading it has from Blockscout (dashboardStatsCache.js's snapshots, each one a
// live average_block_time read, plus this page's own fresh /stats call) has been identical so far
// — currently true (5.000s every time), but that's checked live on every render
// (Overview.jsx's blockTimeIsConstant), not assumed once and hardcoded. The moment a real reading
// differs, Overview.jsx stops rendering this component at all and falls back to the normal
// SparklineChart of the real snapshot history — so genuine change is never hidden behind a
// permanent "it's constant" claim. This component only ever draws the "no variation yet" case: a
// flat line is a correct chart of a genuinely flat metric, but a boring one, so the row of
// evenly-spaced dots stands in for it instead — a metronome, not a data series, illustrating
// "every real reading so far, same interval" as a picture.
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
        Every real hourly reading from Blockscout so far: exactly {blockTimeSeconds.toFixed(1)}s.{" "}
        <span style={{ color: muted }}>Still live-checked each hour — if that ever changes, this switches to a real trend line automatically.</span>
      </div>
    </div>
  );
}
