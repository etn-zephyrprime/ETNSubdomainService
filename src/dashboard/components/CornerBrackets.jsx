import React from "react";

// Four small L-shaped corner accents — the Neon Grid HUD motif StatCard.jsx and DashboardPanel.jsx
// (premium) both carry on every card/panel. Absolutely positioned, so the parent needs
// `position: relative`; purely decorative (aria-hidden), never affects layout or content.
export default function CornerBrackets({ color, size = 12 }) {
  const arm = { position: "absolute", width: size, height: size, pointerEvents: "none" };
  return (
    <div aria-hidden="true">
      <div style={{ ...arm, top: -1, left: -1, borderTop: `2px solid ${color}`, borderLeft: `2px solid ${color}` }} />
      <div style={{ ...arm, bottom: -1, right: -1, borderBottom: `2px solid ${color}`, borderRight: `2px solid ${color}` }} />
    </div>
  );
}
