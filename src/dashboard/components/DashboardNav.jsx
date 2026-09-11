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
      {TABS.map((t) => {
        const isActive = t.id === active;
        const special = t.accent ? ACCENTS[t.accent] : null;
        return (
          <button
            key={t.id}
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
        );
      })}
    </div>
  );
}
