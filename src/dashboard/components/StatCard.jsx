import React from "react";
import { green, greenGlow, muted, mutedLight, panel2, border, monoFont } from "../theme.js";
import CornerBrackets from "./CornerBrackets.jsx";

export default function StatCard({ label, value, sub, children }) {
  return (
    <div style={{
      padding: 16,
      borderRadius: 4,
      background: panel2,
      border: `1px solid ${border}`,
      minWidth: 0,
      position: "relative",
    }}>
      <CornerBrackets color={green} />
      <div style={{ fontFamily: monoFont, fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: muted, marginBottom: 8 }}>
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
