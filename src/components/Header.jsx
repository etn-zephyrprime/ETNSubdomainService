import React from "react";
import { Wallet } from "lucide-react";

import NeonButton from "./NeonButton.jsx";
import { green, panel, border } from "../styles/theme.js";
import { TransparentSubdomainLogo, SimplifyYourWallet } from "../../backend/assets/media.js";

function shortAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function Header({
  wallet,
  isMobile,
  hideWallet = false,
}) {
  return (
<div
  style={{
    display: "flex",
    flexDirection: isMobile ? "column" : "row",
    alignItems: isMobile ? "stretch" : "center",
    justifyContent: isMobile ? "flex-start" : "space-between",
    gap: isMobile ? 10 : 18,
    width: "100%",
    maxWidth: 680,
    margin: "0 auto",
    marginBottom: 32,
  }}
>
      {/* WALLET SECTION - Right aligned on mobile */}
      {!hideWallet && (
        <div
          style={{
            display: "flex",
            justifyContent: isMobile ? "flex-end" : "flex-end",
            alignItems: "center",
            width: isMobile ? "100%" : "auto",
            gap: 8,
            flexShrink: 0,
            order: isMobile ? 0 : 2,
          }}
        >
          {wallet.account ? (
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
              <span
                style={{
                  fontSize: isMobile ? 12 : 14,
                  fontWeight: 700,
                  color: "#fff",
                  letterSpacing: 0.4,
                }}
              >
                {shortAddress(wallet.account)}
              </span>
              <div style={{ width: 1, height: 16, background: "#333" }} />
              <button
                type="button"
                onClick={wallet.disconnectWallet}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#ff6b6b",
                  fontWeight: 700,
                  fontSize: isMobile ? 11 : 13,
                  cursor: "pointer",
                  padding: "2px 6px",
                }}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <NeonButton onClick={wallet.connectWallet}>
              Connect Wallet
            </NeonButton>
          )}
        </div>
      )}

{/* BRANDING SECTION */}
<div
  style={{
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
    minWidth: 0,
    flex: "0 1 auto",
    width: "100%",
    order: isMobile ? 1 : 1,
  }}
>
{/* Branding */}
{TransparentSubdomainLogo && (
  <img
    src={TransparentSubdomainLogo}
    alt="Subdomain Name Service"
    style={{
      height: isMobile ? 135 : 210,
      width: "auto",
      maxWidth: "100%",
      display: "block",
      pointerEvents: "none",
      objectFit: "contain",
      marginBottom: 12,
    }}
  />
)}

{/* Tagline */}
{SimplifyYourWallet && (
  <img
    src={SimplifyYourWallet}
    alt="Simplify Your Wallet"
    style={{
      width: isMobile ? "170px" : "220px",
      maxWidth: "100%",
      height: "auto",
      objectFit: "contain",
    }}
  />
)}
</div>
    </div>
  );
}