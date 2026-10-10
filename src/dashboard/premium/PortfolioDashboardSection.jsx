import React, { useEffect, useState } from "react";
import { Wallet as WalletIcon, LineChart, TrendingUp, Image as ImageIcon, Activity, Gem, Fuel, Bell } from "lucide-react";
import { useReownWallet } from "../../hooks/useReownWallet.jsx";
import { useWalletAuthSignature } from "../../hooks/useWalletAuthSignature.js";
import { useCoreTierAccess } from "../hooks/useCoreTierAccess.js";
import { useDisplayNames } from "../hooks/useDisplayNames.js";
import PremiumWalletChip from "./components/PremiumWalletChip.jsx";
import MembershipPurchase from "./components/MembershipPurchase.jsx";
import CoreTierPortfolio from "./components/CoreTierPortfolio.jsx";
import CoreTierBalanceHistory from "./components/CoreTierBalanceHistory.jsx";
import CoreTierPnl from "./components/CoreTierPnl.jsx";
import CoreTierNftPnl from "./components/CoreTierNftPnl.jsx";
import CoreTierRecentActivity from "./components/CoreTierRecentActivity.jsx";
import CoreTierDiamondHands from "./components/CoreTierDiamondHands.jsx";
import CoreTierGasSpend from "./components/CoreTierGasSpend.jsx";
import CoreTierAlerts from "./components/CoreTierAlerts.jsx";
import AdminSplitPanel from "./components/AdminSplitPanel.jsx";
import { green, greenGlow, muted, mutedLight, border, panel2, monoFont, gold, goldGlow } from "../theme.js";

// The 8 panels below used to all render stacked, each collapsed-by-default behind its own +/-
// (CollapsibleCoreTierPanel) — replaced with this button row switching between them one at a time.
// Gold-accented with an icon per panel (see CorePanelButton below) — these are Core Tier's actual
// paid feature set, confirmed live that the earlier plain/gray treatment (matching the free
// Electroneum Dashboard's own tabs) read as flat/unpremium for what's meant to be the paid product.
// Each of the 7 collapsible ones now renders with defaultCollapsed={false} (see their own files)
// since this row is now the single show/hide control — the one-at-a-time display IS the "closed
// until opened" behavior, so a second layer of collapse inside would just be a redundant extra click.
const PANELS = [
  { id: "portfolio", label: "Portfolio", icon: WalletIcon },
  { id: "balance", label: "Balance History", icon: LineChart },
  { id: "pnl", label: "PnL", icon: TrendingUp },
  { id: "nftpnl", label: "NFT PnL", icon: ImageIcon },
  { id: "activity", label: "Recent Activity", icon: Activity },
  { id: "diamondhands", label: "Diamond Hands Score", icon: Gem },
  { id: "gas", label: "Gas Spent", icon: Fuel },
  { id: "alerts", label: "Telegram Alerts", icon: Bell },
];

// Gold-accented even when inactive (a faint tint, same convention NavButton's own accented tabs
// use) so the whole row reads as a cohesive, premium feature set at a glance — not just whichever
// one happens to be selected. Full gold fill + glow on the active one.
function CorePanelButton({ p, isActive, onChange }) {
  const Icon = p.icon;
  return (
    <button
      onClick={() => onChange(p.id)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        minWidth: 0,
        padding: "10px 12px",
        borderRadius: 8,
        border: `1px solid ${isActive ? gold : "rgba(232,191,76,0.35)"}`,
        background: isActive ? "rgba(232,191,76,0.18)" : "rgba(232,191,76,0.06)",
        color: isActive ? gold : "#d8c488",
        boxShadow: isActive ? `0 0 12px ${goldGlow}` : undefined,
        fontFamily: monoFont,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        cursor: "pointer",
      }}
    >
      <Icon size={14} />
      {p.label}
    </button>
  );
}

