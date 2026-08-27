import React from "react";
import { PlanetZephyrosLogo, ElectroneumLogo, CoreClashLogo, ElectroSwap, TelegramLogo, XLogo, TransparentSubdomainLogo } from "../../../backend/assets/media.js";
import { muted, mutedLight, border } from "../theme.js";
import { SITE_URL } from "../config.js";
import EcosystemBanner from "../../components/EcosystemBanner.jsx";

const ELECTRONEUM_URL = "https://electroneum.com";
const CORECLASH_URL = "https://coreclash.planetzephyros.xyz";
const ELECTROSWAP_URL = "https://app.electroswap.io/swap?inputCurrency=ETN&outputCurrency=0x309b916b3a90cb3e071697ea9680e9217a30066f";
const TELEGRAM_URL = "https://t.me/PlanetZephyros";
const X_URL = "https://x.com/ETNSubdomain";

function openLink(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}

// Same structure/content as the main site's Footer.jsx (ecosystem banners, socials) — reused
// directly since this dashboard is part of the same Planet Zephyros ecosystem, not a different
// brand pretending those links don't apply here. Two deliberate differences from a straight copy:
//   - An extra "ETN Subdomain Service" card in the banner row (that app doesn't link to itself in
//     its own footer, so this needed adding rather than just copying).
//   - Terms & Conditions reworked from scratch — the main site's version is entirely about name
//     registration ("All registrations are final...", "Renewal reminders are your
//     responsibility...") which is actively misleading here: this dashboard is read-only, no
//     wallet connection, nothing to register or purchase. Covers what's actually true of this
//     app instead: third-party data sources, no financial advice, no warranty on accuracy.
export default function DashboardFooter({ isMobile = false }) {
  return (
    <div
      style={{
        marginTop: 40,
        padding: "20px 12px",
        textAlign: "center",
        borderTop: `1px solid ${border}`,
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
          color: muted,
          letterSpacing: 1,
          textTransform: "uppercase",
          flexWrap: "wrap",
        }}
      >
        {PlanetZephyrosLogo && (
          <img src={PlanetZephyrosLogo} alt="Planet Zephyros" style={{ height: 24, width: "auto", objectFit: "contain" }} />
        )}
        <span>© {new Date().getFullYear()} Planet Zephyros — data via Electroneum Blockscout</span>
      </div>

      <div
        style={{
          width: 60,
          height: 1,
          background: `linear-gradient(to right, transparent, ${border}, transparent)`,
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
        <EcosystemBanner onClick={() => openLink(SITE_URL)} imageSrc={TransparentSubdomainLogo} alt="ETN Subdomain Service" isMobile={isMobile} />
        <EcosystemBanner onClick={() => openLink(ELECTRONEUM_URL)} imageSrc={ElectroneumLogo} alt="Electroneum" isMobile={isMobile} />
        <EcosystemBanner onClick={() => openLink(CORECLASH_URL)} imageSrc={CoreClashLogo} alt="CoreClash" isMobile={isMobile} />
        <EcosystemBanner onClick={() => openLink(ELECTROSWAP_URL)} imageSrc={ElectroSwap} alt="ElectroSwap" isMobile={isMobile} />
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
          <div>• This dashboard is read-only — no wallet connection, no transactions, nothing to buy or register here.</div>
          <div>• Data is sourced from Electroneum Blockscout, CoinGecko, and GeckoTerminal — shown as-is, with no guarantee of accuracy, completeness, or timeliness.</div>
          <div>• Nothing here is financial advice. Prices, charts, and stats are informational only.</div>
          <div>• For registering or managing a .etn name, use ETN Subdomain Service directly.</div>
        </div>
      </div>
    </div>
  );
}
