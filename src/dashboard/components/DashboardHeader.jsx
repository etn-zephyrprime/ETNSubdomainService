import React from "react";
import { PlanetZephyrosLogo, PlanetZephyrosText } from "../../../backend/assets/media.js";
import { greenGlow } from "../theme.js";
import LiveIndicator from "./LiveIndicator.jsx";

// Deliberately not a reuse of the main site's Header.jsx — that one is wallet-connect UI plus the
// ETN Subdomain Service logo/tagline, none of which belongs here now that the dashboard has its
// own brand: Planet Zephyros logo + wordmark side by side, no wallet section (this screen is
// walletless), no "Simplify your wallet" tagline (that's the other app's line, not this one's).
//
// LiveIndicator sits opposite the logo on desktop (space-between); mobile stacks it below instead
// of squeezing both onto one cramped row.
export default function DashboardHeader({ isMobile }) {
  return (
    <div style={{
      display: "flex",
      flexDirection: isMobile ? "column" : "row",
      alignItems: "center",
      justifyContent: isMobile ? "center" : "space-between",
      gap: isMobile ? 14 : 16,
      marginBottom: 32,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 10 : 16 }}>
        {PlanetZephyrosLogo && (
          <img
            src={PlanetZephyrosLogo}
            alt="Planet Zephyros"
            style={{ height: isMobile ? 48 : 64, width: "auto", objectFit: "contain", filter: `drop-shadow(0 0 10px ${greenGlow})` }}
          />
        )}
        {PlanetZephyrosText && (
          <img
            src={PlanetZephyrosText}
            alt="Planet Zephyros"
            style={{ height: isMobile ? 28 : 38, width: "auto", objectFit: "contain" }}
          />
        )}
      </div>
      <LiveIndicator />
    </div>
  );
}
