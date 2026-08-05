import React, { useState } from "react";
import { ethers } from "ethers";
import { ArrowLeft } from "lucide-react";
import { green, greenGlow, muted, mutedLight, error, panel2, border } from "../styles/theme.js";
import { useRenewal } from "../hooks/useRenewal.js";
import NeonButton from "./NeonButton.jsx";
import { DEFAULT_DURATION_SECONDS } from "../config.js";

// "Your Names" — look up a name you own, view its expiry, renew it. No namespace/listing
// concepts in V1: no accrued fees, no withdraw, no pricing floors.
export default function ManageSubdomain({ wallet, onBack = null }) {
  const [nameInput, setNameInput] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState(null);
  const [verifiedName, setVerifiedName] = useState(null);
  const [expiry, setExpiry] = useState(null);

  const [renewLoading, setRenewLoading] = useState(false);
  const [renewError, setRenewError] = useState(null);
  const [renewSuccess, setRenewSuccess] = useState(false);
  const [renewTxHash, setRenewTxHash] = useState(null);

  const { getOwner, getCurrentExpiry, quoteRenewal, renewName } = useRenewal();

  const handleLookup = async () => {
    if (!wallet.isConnected) {
      setLookupError("Connect your wallet first");
      return;
    }
    if (!nameInput) {
      setLookupError("Enter a name");
      return;
    }

    setLookupLoading(true);
    setLookupError(null);
    setVerifiedName(null);
    setRenewSuccess(false);
    setRenewError(null);

    try {
      const owner = await getOwner(nameInput);

      if (owner === ethers.ZeroAddress) {
        setLookupError(`"${nameInput}.etn" doesn't exist`);
        return;
      }

      if (owner.toLowerCase() !== wallet.account.toLowerCase()) {
        setLookupError("Your wallet doesn't own this name");
        return;
      }

      const currentExpiry = await getCurrentExpiry(nameInput);
      setExpiry(currentExpiry);
      setVerifiedName(nameInput);
    } catch (err) {
      console.error("Name lookup failed:", err);
      setLookupError(err?.reason || err?.message || "Lookup failed");
    } finally {
      setLookupLoading(false);
    }
  };

  const handleRenew = async () => {
    setRenewError(null);
    setRenewSuccess(false);
    setRenewLoading(true);

    try {
      const { totalPrice } = await quoteRenewal(verifiedName, DEFAULT_DURATION_SECONDS);
      const signer = await wallet.getSigner();
      const result = await renewName(verifiedName, DEFAULT_DURATION_SECONDS, ethers.ZeroHash, totalPrice, signer);

      setRenewTxHash(result.txHash);
      setRenewSuccess(true);

      const newExpiry = await getCurrentExpiry(verifiedName);
      setExpiry(newExpiry);
    } catch (err) {
      console.error("Renewal failed:", err);
      setRenewError(err?.reason || err?.message || "Renewal failed");
    } finally {
      setRenewLoading(false);
    }
  };

  const expiryDate = expiry ? new Date(Number(expiry) * 1000) : null;
  const daysRemaining = expiry ? Math.floor((Number(expiry) * 1000 - Date.now()) / (1000 * 60 * 60 * 24)) : null;

  return (
    <div style={{ width: "100%", maxWidth: 600, margin: "0 auto", padding: "0 16px" }}>
      <div style={{ marginBottom: 20 }}>
        <button
          onClick={onBack}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            fontWeight: 600,
            color: green,
            background: "rgba(0, 255, 140, 0.06)",
            border: `1px solid ${border}`,
            borderRadius: 10,
            cursor: "pointer",
            padding: "8px 14px",
          }}
        >
          <ArrowLeft size={14} />
          Back
        </button>
      </div>

      <div style={{ marginBottom: 32, textAlign: "center" }}>
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: muted,
          marginBottom: 10,
        }}>
          Manage
        </div>
        <h2 style={{
          fontSize: 28,
          fontWeight: 900,
          margin: "0 0 12px 0",
          color: "#fff",
          textShadow: `0 0 16px ${greenGlow}`,
        }}>
          Your Names
        </h2>
        <div style={{
          width: 40,
          height: 2,
          background: green,
          margin: "0 auto",
          borderRadius: 2,
          boxShadow: `0 0 8px ${greenGlow}`,
        }} />
      </div>

      {/* Lookup */}
      <div style={{ marginBottom: 24 }}>
        <input
          type="text"
          placeholder="your-name"
          value={nameInput}
          onChange={(e) => {
            setNameInput(e.target.value.toLowerCase().trim());
            setVerifiedName(null);
          }}
          style={{
            width: "100%",
            padding: "14px 16px",
            borderRadius: 12,
            border: `1px solid ${border}`,
            background: panel2,
            color: "#fff",
            fontSize: 16,
            fontWeight: 600,
            boxSizing: "border-box",
            outline: "none",
            marginBottom: 12,
          }}
        />
        <NeonButton
          variant="green"
          onClick={handleLookup}
          disabled={lookupLoading || !nameInput}
          loading={lookupLoading}
          style={{ width: "100%", justifyContent: "center" }}
        >
          {lookupLoading ? "Checking..." : "Look Up"}
        </NeonButton>
        {lookupError && (
          <div style={{ fontSize: 12, color: error, marginTop: 8, textAlign: "center" }}>
            {lookupError}
          </div>
        )}
      </div>

      {verifiedName && (
        <div style={{
          padding: 16,
          borderRadius: 12,
          background: panel2,
          border: `1px solid ${border}`,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 12 }}>
            {verifiedName}.etn
          </div>

          {expiryDate && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>Expires</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: daysRemaining < 30 ? "#ffb366" : "#fff" }}>
                {expiryDate.toLocaleDateString()} ({daysRemaining} days remaining)
              </div>
            </div>
          )}

          {renewError && (
            <div style={{ fontSize: 12, color: error, marginBottom: 12 }}>
              {renewError}
            </div>
          )}
          {renewSuccess && (
            <div style={{ fontSize: 12, color: green, marginBottom: 12 }}>
              ✓ Renewed successfully
            </div>
          )}

          <NeonButton
            variant="green"
            onClick={handleRenew}
            disabled={renewLoading}
            loading={renewLoading}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {renewLoading ? "Renewing..." : "Renew (1 year)"}
          </NeonButton>

          {renewTxHash && renewSuccess && (
            <div style={{ marginTop: 12, textAlign: "center", fontSize: 11, color: mutedLight }}>
              tx: {renewTxHash.slice(0, 10)}...{renewTxHash.slice(-8)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
