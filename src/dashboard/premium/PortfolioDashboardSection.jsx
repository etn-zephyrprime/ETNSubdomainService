import React, { useEffect, useState } from "react";
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
import CoreTierAlerts from "./components/CoreTierAlerts.jsx";
import { green, greenGlow, muted, mutedLight, border, panel2 } from "../theme.js";

// Premium Feature #2 — Core Tier's multi-wallet portfolio tracking. Its own tab/lazy chunk,
// separate from PremiumDashboardSection.jsx (PnL Statements) — see that file's own header comment
// for why the two stay apart rather than being stacked under one "Premium" tab. DashboardApp.jsx
// loads this module lazily (React.lazy, only once the Portfolio tab is actually clicked), same
// reasoning as PremiumDashboardSection.jsx: keeps the WalletConnect/AppKit bundle out of the base
// dashboard for every visitor who never touches either wallet-requiring tab.
export default function PortfolioDashboardSection({ onSelectToken }) {
  const wallet = useReownWallet();
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

  return (
    <div style={{ width: "100%", maxWidth: 700, margin: "0 auto" }}>
      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
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
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 6 }}>
            Showing
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              onClick={() => setWalletFilter("all")}
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                border: `1px solid ${walletFilter === "all" ? green : border}`,
                background: walletFilter === "all" ? "rgba(24,187,26,0.12)" : panel2,
                color: walletFilter === "all" ? green : mutedLight,
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
                  borderRadius: 8,
                  border: `1px solid ${walletFilter === w.address ? green : border}`,
                  background: walletFilter === w.address ? "rgba(24,187,26,0.12)" : panel2,
                  color: walletFilter === w.address ? green : mutedLight,
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: "monospace",
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

      {/* Portfolio and Membership always render fully open — everything else (Balance History,
          PnL, NFT PnL, Alerts) starts collapsed behind a + and opens on click, via each of those
          components' own CollapsibleCoreTierPanel wrapper (collapse state lives inside each one,
          nothing to coordinate here) — having every section expanded on load turned this page
          into a wall of numbers before a member had even picked which one they cared about. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <CoreTierPortfolio wallet={wallet} getAuthParams={getAuthParams} onSelectToken={onSelectToken} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        <CoreTierBalanceHistory wallet={wallet} getAuthParams={getAuthParams} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        <CoreTierPnl wallet={wallet} getAuthParams={getAuthParams} onSelectToken={onSelectToken} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        <CoreTierNftPnl wallet={wallet} getAuthParams={getAuthParams} coreTierAccess={coreTierAccess} walletFilter={walletFilter} />
        <CoreTierAlerts wallet={wallet} getAuthParams={getAuthParams} onSelectToken={onSelectToken} coreTierAccess={coreTierAccess} />
        <MembershipPurchase wallet={wallet} onMembershipChange={() => setMembershipVersion((v) => v + 1)} />
      </div>
    </div>
  );
}
