import React from "react";
import { green, gold, goldGlow, silver, silverGlow, mutedLight, panel2, border, monoFont } from "../theme.js";

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
  { id: "cex", label: "CEX Balances" },
  { id: "bridge", label: "ETN Bridge" },
  { id: "hyperlane", label: "Hyperlane Bridge" },
  { id: "portfolio", label: "Premium - Core Tier", accent: "gold" },
  { id: "premium", label: "PnL Statement", accent: "silver" },
];
const FREE_TABS = TABS.filter((t) => !t.accent);
const PAID_TABS = TABS.filter((t) => t.accent);

const ACCENTS = {
  gold: { color: gold, glow: goldGlow, bgActive: "rgba(232,191,76,0.18)", bgInactive: "rgba(232,191,76,0.08)" },
  silver: { color: silver, glow: silverGlow, bgActive: "rgba(192,197,204,0.18)", bgInactive: "rgba(192,197,204,0.08)" },
};

function NavButton({ t, isActive, onChange }) {
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

// Two fixed grids, not flex-wrap: the free tabs as 4x2 (2x4 on narrow screens) and the two paid
// tabs as their own 2x1 row beneath — a deliberate, exact layout rather than "however many happen
// to fit per row at the current width".
export default function DashboardNav({ active, onChange }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <style>{`
        .dash-nav-free{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:8px;}
        .dash-nav-paid{display:grid;grid-template-columns:repeat(1,1fr);gap:8px;}
        @media (min-width:720px){
          .dash-nav-free{grid-template-columns:repeat(4,1fr);}
          .dash-nav-paid{grid-template-columns:repeat(2,1fr);}
        }
      `}</style>
      <div className="dash-nav-free">
        {FREE_TABS.map((t) => (
          <NavButton key={t.id} t={t} isActive={t.id === active} onChange={onChange} />
        ))}
      </div>
      <div className="dash-nav-paid">
        {PAID_TABS.map((t) => (
          <NavButton key={t.id} t={t} isActive={t.id === active} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}
