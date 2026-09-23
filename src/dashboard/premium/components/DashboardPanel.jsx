import React from "react";
import { green, panel2, border } from "../../theme.js";
import CornerBrackets from "../../components/CornerBrackets.jsx";

// Same plain inline-panel convention StatCard.jsx/DashboardNav.jsx already use throughout this
// app — the dashboard has no shared Panel component of its own (unlike the ETN Subdomain Service
// site's Panel.jsx, which belongs to that app's different visual system — see ../../theme.js's
// own header comment on why the two brands stay separate). This is just that same shape factored
// out since the premium section needs it in several places.
//
// `accent` colors the corner brackets — defaults to the dashboard's own green so most callers
// never need to pass it; AdminSplitPanel.jsx is the one caller with its own (orange) accent,
// passed alongside its `style` border override so the two stay in sync.
export default function DashboardPanel({ children, style = {}, accent = green }) {
  return (
    <div
      style={{
        padding: 16,
        borderRadius: 4,
        background: panel2,
        border: `1px solid ${border}`,
        minWidth: 0,
        boxSizing: "border-box",
        position: "relative",
        ...style,
      }}
    >
      <CornerBrackets color={accent} />
      {children}
    </div>
  );
}
