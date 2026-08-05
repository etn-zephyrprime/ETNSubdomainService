import React from "react";
import { Wallet } from "lucide-react";

import NeonButton from "./NeonButton.jsx";
import { green, greenGlow, panel, border } from "../styles/theme.js";
import { PlanetZephyrosLogo, PlanetZephyrosText, SimplifyYourWallet } from "../../backend/assets/media.js";

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
{/* Logo + Text (tight) */}
<div
  style={{
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 4,
    justifyContent: "center",
    marginBottom: 8,
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    padding: isMobile ? "0 12px" : 0,
  }}
>
  {PlanetZephyrosLogo && (
    <img
      src={PlanetZephyrosLogo}
      alt="Planet Zephyros"
      style={{
        height: isMobile ? 52 : 72,
        width: "auto",
        display: "block",
        pointerEvents: "none",
        animation: "logoPulse 2.4s ease-in-out infinite",
        filter: "drop-shadow(0 0 14px rgba(0,255,140,0.18))",
        borderRadius: 8,
        objectFit: "contain",
        flexShrink: 0,
      }}
    />
  )}
  {PlanetZephyrosText && (
    <img
      src={PlanetZephyrosText}
      alt="Planet Zephyros"
      style={{
        height: isMobile ? 52 : 72,
        width: "auto",
        display: "block",
        filter: "drop-shadow(0 0 12px rgba(0,255,140,0.25))",
        animation: "vaultPulse 2.2s infinite",
        objectFit: "contain",
        flexShrink: 0,
      }}
    />
  )}
</div>

{/* Service Text */}
<div
  style={{
    fontFamily: '"Orbitron", sans-serif',
    fontWeight: 700,
    fontSize: isMobile ? 16 : 22,
    letterSpacing: 1,
    color: "#fff",
    textShadow: `0 0 16px ${greenGlow}`,
    textAlign: "center",
    marginBottom: 12,
  }}
>
  Subdomain Name Service
</div>

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