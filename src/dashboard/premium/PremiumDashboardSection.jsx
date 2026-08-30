import React, { useState } from "react";
import { useReownWallet } from "../../hooks/useReownWallet.jsx";
import MembershipPurchase from "./components/MembershipPurchase.jsx";
import PnlStatementRequest from "./components/PnlStatementRequest.jsx";
import PnlStatementViewer from "./components/PnlStatementViewer.jsx";
import { green, greenGlow, muted, mutedLight, border } from "../theme.js";

// Premium Feature #1 — per-wallet PnL statements. The one wallet-requiring corner of this
// otherwise-walletless dashboard (see DashboardApp.jsx's own header comment): DashboardApp.jsx
// loads this module lazily (React.lazy, only once the Premium tab is actually clicked), which is
// what keeps the WalletConnect/AppKit side effect this import triggers (see useReownWallet.jsx's
// own top-level createAppKit() call) out of the base dashboard bundle for every visitor who never
// touches this tab.
export default function PremiumDashboardSection({ initialStatementRequestId = null }) {
  const wallet = useReownWallet();
  const [showViewer, setShowViewer] = useState(!!initialStatementRequestId);

  return (
    <div style={{ width: "100%", maxWidth: 700, margin: "0 auto" }}>
      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
          Premium
        </div>
        <h2 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 12px 0", color: "#fff", textShadow: `0 0 16px ${greenGlow}` }}>
          Membership &amp; PnL Statements
        </h2>
        <div style={{ width: 40, height: 2, background: green, margin: "0 auto", borderRadius: 2, boxShadow: `0 0 8px ${greenGlow}` }} />
      </div>

      {!showViewer && (
        <div style={{ marginBottom: 20, display: "flex", justifyContent: "center" }}>
          <button
            onClick={() => wallet.isConnected ? wallet.disconnectWallet() : wallet.connectWallet()}
            style={{
              padding: "8px 16px",
              borderRadius: 10,
              border: `1px solid ${wallet.isConnected ? border : green}`,
              background: "transparent",
              color: wallet.isConnected ? mutedLight : green,
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {wallet.isConnected ? `${wallet.account.slice(0, 6)}...${wallet.account.slice(-4)} — Disconnect` : "Connect Wallet"}
          </button>
        </div>
      )}

      {showViewer ? (
        <PnlStatementViewer
          initialRequestId={initialStatementRequestId}
          onBack={() => setShowViewer(false)}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <MembershipPurchase wallet={wallet} />
          <PnlStatementRequest wallet={wallet} />

          <button
            onClick={() => setShowViewer(true)}
            style={{ background: "none", border: "none", color: green, fontSize: 13, fontWeight: 700, cursor: "pointer", textAlign: "center", padding: "8px 0" }}
          >
            Already have a statement? Look it up by request ID or transaction hash →
          </button>
        </div>
      )}
    </div>
  );
}
