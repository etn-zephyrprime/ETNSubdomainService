import React, { useEffect, useMemo, useState } from "react";
import { Wallet as WalletIcon, LineChart, TrendingUp, Image as ImageIcon, Activity, Bell, FlaskConical, Sprout, Bot, FileSearch, Users, Network } from "lucide-react";
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
import CoreTierGasSpend from "./components/CoreTierGasSpend.jsx";
import CoreTierAlerts from "./components/CoreTierAlerts.jsx";
import CoreTierHeadlineCards from "./components/CoreTierHeadlineCards.jsx";
import CoreTierScenarios from "./components/CoreTierScenarios.jsx";
import CoreTierYieldFarms from "./components/CoreTierYieldFarms.jsx";
import CoreTierEtnBot from "./components/CoreTierEtnBot.jsx";
import CoreTierContracts from "./components/CoreTierContracts.jsx";
import CoreTierBubblemaps from "./components/CoreTierBubblemaps.jsx";
import { ContractCardProvider } from "./components/ContractCard.jsx";
import { ETN_BOT_VIEWERS } from "../hooks/useEtnBot.js";
import AdminSplitPanel from "./components/AdminSplitPanel.jsx";
import AdminAppRegistryPanel from "./components/AdminAppRegistryPanel.jsx";
import AdminMembersPanel, { useMembersAdmin } from "./components/AdminMembersPanel.jsx";
import AdminBubblemapsPanel from "./components/AdminBubblemapsPanel.jsx";
import { green, greenGlow, muted, mutedLight, border, panel2, monoFont, gold, goldGlow } from "../theme.js";

// The panels below used to all render stacked, each collapsed-by-default behind its own +/-
// (CollapsibleCoreTierPanel) — replaced with this button row switching between them one at a time.
// Gold-accented with an icon per panel (see CorePanelButton below) — these are Core Tier's actual
// paid feature set, confirmed live that the earlier plain/gray treatment (matching the free
// Electroneum Dashboard's own tabs) read as flat/unpremium for what's meant to be the paid product.
// Each of the 7 collapsible ones now renders with defaultCollapsed={false} (see their own files)
// since this row is now the single show/hide control — the one-at-a-time display IS the "closed
// until opened" behavior, so a second layer of collapse inside would just be a redundant extra click.
// Gas Spent used to be a panel here too — it's now the gas ticker under the wallet filter, since it's
// one headline figure.
const PORTFOLIO_PANELS = [
  { id: "portfolio", label: "Portfolio", icon: WalletIcon },
  { id: "balance", label: "Balance History", icon: LineChart },
  { id: "pnl", label: "PnL", icon: TrendingUp },
  { id: "nftpnl", label: "NFT PnL", icon: ImageIcon },
  { id: "scenarios", label: "Scenarios", icon: FlaskConical },
  { id: "activity", label: "Recent Activity", icon: Activity },
  { id: "contracts", label: "Contract Check", icon: FileSearch },
  { id: "alerts", label: "Telegram Alerts", icon: Bell },
];
const INFRASTRUCTURE_PANELS = [
  { id: "farms", label: "Yield Farms", icon: Sprout },
  { id: "scenarios", label: "Scenarios", icon: FlaskConical },
  { id: "contracts", label: "Contract Check", icon: FileSearch },
  { id: "bubblemaps", label: "Bubblemaps", icon: Network },
];
// Owner-only: shown just for the ETN_BOT_VIEWERS wallets (the backend enforces it too — see useEtnBot.js).
const BOT_PANEL = { id: "etnbot", label: "ETN Bot", icon: Bot };
// Admins only (backend-enforced too — see utils/adminMembersRouter.js): who's subscribed and when it ends.
const MEMBERS_PANEL = { id: "members", label: "Members", icon: Users };

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

