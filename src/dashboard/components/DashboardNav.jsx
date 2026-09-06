import React from "react";
import { green, gold, goldGlow, mutedLight, panel2, border } from "../theme.js";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "tokens", label: "Tokens" },
  { id: "address", label: "Address Lookup" },
  { id: "nameservice", label: "Name Service" },
  // Deliberately gold, not the green every other tab uses when active — this is the one tab that
  // gates on a paid membership (see PortfolioDashboardSection.jsx), so it's styled to read as
  // premium at a glance, in both its active and inactive states, not just when selected like every
  // other tab's own accent color.
  { id: "portfolio", label: "Premium", premium: true },
  { id: "premium", label: "PnL Statement" },
];

export default function DashboardNav({ active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
      {TABS.map((t) => {
        const isActive = t.id === active;
        const accent = t.premium ? gold : green;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              flex: "1 1 120px",
              padding: "10px 8px",
              borderRadius: 10,
              border: `1px solid ${t.premium || isActive ? accent : border}`,
              background: t.premium
                ? isActive ? "rgba(232,191,76,0.18)" : "rgba(232,191,76,0.08)"
                : isActive ? "rgba(18,86,131,0.12)" : panel2,
              color: t.premium || isActive ? accent : mutedLight,
              boxShadow: t.premium && isActive ? `0 0 10px ${goldGlow}` : undefined,
              fontSize: 13,
              fontWeight: t.premium ? 800 : 700,
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
