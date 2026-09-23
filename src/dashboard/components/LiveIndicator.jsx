import React from "react";
import { green, monoFont } from "../theme.js";

// Pulsing "LIVE" status pill — the Neon Grid header's HUD-style indicator that this is a live feed,
// not a static page (this dashboard has no login/session state to reflect instead). Local <style>
// for the pulse keyframe, same colocated-styles convention DashboardNav.jsx already uses for its
// own responsive breakpoint — no need for a global CSS change for one small animation.
export default function LiveIndicator() {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        border: "1px solid rgba(24,187,26,0.35)",
        borderRadius: 4,
        padding: "6px 12px",
        background: "rgba(24,187,26,0.06)",
        flexShrink: 0,
      }}
    >
      <style>{`@keyframes dashLivePulse{0%,100%{opacity:1;}50%{opacity:.4;}}`}</style>
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: green,
          boxShadow: `0 0 8px ${green}`,
          animation: "dashLivePulse 2.2s ease-in-out infinite",
        }}
      />
      <span style={{ fontFamily: monoFont, fontSize: 10, letterSpacing: 2, color: green, textTransform: "uppercase" }}>
        Live
      </span>
    </div>
  );
}
