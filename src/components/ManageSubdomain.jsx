import React, { useState } from "react";
import { ethers } from "ethers";
import { ArrowLeft } from "lucide-react";
import { green, greenGlow, muted, mutedLight, error, panel2, border } from "../styles/theme.js";
import { useRenewal } from "../hooks/useRenewal.js";
import { useSubnamePricing } from "../hooks/useSubnamePricing.js";
import { computeNode } from "../utils/ens.js";
import NeonButton from "./NeonButton.jsx";
import { DEFAULT_DURATION_SECONDS } from "../config.js";

// "Your Names" — look up a name you own, view its expiry, renew it, and set a price for
// self-serve subname registration under it (activation/approval handled inline as needed).
export default function ManageSubdomain({ wallet, onBack = null }) {
  const [nameInput, setNameInput] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState(null);
  const [verifiedName, setVerifiedName] = useState(null);
  const [node, setNode] = useState(null);
  const [expiry, setExpiry] = useState(null);

  const [renewLoading, setRenewLoading] = useState(false);
  const [renewError, setRenewError] = useState(null);
  const [renewSuccess, setRenewSuccess] = useState(false);
  const [renewTxHash, setRenewTxHash] = useState(null);

  const [activated, setActivated] = useState(null);
  const [activationFee, setActivationFee] = useState(null);
  const [activationLoading, setActivationLoading] = useState(false);
  const [activationError, setActivationError] = useState(null);

  const [approved, setApproved] = useState(null);
  const [approveLoading, setApproveLoading] = useState(false);
  const [approveError, setApproveError] = useState(null);

  const [currentPrice, setCurrentPrice] = useState(null);
  const [priceInput, setPriceInput] = useState("");
  const [priceLoading, setPriceLoading] = useState(false);
  const [priceError, setPriceError] = useState(null);
  const [priceSuccess, setPriceSuccess] = useState(false);

  const { getOwner, getCurrentExpiry, quoteRenewal, renewName } = useRenewal();
  const {
    isDomainActivated,
    getActivationFee,
    activateDomain,
    isMarketplaceApproved,
    approveMarketplace,
    getSubnamePrice,
    setSubnamePrice,
  } = useSubnamePricing();

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
    setNode(null);
    setRenewSuccess(false);
    setRenewError(null);
    setActivated(null);
    setActivationFee(null);
    setActivationError(null);
    setApproved(null);
    setApproveError(null);
    setCurrentPrice(null);
    setPriceInput("");
    setPriceError(null);
    setPriceSuccess(false);

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

      const domainNode = computeNode(nameInput);
      setNode(domainNode);

      const isActivated = await isDomainActivated(domainNode);
      setActivated(isActivated);

      if (isActivated) {
        const [isApproved, price] = await Promise.all([
          isMarketplaceApproved(wallet.account),
          getSubnamePrice(domainNode),
        ]);
        setApproved(isApproved);
        setCurrentPrice(price);
      } else {
        const fee = await getActivationFee(nameInput, domainNode);
        setActivationFee(fee);
      }
    } catch (err) {
      console.error("Name lookup failed:", err);
      setLookupError(err?.reason || err?.message || "Lookup failed");
    } finally {
      setLookupLoading(false);
    }
  };

  const handleActivate = async () => {
    setActivationError(null);
    setActivationLoading(true);
    try {
      const signer = await wallet.getSigner();
      await activateDomain(node, verifiedName, activationFee, signer);
      setActivated(true);

      const [isApproved, price] = await Promise.all([
        isMarketplaceApproved(wallet.account),
        getSubnamePrice(node),
      ]);
      setApproved(isApproved);
      setCurrentPrice(price);
    } catch (err) {
      console.error("Activation failed:", err);
      setActivationError(err?.reason || err?.message || "Activation failed");
    } finally {
      setActivationLoading(false);
    }
  };

  const handleApprove = async () => {
    setApproveError(null);
    setApproveLoading(true);
    try {
      const signer = await wallet.getSigner();
      await approveMarketplace(signer);
      setApproved(true);
    } catch (err) {
      console.error("Approval failed:", err);
      setApproveError(err?.reason || err?.message || "Approval failed");
    } finally {
      setApproveLoading(false);
    }
  };

  const submitPrice = async (turnOff = false) => {
    setPriceError(null);
    setPriceSuccess(false);
    setPriceLoading(true);
    try {
      const priceWei = turnOff ? 0n : ethers.parseEther(priceInput || "0");
      const signer = await wallet.getSigner();
      await setSubnamePrice(node, priceWei, signer);
      setCurrentPrice(priceWei);
      setPriceSuccess(true);
      if (turnOff) setPriceInput("");
    } catch (err) {
      console.error("Setting subname price failed:", err);
      setPriceError(err?.reason || err?.message || "Setting price failed");
    } finally {
      setPriceLoading(false);
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

          <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${border}` }}>
            <div style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: muted,
              marginBottom: 12,
            }}>
              Subname Pricing
            </div>

            {activated === null && (
              <div style={{ fontSize: 12, color: mutedLight }}>Loading...</div>
            )}

            {activated === false && (
              <div>
                <div style={{ fontSize: 12, color: mutedLight, marginBottom: 10 }}>
                  This name was registered outside the marketplace and needs to be activated before
                  you can price subnames.
                </div>
                {activationError && (
                  <div style={{ fontSize: 12, color: error, marginBottom: 10 }}>{activationError}</div>
                )}
                <NeonButton
                  variant="dark"
                  onClick={handleActivate}
                  disabled={activationLoading || !activationFee}
                  loading={activationLoading}
                  style={{ width: "100%", justifyContent: "center" }}
                >
                  {activationLoading
                    ? "Activating..."
                    : activationFee
                    ? `Activate (${ethers.formatEther(activationFee)} ETN)`
                    : "Loading fee..."}
                </NeonButton>
              </div>
            )}

            {activated === true && approved === false && (
              <div>
                <div style={{ fontSize: 12, color: mutedLight, marginBottom: 10 }}>
                  Approve the marketplace to create subnames on your behalf when they're purchased.
                  One-time, applies to all names you own.
                </div>
                {approveError && (
                  <div style={{ fontSize: 12, color: error, marginBottom: 10 }}>{approveError}</div>
                )}
                <NeonButton
                  variant="dark"
                  onClick={handleApprove}
                  disabled={approveLoading}
                  loading={approveLoading}
                  style={{ width: "100%", justifyContent: "center" }}
                >
                  {approveLoading ? "Approving..." : "Approve Marketplace"}
                </NeonButton>
              </div>
            )}

            {activated === true && approved === true && (
              <div>
                <div style={{ fontSize: 12, color: mutedLight, marginBottom: 10 }}>
                  {currentPrice && currentPrice > 0n
                    ? `Currently selling subnames for ${ethers.formatEther(currentPrice)} ETN each.`
                    : "Not currently selling subnames."}
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="Price in ETN (e.g. 0.1)"
                  value={priceInput}
                  onChange={(e) => setPriceInput(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "12px 14px",
                    borderRadius: 10,
                    border: `1px solid ${border}`,
                    background: panel2,
                    color: "#fff",
                    fontSize: 14,
                    fontWeight: 600,
                    boxSizing: "border-box",
                    outline: "none",
                    marginBottom: 10,
                  }}
                />
                {priceError && (
                  <div style={{ fontSize: 12, color: error, marginBottom: 10 }}>{priceError}</div>
                )}
                {priceSuccess && (
                  <div style={{ fontSize: 12, color: green, marginBottom: 10 }}>✓ Price updated</div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <NeonButton
                    variant="green"
                    onClick={() => submitPrice(false)}
                    disabled={priceLoading || !priceInput}
                    loading={priceLoading}
                    style={{ flex: 1, justifyContent: "center" }}
                  >
                    {priceLoading ? "Setting..." : "Set Price"}
                  </NeonButton>
                  {currentPrice > 0n && (
                    <NeonButton
                      variant="dark"
                      onClick={() => submitPrice(true)}
                      disabled={priceLoading}
                      style={{ flex: 1, justifyContent: "center" }}
                    >
                      Turn Off
                    </NeonButton>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
