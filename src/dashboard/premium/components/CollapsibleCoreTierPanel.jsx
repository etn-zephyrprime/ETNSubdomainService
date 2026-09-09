import React, { useState } from "react";
import { Plus, Minus } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import { green, mutedLight, border } from "../../theme.js";

/** Shared collapse/expand shell for a Core Tier panel — Balance History, PnL, NFT PnL, and Alerts
 * all use this now, collapsed by default (see PortfolioDashboardSection.jsx's own comment on why:
 * Portfolio and Membership stay always-open, everything else starts tucked away behind a +, since
 * having every section expanded on load made the page feel like a wall of numbers before a member
 * had even decided which one they cared about right now).
 *
 * Wraps the EXACT same DashboardPanel + icon/title header row shape each of those components
 * already had inline — this just factors that out and adds the toggle, rather than introducing a
 * new visual pattern. `headerRight` is whatever optional control used to sit on the right side of
 * that header (a Refresh button, a value-mode toggle) — only rendered while expanded, same as
 * `children` (everything below the header, including each component's own CoreTierGate) — so a
 * collapsed panel costs nothing to render beyond the header itself.
 *
 * Collapse state is LOCAL to each panel, not lifted to the parent — the ask was "closed until
 * opened," not an accordion where opening one closes another, so there's nothing to coordinate
 * across panels. */
export default function CollapsibleCoreTierPanel({ icon: Icon, title, headerRight, defaultCollapsed = true, children }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <DashboardPanel>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: collapsed ? 0 : 16, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          style={{ display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
        >
          <span
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 22, height: 22, borderRadius: 6, border: `1px solid ${border}`, color: mutedLight, flexShrink: 0,
            }}
          >
            {collapsed ? <Plus size={13} /> : <Minus size={13} />}
          </span>
          <Icon size={18} color={green} />
          <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>{title}</span>
        </button>
        {!collapsed && headerRight}
      </div>
      {!collapsed && children}
    </DashboardPanel>
  );
}
