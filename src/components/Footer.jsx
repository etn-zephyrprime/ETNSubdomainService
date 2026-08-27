import React from "react";
import { PlanetZephyrosLogo, ElectroneumLogo, CoreClashLogo, ElectroSwap, TelegramLogo, XLogo } from "../../backend/assets/media.js";
import { muted, mutedLight } from "../styles/theme.js";
import EcosystemBanner from "./EcosystemBanner.jsx";

const ELECTRONEUM_URL = "https://electroneum.com";
const CORECLASH_URL = "https://coreclash.planetzephyros.xyz";
const ELECTROSWAP_URL = "https://app.electroswap.io/swap?inputCurrency=ETN&outputCurrency=0x309b916b3a90cb3e071697ea9680e9217a30066f";
const TELEGRAM_URL = "https://t.me/PlanetZephyros";
const X_URL = "https://x.com/ETNSubdomain";
const DASHBOARD_URL = "https://dashboard.planetzephyros.xyz";

function openLink(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}

// Same visual footprint as EcosystemBanner (background/border/radius/height) but text instead of
// a logo image — the dashboard has no dedicated logo graphic of its own; its actual visual
// identity is this Orbitron-set "Electroneum Dashboard" wordmark (see
// dashboard/DashboardApp.jsx's own heading), so that's what represents it here rather than
// reusing the Planet Zephyros logo already shown elsewhere in this same footer.
function DashboardBanner({ isMobile }) {
  return (
    <div
      onClick={() => openLink(DASHBOARD_URL)}
      style={{ width: isMobile ? "100%" : 320, maxWidth: "100%", cursor: "pointer", boxSizing: "border-box" }}
    >
      <div
        style={{
          background: "#0f0f0f",
          border: "1px solid #333",
          borderRadius: 12,
          width: "100%",
          height: isMobile ? 60 : 78,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 0 8px rgba(0,0,0,0.5)",
          boxSizing: "border-box",
          margin: "0 auto",
        }}
      >
        <span style={{
          fontFamily: "Orbitron, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          fontWeight: 700,
          fontSize: isMobile ? 13 : 15,
          color: "#fff",
          letterSpacing: 0.5,
        }}>
          Electroneum Dashboard
        </span>
        <span style={{ fontSize: 10, color: muted, marginTop: 2 }}>Live network stats & activity</span>
      </div>
    </div>
  );
}

export default function Footer({ isMobile = false }) {
  return (
    <div
      style={{
        marginTop: 40,
        padding: "20px 12px",
        textAlign: "center",
        borderTop: "1px solid #222",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          fontSize: 13,
          color: "#888",
          letterSpacing: 1,
          textTransform: "uppercase",
          textShadow: "0 0 8px rgba(18,86,131,0.4)",
          flexWrap: "wrap",
        }}
      >
        <img
          src={PlanetZephyrosLogo}
          alt="Planet Zephyros"
          style={{
            height: 24,
            width: "auto",
            objectFit: "contain",
            filter: "drop-shadow(0 0 6px rgba(18,86,131,0.5))",
          }}
        />

        <span>
          © {new Date().getFullYear()} Planet Zephyros × @ETN_ZephyrPrime
        </span>
      </div>

      <div
        style={{
          width: 60,
          height: 1,
          background:
            "linear-gradient(to right, transparent, #333, transparent)",
          margin: "4px auto",
        }}
      />

      <div style={{
        display: "flex",
        flexDirection: isMobile ? "column" : "row",
        gap: 12,
        width: isMobile ? "100%" : "auto",
        justifyContent: "center",
        alignItems: "center",
        flexWrap: "wrap",
      }}>
        <EcosystemBanner
          onClick={() => openLink(ELECTRONEUM_URL)}
          imageSrc={ElectroneumLogo}
          alt="Electroneum"
          isMobile={isMobile}
        />
        <EcosystemBanner
          onClick={() => openLink(CORECLASH_URL)}
          imageSrc={CoreClashLogo}
          alt="CoreClash"
          isMobile={isMobile}
        />
        <EcosystemBanner
          onClick={() => openLink(ELECTROSWAP_URL)}
          imageSrc={ElectroSwap}
          alt="ElectroSwap"
          isMobile={isMobile}
        />
        <DashboardBanner isMobile={isMobile} />
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 4 }}>
        <img
          src={TelegramLogo}
          alt="Telegram"
          onClick={() => openLink(TELEGRAM_URL)}
          style={{ height: 26, width: 26, objectFit: "contain", cursor: "pointer", borderRadius: 6 }}
        />
        <img
          src={XLogo}
          alt="X"
          onClick={() => openLink(X_URL)}
          style={{ height: 26, width: 26, objectFit: "contain", cursor: "pointer", borderRadius: 6 }}
        />
      </div>

<div style={{ marginTop: 20, fontSize: 11, color: muted, textAlign: "center", lineHeight: 1.6 }}>
  <div style={{ marginBottom: 8, fontWeight: 600, color: mutedLight }}>
    Terms & Conditions
  </div>
  <div style={{ fontSize: 10, color: muted, maxWidth: 520, margin: "0 auto" }}>
    <div>• All registrations are final. No refunds or cancellations after purchase.</div>
    <div>• Names registered on-chain are immutable and permanent.</div>
    <div>• We are not responsible for lost private keys or wallet access.</div>
    <div>• Renewal reminders are your responsibility. Expired names may be re-registered by others.</div>
  </div>
</div>
    </div>
  );
}