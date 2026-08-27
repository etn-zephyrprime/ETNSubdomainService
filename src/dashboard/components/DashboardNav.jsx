import React from "react";
import { green, mutedLight, panel2, border } from "../theme.js";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "tokens", label: "Tokens" },
  { id: "address", label: "Address Lookup" },
  { id: "nameservice", label: "Name Service" },
];

export default function DashboardNav({ active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
      {TABS.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          style={{
            flex: "1 1 120px",
            padding: "10px 8px",
            borderRadius: 10,
            border: `1px solid ${t.id === active ? green : border}`,
            background: t.id === active ? "rgba(18,86,131,0.12)" : panel2,
            color: t.id === active ? green : mutedLight,
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
