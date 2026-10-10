import React from "react";
import { NavButton } from "./DashboardNav.jsx";

// The dashboard's top-level split: Core Tier/PnL Statements (the wallet-requiring paid features) vs
// the free, walletless Electroneum Dashboard (Overview, Tokens, Address Lookup, etc. — see
// DashboardNav.jsx, now nested one level under this). Reuses NavButton/ACCENTS so the gold "stands
// out as Core Tier" treatment carries all the way up to this top-level tab, not just the nested
// sub-tab — a visitor sees gold the instant they land on this group, before even picking a sub-tab.
const SECTIONS = [
  { id: "coretier", label: "Core Tier & PnL Statements", accent: "gold" },
  { id: "electroneum", label: "Electroneum Dashboard" },
];

export default function MainSectionNav({ active, onChange }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <style>{`
        .main-section-nav{display:grid;grid-template-columns:1fr;gap:8px;}
        @media (min-width:560px){
          .main-section-nav{grid-template-columns:repeat(2,1fr);}
        }
      `}</style>
      <div className="main-section-nav">
        {SECTIONS.map((s) => (
          <NavButton key={s.id} t={s} isActive={s.id === active} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}
