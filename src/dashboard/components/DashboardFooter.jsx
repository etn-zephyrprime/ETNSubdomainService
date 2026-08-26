import React from "react";
import { PlanetZephyrosLogo } from "../../../backend/assets/media.js";
import { muted } from "../theme.js";

// Deliberately not a reuse of the main site's Footer.jsx — that one's Terms & Conditions section
// is specific to name registration ("All registrations are final...") and would be actively
// misleading here, where nothing is being registered or purchased (v1 is read-only).
export default function DashboardFooter() {
  return (
    <div style={{ marginTop: 40, padding: "20px 12px", textAlign: "center", borderTop: "1px solid #222" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 12, color: muted }}>
        {PlanetZephyrosLogo && <img src={PlanetZephyrosLogo} alt="Planet Zephyros" style={{ height: 20, width: "auto" }} />}
        <span>© {new Date().getFullYear()} Planet Zephyros — data via Electroneum Blockscout</span>
      </div>
    </div>
  );
}