// Premium Feature #2 — Core Tier's multi-wallet portfolio tracking. Its own tab/lazy chunk,
// separate from PremiumDashboardSection.jsx (PnL Statements) — see that file's own header comment
// for why the two stay apart rather than being stacked under one "Premium" tab. DashboardApp.jsx
// loads this module lazily (React.lazy, only once the Portfolio tab is actually clicked), same
// reasoning as PremiumDashboardSection.jsx: keeps the WalletConnect/AppKit bundle out of the base
// dashboard for every visitor who never touches either wallet-requiring tab.
export default function PortfolioDashboardSection({ onSelectToken, onViewDemo, onAccessChange }) {
  const wallet = useReownWallet();
  // Which of the 8 panels below is showing — see PANELS' own comment on why this replaced the old
  // stacked/collapsible layout.
  const [activePanel, setActivePanel] = useState("portfolio");
  // One signed-ownership proof for the whole tab, not one per child component — see
  // useCoreTierAccess.js's own comment on why this used to be 3+ independent instances (and,
  // within each of those, several concurrent callers) each prompting their own wallet signature.
  const getAuthParams = useWalletAuthSignature(wallet);

  // Bumped by MembershipPurchase after a successful subscribe — CoreTierPortfolio treats a change
  // here as "re-check my access, a purchase just happened" (see that component's own comment on
  // why this needs a bounded retry, not just one immediate re-check).
  const [membershipVersion, setMembershipVersion] = useState(0);

  // Access + tracked-wallet-list state now lives HERE, once, instead of each of the four Core Tier
  // panels below calling useCoreTierAccess independently (four separate /premium/tracked-wallets
  // fetches for the exact same data) — a prerequisite for the page-wide wallet filter right below,
  // which needs the wallet list before any individual panel has loaded its own data.
  const coreTierAccess = useCoreTierAccess(wallet, membershipVersion, getAuthParams);
  const { active, hasAccess } = coreTierAccess;
  const { resolve: resolveName } = useDisplayNames(active.map((w) => w.address));

  // Reports confirmed membership (wallet connected + signed + backend-confirmed active Core Tier
  // access — exactly what hasAccess===true means, see useCoreTierAccess.js's own comment) up to
  // DashboardApp.jsx, which hides its landing-page demo buttons once this fires true: a paying
  // member doesn't need the demo, they have the real thing. Deliberately NOT read at the top level
  // of DashboardApp.jsx itself — that would mean importing wallet-connection code eagerly there,
  // undoing the whole reason this component is lazy-loaded in the first place. hasAccess also
  // naturally flips back to null/false on disconnect (the hook's own effect), so this correctly
  // re-shows the demo buttons if a member disconnects.
  useEffect(() => {
    onAccessChange?.(hasAccess);
  }, [hasAccess, onAccessChange]);

  // "all" | a wallet address — the one page-wide filter driving Portfolio, PnL, and Balance
  // History together (previously each had its own separate filter; consolidated per feedback that
  // three different controls doing the same job, in three different places, was more confusing
  // than one shared one). Falls back to "all" if it's pointed at a wallet that's since been
  // untracked, so no panel ever renders stale/gone data.
  const [walletFilterRaw, setWalletFilter] = useState("all");
  const walletFilter = walletFilterRaw === "all" || active.some((w) => w.address === walletFilterRaw) ? walletFilterRaw : "all";

  useEffect(() => {
    setWalletFilter("all");
  }, [wallet.isConnected, wallet.account]);

  const membershipPanel = <MembershipPurchase wallet={wallet} onMembershipChange={() => setMembershipVersion((v) => v + 1)} />;

  return (
    <div style={{ width: "100%", maxWidth: 700, margin: "0 auto" }}>
      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <div style={{ fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
          Premium — Core Tier
        </div>
        <h2 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 12px 0", color: "#fff", textShadow: `0 0 16px ${greenGlow}` }}>
          Portfolio
        </h2>
        <div style={{ width: 40, height: 2, background: green, margin: "0 auto", borderRadius: 2, boxShadow: `0 0 8px ${greenGlow}` }} />
      </div>

      <div style={{ marginBottom: 20 }}>
        <PremiumWalletChip wallet={wallet} />
      </div>

      {hasAccess && active.length > 1 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontFamily: monoFont, fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 6 }}>
            Showing
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              onClick={() => setWalletFilter("all")}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: `1px solid ${walletFilter === "all" ? green : border}`,
                background: walletFilter === "all" ? "rgba(24,187,26,0.12)" : panel2,
                color: walletFilter === "all" ? green : mutedLight,
                fontFamily: monoFont,
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              All Wallets
            </button>
            {active.map((w) => (
              <button
                key={w.address}
                onClick={() => setWalletFilter(w.address)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: `1px solid ${walletFilter === w.address ? green : border}`,
                  background: walletFilter === w.address ? "rgba(24,187,26,0.12)" : panel2,
                  color: walletFilter === w.address ? green : mutedLight,
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: monoFont,
                  cursor: "pointer",
                }}
              >
                {w.isOwnWallet ? "You — " : ""}
                {resolveName(w.address)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Someone who isn't (yet) a member — including a visitor with no wallet connected — sees the Premium
          Membership panel FIRST, above the portfolio it unlocks; an active member gets it back at the bottom. */}
      {!hasAccess && membershipPanel}

      <div style={{ marginBottom: 20 }}>
        <style>{`
          .core-tier-panel-switcher{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;}
          @media (min-width:720px){
            .core-tier-panel-switcher{grid-template-columns:repeat(4,1fr);}
          }
        `}</style>
        <div className="core-tier-panel-switcher">
          {PANELS.map((p) => (
            <CorePanelButton key={p.id} p={p} isActive={p.id === activePanel} onChange={setActivePanel} />
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        {activePanel === "portfolio" && (
          <CoreTierPortfolio wallet={wallet} getAuthParams={getAuthParams} onSelectToken={onSelectToken} coreTierAccess={coreTierAccess} walletFilter={walletFilter} onViewDemo={onViewDemo} />
        )}
        {activePanel === "balance" && (
          <CoreTierBalanceHistory wallet={wallet} getAuthParams={getAuthParams} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        )}
        {activePanel === "pnl" && (
          <CoreTierPnl wallet={wallet} getAuthParams={getAuthParams} onSelectToken={onSelectToken} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        )}
        {activePanel === "nftpnl" && (
          <CoreTierNftPnl wallet={wallet} getAuthParams={getAuthParams} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        )}
        {activePanel === "activity" && (
          <CoreTierRecentActivity wallet={wallet} getAuthParams={getAuthParams} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        )}
        {activePanel === "diamondhands" && (
          <CoreTierDiamondHands wallet={wallet} getAuthParams={getAuthParams} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        )}
        {activePanel === "gas" && (
          <CoreTierGasSpend wallet={wallet} getAuthParams={getAuthParams} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        )}
        {activePanel === "alerts" && (
          <CoreTierAlerts wallet={wallet} getAuthParams={getAuthParams} onSelectToken={onSelectToken} coreTierAccess={coreTierAccess} />
        )}
      </div>

      {hasAccess && membershipPanel}
      <AdminSplitPanel wallet={wallet} getAuthParams={getAuthParams} />
    </div>
  );
}
