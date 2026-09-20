import React from "react";
import { green, gold, goldGlow, silver, silverGlow, mutedLight, panel2, border } from "../theme.js";

// `accent` marks a tab that gates on a paid feature, styled to read as such at a glance in both
// its active and inactive states — not just a highlight when selected like every other tab's own
// green accent. gold = Core Tier (the multi-wallet portfolio/PnL membership); silver = PnL
// Statement (the separate per-wallet statement product) — same visual treatment as gold (see
// ACCENTS below), just its own color, so it reads as its own distinct paid feature rather than a
// second Core Tier entry point.
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "tokens", label: "Tokens" },
  { id: "address", label: "Address Lookup" },
  { id: "nameservice", label: "Name Service" },
  { id: "team", label: "Team Wallets" },
  { id: "bridge", label: "ETN Bridge" },
  { id: "hyperlane", label: "Hyperlane Bridge" },
  { id: "portfolio", label: "Premium - Core Tier", accent: "gold" },
  { id: "premium", label: "PnL Statement", accent: "silver" },
];

const ACCENTS = {
  gold: { color: gold, glow: goldGlow, bgActive: "rgba(232,191,76,0.18)", bgInactive: "rgba(232,191,76,0.08)" },
  silver: { color: silver, glow: silverGlow, bgActive: "rgba(192,197,204,0.18)", bgInactive: "rgba(192,197,204,0.08)" },
};

export default function DashboardNav({ active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
      {/* On desktop the two paid tabs (Core Tier, PnL Statement) get their own row beneath the free ones; on
          narrow screens the tabs just wrap as before, so the break is only switched on from 720px up. */}
      <style>{`.dash-nav-break{display:none}@media (min-width:720px){.dash-nav-break{display:block;flex-basis:100%;height:0;margin-top:-8px}}`}</style>
      {TABS.map((t, i) => {
        const isActive = t.id === active;
        const special = t.accent ? ACCENTS[t.accent] : null;
        return (
          <React.Fragment key={t.id}>
          {t.accent && !TABS[i - 1]?.accent && <div className="dash-nav-break" />}
          <button
            onClick={() => onChange(t.id)}
            style={{
              flex: "1 1 120px",
              padding: "10px 8px",
              borderRadius: 10,
              border: `1px solid ${special || isActive ? special?.color ?? green : border}`,
              background: special
                ? isActive ? special.bgActive : special.bgInactive
                : isActive ? "rgba(18,86,131,0.12)" : panel2,
              color: special || isActive ? special?.color ?? green : mutedLight,
              boxShadow: special && isActive ? `0 0 10px ${special.glow}` : undefined,
              fontSize: 13,
              fontWeight: special ? 800 : 700,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
