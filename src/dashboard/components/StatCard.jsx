import React from "react";
import { greenGlow, muted, mutedLight, panel2, border } from "../theme.js";

export default function StatCard({ label, value, sub, children }) {
  return (
    <div style={{
      padding: 16,
      borderRadius: 12,
      background: panel2,
      border: `1px solid ${border}`,
      minWidth: 0,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 900, color: "#fff", textShadow: `0 0 10px ${greenGlow}` }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: mutedLight, marginTop: 4 }}>{sub}</div>}
      {children}
    </div>
  );
}
