import React from "react";
import { green, greenGlow, muted, mutedLight } from "../theme.js";

const DOT_COUNT = 28;
const TRACK_WIDTH = 280;

// Overview.jsx's "Avg Block Time" tile is a SparklineChart like every other metric here *unless*
// every real hourly reading it has from Blockscout (dashboardStatsCache.js's snapshots, each one a
// live average_block_time read, plus this page's own fresh /stats call) has been identical so far
// — currently true (5.000s every time), but that's checked live on every render
// (Overview.jsx's blockTimeIsConstant), not assumed once and hardcoded. The moment a real reading
// differs, Overview.jsx stops rendering this component at all and falls back to the normal
// SparklineChart of the real snapshot history — so genuine change is never hidden behind a
// permanent "it's constant" claim. This component only ever draws the "no variation yet" case: a
// flat line is a correct chart of a genuinely flat metric, but a boring one, so a traveling dot
// stands in for it instead — a literal metronome, not a static picture of one: it actually crosses
// the track in `blockTimeSeconds` real seconds (5.0s reading -> 5.0s to sweep left to right, then
// snap back and go again), so the animation's own speed IS the data, not just a decoration next to
// it. `animation-duration` is set per-render from the real prop value (inline style), the
// `@keyframes` themselves are static — only the SPEED varies with reality, never the motion itself.
export default function BlockTimeConstant({ blockTimeSeconds }) {
  return (
    <div style={{ height: 140, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18 }}>
      <style>{`
        @keyframes dash-blocktime-sweep {
          0% { left: 0; }
          100% { left: 100%; }
        }
      `}</style>

      <div style={{ fontSize: 40, fontWeight: 900, color: "#fff", textShadow: `0 0 18px ${greenGlow}` }}>
        {blockTimeSeconds.toFixed(1)}s
      </div>

      <div style={{ position: "relative", width: TRACK_WIDTH, height: 14 }}>
        <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "rgba(255,255,255,0.08)", transform: "translateY(-50%)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", height: "100%" }}>
          {Array.from({ length: DOT_COUNT }, (_, i) => (
            <div key={i} style={{ width: 4, height: 4, borderRadius: "50%", background: green, opacity: 0.2, flexShrink: 0 }} />
          ))}
        </div>
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: 0,
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: green,
            boxShadow: `0 0 10px 3px ${greenGlow}`,
            transform: "translate(-50%, -50%)",
            animation: `dash-blocktime-sweep ${blockTimeSeconds}s linear infinite`,
          }}
        />
      </div>

      <div style={{ fontSize: 11, color: mutedLight, textAlign: "center", maxWidth: 320 }}>
        Every real hourly reading from Blockscout so far: exactly {blockTimeSeconds.toFixed(1)}s — the dot sweeps the track at that
        real speed.{" "}
        <span style={{ color: muted }}>Still live-checked each hour — if that ever changes, this switches to a real trend line automatically.</span>
      </div>
    </div>
  );
}
