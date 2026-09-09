import React from "react";
import { useCurrency, SUPPORTED_CURRENCIES } from "../hooks/useCurrency.js";
import { muted, mutedLight, border, panel2 } from "../theme.js";

// Dashboard-wide display currency — every USD figure across the dashboard (Portfolio, PnL, NFT
// PnL, Address Lookup, Overview, etc.) already flows through formatUsdPrice, so this one small
// control is all that's needed to change what every one of them shows; see useCurrency.js's own
// header comment for how a change here propagates without threading currency through every call
// site. Mounted at the very top of DashboardApp.jsx, above the logo — applies everywhere on this
// dashboard, so it reads as a site-wide setting rather than belonging to any one tab.
export default function CurrencySelector() {
  const { currency, setCurrency } = useCurrency();

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted }}>Currency</span>
      <select
        value={currency}
        onChange={(e) => setCurrency(e.target.value)}
        style={{
          padding: "4px 8px",
          borderRadius: 8,
          border: `1px solid ${border}`,
          background: panel2,
          color: mutedLight,
          fontSize: 11,
          fontWeight: 700,
          outline: "none",
          cursor: "pointer",
        }}
      >
        {SUPPORTED_CURRENCIES.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
    </div>
  );
}