function CorePanelGroupButton({ id, label, description, icon: Icon, color, glow, tint, activeGroup, onChange }) {
  const active = id === activeGroup;
  return (
    <button
      type="button"
      onClick={() => onChange(id)}
      aria-pressed={active}
      className="core-tier-group-tile"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flex: 1,
        minWidth: 0,
        minHeight: 72,
        padding: "12px 14px",
        borderRadius: 10,
        border: `2px solid ${color}`,
        background: active ? `rgba(${tint},0.22)` : `rgba(${tint},0.07)`,
        boxShadow: active
          ? `0 0 18px ${glow}, inset 0 0 14px rgba(${tint},0.12)`
          : `0 0 8px rgba(${tint},0.15)`,
        color: active ? "#fff" : color,
        textAlign: "left",
        transition: "background 0.15s, box-shadow 0.15s, transform 0.15s",
        fontFamily: monoFont,
        cursor: "pointer",
      }}
    >
      <span
        aria-hidden="true"
        className="core-tier-group-icon"
        style={{
          width: 38,
          height: 38,
          flexShrink: 0,
          display: "grid",
          placeItems: "center",
          borderRadius: 8,
          background: `rgba(${tint},0.12)`,
        }}
      >
        <Icon size={22} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 12, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase" }}>
          {label}
        </span>
        <span style={{ display: "block", marginTop: 4, color: active ? "rgba(255,255,255,0.76)" : mutedLight, fontSize: 10, lineHeight: 1.35 }}>
          {description}
        </span>
      </span>
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
  // Which of the panels below is showing — see PANELS' own comment on why this replaced the old
  // stacked/collapsible layout.
  // A ?contract=0x… link (Telegram /check cards and alerts, the Tokens tab badges) opens Contract Check on that
  // card; an optional &name= (the badge's token symbol) titles the card before its facts load. Plain text, capped.
  const linkedContract = useMemo(() => {
    try {
      const c = new URLSearchParams(window.location.search).get("contract");
      return c && /^0x[0-9a-fA-F]{40}$/.test(c) ? c : null;
    } catch {
      return null;
    }
  }, []);
  const linkedName = useMemo(() => {
    try {
      return (new URLSearchParams(window.location.search).get("name") || "").slice(0, 40) || null;
    } catch {
      return null;
    }
  }, []);
  // A ?app=<origin> link (Telegram /checkapp cards and App Check alerts) opens "Check an app" on that site.
  const linkedApp = useMemo(() => {
    try {
      const a = new URLSearchParams(window.location.search).get("app");
      return a && /^https?:\/\/[^\s]{3,250}$/i.test(a) ? a : null;
    } catch {
      return null;
    }
  }, []);
  const [activePanel, setActivePanel] = useState(linkedContract || linkedApp ? "contracts" : "portfolio");
  const [activeGroup, setActiveGroup] = useState("portfolio");
  const isBotViewer = Boolean(wallet.isConnected && wallet.account && ETN_BOT_VIEWERS.has(wallet.account.toLowerCase()));
  const isMembersAdmin = useMembersAdmin(wallet);
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
  const visiblePanels = useMemo(
    () => (activeGroup === "portfolio" ? PORTFOLIO_PANELS : INFRASTRUCTURE_PANELS.filter((p) => p.id !== "bubblemaps" || hasAccess)),
    [activeGroup, hasAccess]
  );

  useEffect(() => {
    if (!visiblePanels.some((panel) => panel.id === activePanel)) {
      setActivePanel(activeGroup === "portfolio" ? "portfolio" : "farms");
    }
  }, [activeGroup, activePanel, visiblePanels]);

  useEffect(() => {
    if (!hasAccess && activePanel === "bubblemaps") {
      setActiveGroup("portfolio");
      setActivePanel("portfolio");
    }
  }, [hasAccess, activePanel]);

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

  // Shared with the headline cards: the Portfolio panel's settled live balances, and the latest PnL
  // snapshot (fetched by the cards, or by the PnL panel when it's open) — so the cards show the same
  // numbers as the panels without computing anything twice.
  const [liveSummary, setLiveSummary] = useState(null);
  const [pnlSnapshot, setPnlSnapshot] = useState(null);

  useEffect(() => {
    setWalletFilter("all");
    setLiveSummary(null);
    setPnlSnapshot(null);
  }, [wallet.isConnected, wallet.account]);

  // Reported by MembershipPurchase itself (see that component's own computeExpiryStatus comment)
  // — null until it's loaded the connected wallet's actual expiry data, then { effectiveTier,
  // daysRemaining, isEndingSoon }. Drives moving the WHOLE panel back to the top of the page (see
  // showMembershipAtTop below) once a member's access is genuinely close to lapsing, so the
  // renewal reminder isn't buried at the bottom of a page they may not scroll all the way down.
  const [expiryStatus, setExpiryStatus] = useState(null);
  const isEndingSoon = Boolean(expiryStatus?.isEndingSoon);

  const membershipPanel = (
    <MembershipPurchase wallet={wallet} onMembershipChange={() => setMembershipVersion((v) => v + 1)} onExpiryStatusChange={setExpiryStatus} />
  );
  // Top placement: a non-member (same as always) OR an active member whose access is about to
  // lapse — the whole point of the user-requested move being THIS condition is that someone who's
  // comfortably renewed for months still gets the normal "it's down at the bottom" treatment;
  // this is specifically for the narrow, time-sensitive window where they need to actually notice it.
  const showMembershipAtTop = !hasAccess || isEndingSoon;

  return (
    // Contract cards can be opened from any panel below (the "Ask" buttons) — see ContractCard.jsx.
    <ContractCardProvider wallet={wallet} getAuthParams={getAuthParams} hasAccess={hasAccess} initialAddress={linkedContract} initialHint={linkedName}>
    <div style={{ width: "100%", maxWidth: 700, margin: "0 auto" }}>
      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <div style={{ fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
          Premium — Core Tier
        </div>
        <h2 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 12px 0", color: "#fff", textShadow: `0 0 16px ${greenGlow}` }}>
          {activeGroup === "portfolio" ? "Portfolio" : "Infrastructure"}
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

      {/* Summary row, right under the wallet filter: total gas spent — follows the same page-wide
          walletFilter as every panel below. */}
      {hasAccess && active.length > 0 && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
          <CoreTierGasSpend wallet={wallet} getAuthParams={getAuthParams} hasAccess={hasAccess} active={active} walletFilter={walletFilter} />
        </div>
      )}

      {/* Someone who isn't (yet) a member — including a visitor with no wallet connected — sees the Premium
          Membership panel FIRST, above the portfolio it unlocks. An active member normally gets it back at
          the bottom instead (see below) — UNLESS their access is about to lapse (showMembershipAtTop), in
          which case the renewal reminder belongs right here too, not buried under everything else. */}
      {showMembershipAtTop && membershipPanel}

      <div style={{ marginBottom: 20 }}>
        <style>{`
          .core-tier-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:10px;}
          .core-tier-group-tile:hover{transform:translateY(-2px);}
          .core-tier-group-tile:focus-visible{outline:2px solid #fff;outline-offset:3px;}
          .core-tier-panel-switcher{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;}
          @media (min-width:720px){
            .core-tier-panel-switcher{grid-template-columns:repeat(3,1fr);}
          }
          @media (max-width:420px){
            .core-tier-groups{gap:7px;}
            .core-tier-group-tile{padding:10px !important;gap:8px !important;}
            .core-tier-group-icon{width:32px !important;height:32px !important;}
            .core-tier-group-icon svg{width:18px;height:18px;}
          }
        `}</style>
        <div className="core-tier-groups">
          <CorePanelGroupButton
            id="portfolio"
            label="Portfolio"
            description="Wallets, balances & PnL"
            icon={WalletIcon}
            color={gold}
            glow={goldGlow}
            tint="232,191,76"
            activeGroup={activeGroup}
            onChange={setActiveGroup}
          />
          <CorePanelGroupButton
            id="infrastructure"
            label="Infrastructure"
            description="Chain-wide tools & analysis"
            icon={Network}
            color={green}
            glow={greenGlow}
            tint="24,187,26"
            activeGroup={activeGroup}
            onChange={setActiveGroup}
          />
        </div>
        <div className="core-tier-panel-switcher">
          {[...visiblePanels, ...(activeGroup === "portfolio" && isBotViewer ? [BOT_PANEL] : []), ...(activeGroup === "portfolio" && isMembersAdmin ? [MEMBERS_PANEL] : [])].map((p) => (
            <CorePanelButton key={p.id} p={p} isActive={p.id === activePanel} onChange={setActivePanel} />
          ))}
        </div>
      </div>

      <CoreTierHeadlineCards
        wallet={wallet}
        getAuthParams={getAuthParams}
        hasAccess={hasAccess}
        active={active}
        walletFilter={walletFilter}
        liveSummary={liveSummary}
        pnlSnapshot={pnlSnapshot}
        onPnlSnapshot={setPnlSnapshot}
        pnlTabOpen={activePanel === "pnl"}
      />

      <div style={{ marginBottom: 20 }}>
        {activePanel === "portfolio" && (
          <CoreTierPortfolio wallet={wallet} getAuthParams={getAuthParams} onSelectToken={onSelectToken} coreTierAccess={coreTierAccess} walletFilter={walletFilter} onViewDemo={onViewDemo} onLiveSummary={setLiveSummary} />
        )}
        {activePanel === "balance" && (
          <CoreTierBalanceHistory wallet={wallet} getAuthParams={getAuthParams} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        )}
        {activePanel === "pnl" && (
          <CoreTierPnl wallet={wallet} getAuthParams={getAuthParams} onSelectToken={onSelectToken} coreTierAccess={coreTierAccess} walletFilter={walletFilter} onSnapshot={setPnlSnapshot} />
        )}
        {activePanel === "nftpnl" && (
          <CoreTierNftPnl wallet={wallet} getAuthParams={getAuthParams} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        )}
        {activePanel === "etnbot" && isBotViewer && <CoreTierEtnBot wallet={wallet} getAuthParams={getAuthParams} />}
        {activePanel === "members" && isMembersAdmin && <AdminMembersPanel wallet={wallet} getAuthParams={getAuthParams} />}
        {activePanel === "farms" && (
          <CoreTierYieldFarms wallet={wallet} getAuthParams={getAuthParams} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        )}
        {activePanel === "scenarios" && (
          <CoreTierScenarios wallet={wallet} getAuthParams={getAuthParams} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        )}
        {activePanel === "activity" && (
          <CoreTierRecentActivity wallet={wallet} getAuthParams={getAuthParams} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        )}
        {activePanel === "contracts" && <CoreTierContracts wallet={wallet} getAuthParams={getAuthParams} coreTierAccess={coreTierAccess} linkedApp={linkedApp} />}
        {activePanel === "alerts" && (
          <CoreTierAlerts wallet={wallet} getAuthParams={getAuthParams} onSelectToken={onSelectToken} coreTierAccess={coreTierAccess} />
        )}
        {activePanel === "bubblemaps" && hasAccess && (
          <CoreTierBubblemaps wallet={wallet} getAuthParams={getAuthParams} />
        )}
      </div>

      {/* Only render it again down here if it ISN'T already showing at the top — hasAccess alone
          would duplicate the panel for a member whose access is ending soon (showMembershipAtTop
          already covers that case above). */}
      {hasAccess && !showMembershipAtTop && membershipPanel}
      <AdminSplitPanel wallet={wallet} getAuthParams={getAuthParams} />
      <AdminAppRegistryPanel wallet={wallet} getAuthParams={getAuthParams} />
      <AdminBubblemapsPanel wallet={wallet} getAuthParams={getAuthParams} />
    </div>
    </ContractCardProvider>
  );
}
