import React from "react";
import { orange, orangeGlow } from "../theme.js";

// Small inline "CEX" badge — same treatment as TeamWalletTag.jsx (orange rather than that
// component's blue, so the two read as distinct categories at a glance), dropped next to a wallet
// address wherever this dashboard shows one and it matches a known entry in
// hooks/useCexAddresses.js. `label` (the free-text label from cex_addresses — see
// backend/db/cexAddresses.js) is shown as a hover title rather than inline text, since it can be
// long/unconfirmed (e.g. "Unknown CEX (unconfirmed - high-frequency payout pattern)") and the tag
// itself needs to stay compact.
export default function CexTag({ label, style }) {
  return (
    <span
      title={label || undefined}
      style={{
        display: "inline-block",
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        color: orange,
        background: "rgba(255,138,61,0.14)",
        border: `1px solid ${orange}`,
        borderRadius: 5,
        padding: "1px 5px",
        textShadow: `0 0 6px ${orangeGlow}`,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      CEX
    </span>
  );
}
