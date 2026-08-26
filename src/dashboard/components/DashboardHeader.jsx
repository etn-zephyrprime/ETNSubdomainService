import React from "react";
import { PlanetZephyrosLogo, PlanetZephyrosText } from "../../../backend/assets/media.js";

// Deliberately not a reuse of the main site's Header.jsx — that one is wallet-connect UI plus the
// ETN Subdomain Service logo/tagline, none of which belongs here now that the dashboard has its
// own brand: Planet Zephyros logo + wordmark side by side, no wallet section (this screen is
// walletless), no "Simplify your wallet" tagline (that's the other app's line, not this one's).
export default function DashboardHeader({ isMobile }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: isMobile ? 10 : 16,
      marginBottom: 32,
    }}>
      {PlanetZephyrosLogo && (
        <img
          src={PlanetZephyrosLogo}
          alt="Planet Zephyros"
          style={{ height: isMobile ? 48 : 64, width: "auto", objectFit: "contain" }}
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
  );
}
