import React from "react";
import { PlanetZephyrosLogo, ElectroneumLogo, ElectroSwap, TelegramLogo, XLogo, TransparentSubdomainLogo } from "../../../backend/assets/media.js";
import { muted, mutedLight, border } from "../theme.js";
import { SITE_URL } from "../config.js";
import EcosystemBanner from "../../components/EcosystemBanner.jsx";

const ELECTRONEUM_URL = "https://electroneum.com";
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
//     responsibility...") which doesn't apply here. Covers what's actually true of this app
//     instead: every tab except the two paid ones is read-only with no wallet connection; third-
//     party data sources; no financial advice; no warranty on accuracy. Updated when the Premium
//     tab (per-wallet PnL statements) shipped, and again once Core Tier existed — the two paid tabs
//     genuinely do connect a wallet (sign-in signature, transactions only on purchase), and Core
//     Tier adds its own terms (time-limited membership, 3 extra tracked wallets with a 30-day
//     lock, Telegram alerts). Keep this in step with what those tabs really do (see
//     backend/db/trackedWallets.js for the wallet limit/cooldown, pnlStatementRouter.js for the
//     refund rule).
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
          <div>• Every tab except the two paid ones (Premium - Core Tier and PnL Statement) is read-only — no wallet connection, no transactions. The paid tabs connect a wallet and ask you to sign a free message to prove you own it (no gas, no access to your funds); a transaction is only sent when you choose to purchase.</div>
          <div>• Core Tier is a paid, time-limited membership (monthly or annual), paid in ETN on-chain. Membership purchases are final and non-refundable. It does not renew automatically — it ends on its expiry date unless you extend it. It covers portfolio tracking for your connected wallet plus up to 3 additional wallets, balance history, PnL, NFT PnL, Diamond Hands, and Telegram alerts. A wallet you track is locked in for 30 days, and one you untrack can't be re-tracked for 30 days.</div>
          <div>• Alerts, digests, and expiry reminders are sent through the Planet Zephyros Notis Telegram bot once you link it, and you can disconnect it at any time. They are best-effort — they can be delayed or missed, so don't rely on them for time-critical decisions.</div>
          <div>• PnL Statements are purchased per wallet and reporting period, and a purchase is refundable only until you first view the statement. Core Tier's live PnL and every PnL figure shown here are estimates using FIFO cost-basis over the data available, and historical prices may be incomplete for some tokens. NFTs are shown at cost and realized gain/loss only, with no current value.</div>
          <div>• Data is sourced from Electroneum Blockscout, ElectroSwap, CoinGecko, GeckoTerminal, KuCoin, and on-chain contracts (including Hyperlane) — shown as-is, with no guarantee of accuracy, completeness, or timeliness. Liquidity lock and burn status is reported by ElectroSwap and isn't independently verified.</div>
          <div>• Nothing here is financial, tax, or legal advice. Prices, charts, scores (including Diamond Hands), PnL, and stats are informational only — consult a qualified professional before relying on them for tax filing or investment decisions.</div>
          <div>• For registering or managing a .etn name, use ETN Subdomain Service directly.</div>
        </div>
      </div>
    </div>
  );
}
