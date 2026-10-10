import React from "react";
import { green, gold, goldGlow, silver, silverGlow, mutedLight, panel2, border, monoFont } from "../theme.js";

// The free Electroneum Dashboard's own sub-tabs — used ONLY inside the "Electroneum Dashboard" top-
// level section now (see MainSectionNav.jsx). Core Tier and PnL Statement moved out to their own
// top-level section (DashboardApp.jsx) with their own sub-nav, so this file no longer carries any
// paid tab at all — see git history for the pre-split version if that's ever needed again.
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "tokens", label: "Tokens" },
  { id: "address", label: "Address Lookup" },
  { id: "nameservice", label: "Name Service" },
  { id: "team", label: "Team Wallets" },
  { id: "cex", label: "CEX Balances" },
  { id: "bridge", label: "ETN Bridge" },
  { id: "hyperlane", label: "Hyperlane Bridge" },
];

// `accent` marks a tab that gates on a paid feature, styled to read as such at a glance in both
// its active and inactive states — not just a highlight when selected like every other tab's own
// green accent. gold = Core Tier (the multi-wallet portfolio/PnL membership); silver = PnL
// Statement (the separate per-wallet statement product) — same visual treatment as gold (see
// ACCENTS below), just its own color, so it reads as its own distinct paid feature rather than a
// second Core Tier entry point. Exported for completeness — every other place that wants this same
// gold/silver treatment (MainSectionNav.jsx's top-level tabs, DashboardApp.jsx's Core Tier sub-tabs)
// actually gets it by reusing NavButton below, which reads ACCENTS itself, rather than importing
// this map directly.
export const ACCENTS = {
  gold: { color: gold, glow: goldGlow, bgActive: "rgba(232,191,76,0.18)", bgInactive: "rgba(232,191,76,0.08)" },
  silver: { color: silver, glow: silverGlow, bgActive: "rgba(192,197,204,0.18)", bgInactive: "rgba(192,197,204,0.08)" },
};

// Exported so every other button-style tab/sub-tab switcher on the dashboard (MainSectionNav's top-
// level 2 tabs, PortfolioDashboardSection's Core Tier/PnL Statements sub-tabs, and its own 8-button
// panel switcher replacing the old expandable cards) renders pixel-identically to this one, rather
// than each place growing its own slightly-different copy of the same button.
export function NavButton({ t, isActive, onChange }) {
  const special = t.accent ? ACCENTS[t.accent] : null;
  return (
    <button
      onClick={() => onChange(t.id)}
      style={{
        width: "100%",
        minWidth: 0,
        padding: "10px 8px",
        borderRadius: 6,
        border: `1px solid ${special || isActive ? special?.color ?? green : border}`,
        background: special
          ? isActive ? special.bgActive : special.bgInactive
          : isActive ? "rgba(18,86,131,0.12)" : panel2,
        color: special || isActive ? special?.color ?? green : mutedLight,
        boxShadow: special && isActive ? `0 0 10px ${special.glow}` : undefined,
        fontFamily: monoFont,
        fontSize: 11,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        fontWeight: special ? 800 : 700,
        cursor: "pointer",
      }}
    >
      {t.label}
    </button>
  );
}

// 4x2 grid (2x4 on narrow screens) — the free Electroneum Dashboard tabs only now; Core Tier/PnL
// Statement have their own sub-nav inside their own top-level section.
export default function DashboardNav({ active, onChange }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <style>{`
        .dash-nav-free{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;}
        @media (min-width:720px){
          .dash-nav-free{grid-template-columns:repeat(4,1fr);}
        }
      `}</style>
      <div className="dash-nav-free">
        {TABS.map((t) => (
          <NavButton key={t.id} t={t} isActive={t.id === active} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}
