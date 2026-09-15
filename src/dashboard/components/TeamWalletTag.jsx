import React from "react";
import { blue, blueGlow } from "../theme.js";

// Small inline "ETN Team" badge — dropped next to a wallet address/name wherever this dashboard
// shows one, so a known Electroneum team wallet (see utils/teamWallets.js) is recognizable at a
// glance instead of just another anonymous address. Blue rather than this dashboard's usual green
// deliberately — reads as an informational label, not an active/selected state or a call to action
// (green is already used for both of those elsewhere).
export default function TeamWalletTag({ style }) {
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        color: blue,
        background: "rgba(62,166,255,0.14)",
        border: `1px solid ${blue}`,
        borderRadius: 5,
        padding: "1px 5px",
        textShadow: `0 0 6px ${blueGlow}`,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      ETN Team
    </span>
  );
}
