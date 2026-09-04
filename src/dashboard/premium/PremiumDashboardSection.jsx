import React, { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { useReownWallet } from "../../hooks/useReownWallet.jsx";
import { useReverseRecord } from "../../hooks/useReverseRecord.js";
import MembershipPurchase from "./components/MembershipPurchase.jsx";
import PnlStatementRequest from "./components/PnlStatementRequest.jsx";
import PnlStatementViewer from "./components/PnlStatementViewer.jsx";
import { green, greenGlow, muted, border, panel, error as errorColor } from "../theme.js";

function shortAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Premium Feature #1 — per-wallet PnL statements. The one wallet-requiring corner of this
// otherwise-walletless dashboard (see DashboardApp.jsx's own header comment): DashboardApp.jsx
// loads this module lazily (React.lazy, only once the Premium tab is actually clicked), which is
// what keeps the WalletConnect/AppKit side effect this import triggers (see useReownWallet.jsx's
// own top-level createAppKit() call) out of the base dashboard bundle for every visitor who never
// touches this tab.
export default function PremiumDashboardSection({ initialStatementRequestId = null }) {
  const wallet = useReownWallet();
  const [showViewer, setShowViewer] = useState(!!initialStatementRequestId);

  // Same "resolve the connected wallet's primary .etn name for display" pattern as the main
  // site's Header.jsx (src/components/Header.jsx) -- this tab is the dashboard's one
  // wallet-connected surface, so its wallet chip should look and behave like every other one in
  // the app rather than being its own one-off button. Dashboard theme tokens throughout below,
  // not the main site's ../styles/theme.js -- see dashboard/theme.js's own header comment on why
  // the two palettes stay deliberately separate.
  const { getPrimaryName } = useReverseRecord();
  const [primaryName, setPrimaryName] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!wallet.account) {
      setPrimaryName(null);
      return;
    }
    (async () => {
      try {
        const name = await getPrimaryName(wallet.account);
        if (!cancelled) setPrimaryName(name);
      } catch (err) {
        console.error("Failed to fetch primary name for dashboard wallet chip:", err);
        if (!cancelled) setPrimaryName(null);
      }
    })();
    return () => { cancelled = true; };
  }, [wallet.account, getPrimaryName]);

  return (
    <div style={{ width: "100%", maxWidth: 700, margin: "0 auto" }}>
      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
          Premium
        </div>
        <h2 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 12px 0", color: "#fff", textShadow: `0 0 16px ${greenGlow}` }}>
          PnL Statements
        </h2>
        <div style={{ width: 40, height: 2, background: green, margin: "0 auto", borderRadius: 2, boxShadow: `0 0 8px ${greenGlow}` }} />
      </div>

      {!showViewer && (
        <div style={{ marginBottom: 20, display: "flex", justifyContent: "center" }}>
          {wallet.isConnected ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: panel,
                padding: "8px 14px",
                borderRadius: 14,
                border: `1px solid ${border}`,
                boxShadow: "0 0 12px rgba(0,0,0,0.45)",
              }}
            >
              <Wallet size={16} color={green} />
              <span style={{ fontSize: 14, fontWeight: 700, color: "#fff", letterSpacing: 0.4 }}>
                {primaryName || shortAddress(wallet.account)}
              </span>
              <div style={{ width: 1, height: 16, background: border }} />
              <button
                type="button"
                onClick={wallet.disconnectWallet}
                style={{
                  background: "transparent",
                  border: "none",
                  color: errorColor,
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: "pointer",
                  padding: "2px 6px",
                }}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={wallet.connectWallet}
              style={{
                padding: "12px 16px",
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 800,
                cursor: "pointer",
                background: green,
                color: "#000",
                boxShadow: `0 0 12px ${greenGlow}`,
                border: "none",
              }}
            >
              Connect Wallet
            </button>
          )}
        </div>
      )}

      {showViewer ? (
        <PnlStatementViewer
          initialRequestId={initialStatementRequestId}
          onBack={() => setShowViewer(false)}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Membership purchase is turned off for now (2026-09-01) — not used yet, since
              membership currently unlocks nothing the discount paths (whitelist/Erevos/activated
              domain) don't already cover. Re-enable by restoring this line once membership grants
              something real. Import kept above rather than removed, for exactly that reason. */}
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
