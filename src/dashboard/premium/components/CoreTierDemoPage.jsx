import React from "react";
import { ArrowLeft, Sparkles } from "lucide-react";
import CoreTierDemo from "./CoreTierDemo.jsx";
import { green, greenGlow, muted, mutedLight, border, panel2 } from "../../theme.js";

// Full-page Core Tier demo — reached only via CoreTierPortfolio.jsx's "View Demo" button (its
// onViewDemo prop), never a real nav destination (see DashboardApp.jsx's own TABS list, which
// deliberately doesn't include "demo" — same "reachable by a specific action, not a nav item"
// spirit as the existing /statement/:requestId deep link).
//
// Its own page rather than swapping in place inside CoreTierPortfolio's panel body (the original
// design): while the demo used to show ONLY Portfolio, that was one panel's worth of space to work
// with, so swapping in place was fine. Since the demo now shows every read-only section a real
// member's Portfolio page does (Balance History, PnL, NFT PnL — see CoreTierDemo.jsx's own header
// comment), showing all of that while CoreTierBalanceHistory/CoreTierPnl/CoreTierNftPnl/
// CoreTierAlerts each ALSO render their own "connect a wallet" CoreTierGate below it (they don't
// know a demo is open — that state lives in CoreTierPortfolio alone) made for a confusing page: a
// rich demo followed by four separate "you need to unlock this" prompts for sections the demo had
// just shown. A dedicated page replaces the WHOLE section instead, so none of those gates render
// alongside it.
//
// Imported directly (not lazily) into DashboardApp.jsx, unlike PortfolioDashboardSection.jsx
// itself — CoreTierDemo.jsx (and everything it imports, including CoreTierPnl.jsx's shared
// PnlValueToggle/PnlSubModeToggle) has zero wallet-connection dependency (a public, unauthenticated
// preview), confirmed both by inspecting those imports and by bundling this component's full
// transitive dependency tree and grepping for useReownWallet/WalletConnect (zero references either
// way) — so mounting this doesn't pull the WalletConnect/AppKit bundle into the base dashboard the
// way lazy-loading PortfolioDashboardSection/PremiumDashboardSection exists specifically to avoid.
export default function CoreTierDemoPage({ onExitDemo, onSelectToken }) {
  return (
    <div style={{ width: "100%", maxWidth: 700, margin: "0 auto" }}>
      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
          Premium — Core Tier
        </div>
        <h2 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 12px 0", color: "#fff", textShadow: `0 0 16px ${greenGlow}` }}>
          Demo
        </h2>
        <div style={{ width: 40, height: 2, background: green, margin: "0 auto", borderRadius: 2, boxShadow: `0 0 8px ${greenGlow}` }} />
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: mutedLight, lineHeight: 1.6 }}>
          <Sparkles size={13} color={green} />
          A live preview of what Core Tier actually offers, combined across three real wallets — not your own.
        </div>
        <button
          type="button"
          onClick={onExitDemo}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 14px",
            borderRadius: 20,
            border: `1px solid ${border}`,
            background: panel2,
            color: mutedLight,
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: 0.2,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <ArrowLeft size={13} />
          Exit Demo
        </button>
      </div>

      <CoreTierDemo onSelectToken={onSelectToken} />
    </div>
  );
}
