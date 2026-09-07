import React, { useState } from "react";
import { useReownWallet } from "../../hooks/useReownWallet.jsx";
import { useWalletAuthSignature } from "../../hooks/useWalletAuthSignature.js";
import PremiumWalletChip from "./components/PremiumWalletChip.jsx";
import MembershipPurchase from "./components/MembershipPurchase.jsx";
import CoreTierPortfolio from "./components/CoreTierPortfolio.jsx";
import CoreTierBalanceHistory from "./components/CoreTierBalanceHistory.jsx";
import CoreTierPnl from "./components/CoreTierPnl.jsx";
import CoreTierAlerts from "./components/CoreTierAlerts.jsx";
import { green, greenGlow, muted } from "../theme.js";

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

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <CoreTierPortfolio wallet={wallet} membershipVersion={membershipVersion} getAuthParams={getAuthParams} onSelectToken={onSelectToken} />
        <CoreTierBalanceHistory wallet={wallet} membershipVersion={membershipVersion} getAuthParams={getAuthParams} />
        <CoreTierPnl wallet={wallet} membershipVersion={membershipVersion} getAuthParams={getAuthParams} onSelectToken={onSelectToken} />
        <CoreTierAlerts wallet={wallet} membershipVersion={membershipVersion} getAuthParams={getAuthParams} onSelectToken={onSelectToken} />
        <MembershipPurchase wallet={wallet} onMembershipChange={() => setMembershipVersion((v) => v + 1)} />
      </div>
    </div>
  );
}
