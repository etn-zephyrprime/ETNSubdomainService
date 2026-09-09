import React from "react";
import { ArrowLeft, Sparkles } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import CoreTierDemo from "./CoreTierDemo.jsx";
import { green, mutedLight, border, panel2 } from "../../theme.js";

// Standalone page for the Core Tier demo (Balance History + PnL for one fixed, real wallet with
// genuinely representative activity — see CoreTierDemo.jsx's own header comment; its address/ENS
// name is deliberately never shown here, only its data) — previously expanded IN PLACE of
// CoreTierPortfolio.jsx's own connect/subscribe gate, squeezed into that one panel alongside
// everything else Portfolio shows; that read as cramped and missing sections a real member's view
// has plenty of room for. Its own page gives it the same room every other tab gets. No wallet
// connection needed to view this — see CoreTierDemo.jsx's own imports, none of which touch wallet
// code, which is also why DashboardApp.jsx imports this directly rather than lazily the way the
// wallet-requiring tabs are.
export default function CoreTierDemoPage({ onSelectToken, onExit }) {
  return (
    <DashboardPanel>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Sparkles size={18} color={green} />
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
            Core Tier — Demo
          </div>
        </div>
        <button
          type="button"
          onClick={onExit}
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
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          <ArrowLeft size={13} />
          Exit Demo
        </button>
      </div>

      <div style={{ fontSize: 11, color: mutedLight, marginBottom: 20, lineHeight: 1.6 }}>
        A live preview of what Core Tier actually offers — Balance History and PnL — for{" "}
        <span style={{ color: "#fff", fontWeight: 700 }}>a real member's wallet</span> (anonymized
        here), not your own. Connect and subscribe under the Premium tab to track your own instead.
      </div>

      <CoreTierDemo onSelectToken={onSelectToken} />
    </DashboardPanel>
  );
}
