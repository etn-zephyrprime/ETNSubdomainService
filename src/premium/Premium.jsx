import React from "react";
import { ArrowLeft } from "lucide-react";
import MembershipPurchase from "./components/MembershipPurchase.jsx";
import PnlStatementRequest from "./components/PnlStatementRequest.jsx";
import { green, greenGlow, muted, border } from "../styles/theme.js";

// Entry screen for Premium Feature #1 — wallet-gated (unlike the rest of this dashboard, which is
// deliberately walletless; see src/dashboard/DashboardApp.jsx's own header comment on that
// design). Reached via the "Premium" button on the main search screen (see App.jsx); viewing an
// already-generated statement (PnlStatementViewer.jsx) is a separate, NOT wallet-gated flow
// reachable via its own /statement/:requestId deep link, since a shared statement link should
// work for anyone.
export default function Premium({ wallet, onBack = null, onViewStatements = null }) {
  return (
    <div style={{ width: "100%", maxWidth: 700, margin: "0 auto", padding: "0 16px" }}>
      {onBack && (
        <div style={{ marginBottom: 20 }}>
          <button
            onClick={onBack}
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: green, background: "rgba(18,86,131,0.06)", border: `1px solid ${border}`, borderRadius: 10, cursor: "pointer", padding: "8px 14px" }}
          >
            <ArrowLeft size={14} /> Back
          </button>
        </div>
      )}

      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
          Premium
        </div>
        <h2 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 12px 0", color: "#fff", textShadow: `0 0 16px ${greenGlow}` }}>
          Membership &amp; PnL Statements
        </h2>
        <div style={{ width: 40, height: 2, background: green, margin: "0 auto", borderRadius: 2, boxShadow: `0 0 8px ${greenGlow}` }} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <MembershipPurchase wallet={wallet} />
        <PnlStatementRequest wallet={wallet} />

        {onViewStatements && (
          <button
            onClick={onViewStatements}
            style={{ background: "none", border: "none", color: green, fontSize: 13, fontWeight: 700, cursor: "pointer", textAlign: "center", padding: "8px 0" }}
          >
            Already have a statement? Look it up by request ID or transaction hash →
          </button>
        )}
      </div>
    </div>
  );
}
