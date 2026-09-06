import React, { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { useReverseRecord } from "../../../hooks/useReverseRecord.js";
import { green, greenGlow, border, panel, error as errorColor } from "../../theme.js";

function shortAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Shared wallet-connect chip for every wallet-requiring premium tab (PnlStatements,
// PortfolioDashboardSection) — same look/behavior as the main site's Header.jsx, factored out
// here once a second tab needed the exact same "connect / show primary name or short address /
// disconnect" UI that PremiumDashboardSection.jsx originally inlined for itself alone.
export default function PremiumWalletChip({ wallet }) {
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
        console.error("Failed to fetch primary name for wallet chip:", err);
        if (!cancelled) setPrimaryName(null);
      }
    })();
    return () => { cancelled = true; };
  }, [wallet.account, getPrimaryName]);

  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
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
  );
}
