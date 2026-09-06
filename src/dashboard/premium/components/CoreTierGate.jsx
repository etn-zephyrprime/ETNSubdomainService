import React from "react";
import { Lock } from "lucide-react";
import DashboardButton from "./DashboardButton.jsx";
import { green, muted, mutedLight, border } from "../../theme.js";

// Shared "is this visitor even allowed to see what's below" chrome for every Core Tier feature —
// factored out of CoreTierPortfolio.jsx once CoreTierBalanceHistory.jsx needed the exact same
// four states (not connected / checking / awaiting a just-purchased subscription to activate /
// membership required) without copy-pasting this whole state-driven block a second time. Renders
// `children` once hasAccess is actually true; every other case renders its own gate UI instead.
// `featureDescription` is the one piece of copy that's genuinely feature-specific — what "connect"
// and "subscribe" actually unlock differs per feature, everything else about the gate is identical.
export default function CoreTierGate({
  wallet,
  hasAccess,
  accessError,
  awaitingActivation,
  manualCheckLoading,
  checkAccessOnce,
  featureDescription,
  children,
}) {
  if (!wallet.isConnected) {
    return (
      <div>
        <div style={{ fontSize: 12, color: mutedLight, marginBottom: 12 }}>
          Connect your wallet to {featureDescription}.
        </div>
        <DashboardButton onClick={wallet.connectWallet} style={{ width: "100%", justifyContent: "center" }}>
          Connect Wallet
        </DashboardButton>
      </div>
    );
  }

  if (hasAccess === null) {
    return <div style={{ fontSize: 12, color: mutedLight }}>Checking Core tier access…</div>;
  }

  if (accessError) {
    return <div style={{ fontSize: 12, color: "#ff6b6b" }}>{accessError}</div>;
  }

  if (hasAccess === false && awaitingActivation) {
    return (
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <Lock size={16} color={green} style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ fontSize: 12, color: mutedLight, lineHeight: 1.6 }}>
          Confirming your subscription — this can take up to a couple of minutes while it's
          picked up on our end. This will update on its own once it's through.
        </div>
      </div>
    );
  }

  if (hasAccess === false) {
    return (
      <div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
          <Lock size={16} color={muted} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 12, color: mutedLight, lineHeight: 1.6 }}>
            Core tier membership required — {featureDescription}. Subscribe (monthly or annual —
            either works) below to unlock it.
          </div>
        </div>
        <div style={{ marginLeft: 26 }}>
          <div style={{ fontSize: 11, color: muted, marginBottom: 6 }}>
            Already subscribed? It can take a minute or two to activate after purchase.
          </div>
          <button
            type="button"
            onClick={checkAccessOnce}
            disabled={manualCheckLoading}
            style={{
              background: "none",
              border: `1px solid ${border}`,
              borderRadius: 8,
              padding: "5px 10px",
              color: manualCheckLoading ? muted : green,
              fontSize: 11,
              fontWeight: 700,
              cursor: manualCheckLoading ? "not-allowed" : "pointer",
            }}
          >
            {manualCheckLoading ? "Checking…" : "Check again"}
          </button>
        </div>
      </div>
    );
  }

  return children;
}
