import React from "react";
import { panel2, border } from "../../theme.js";

// Same plain inline-panel convention StatCard.jsx/DashboardNav.jsx already use throughout this
// app — the dashboard has no shared Panel component of its own (unlike the ETN Subdomain Service
// site's Panel.jsx, which belongs to that app's different visual system — see ../../theme.js's
// own header comment on why the two brands stay separate). This is just that same shape factored
// out since the premium section needs it in several places.
export default function DashboardPanel({ children, style = {} }) {
  return (
    <div
      style={{
        padding: 16,
        borderRadius: 12,
        background: panel2,
        border: `1px solid ${border}`,
        minWidth: 0,
        boxSizing: "border-box",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
