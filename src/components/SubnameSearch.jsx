import React, { useState, useEffect, useRef } from "react";
import { ethers } from "ethers";
import { ArrowLeft } from "lucide-react";
import { green, greenGlow, muted, mutedLight, error, panel2, border, orange } from "../styles/theme.js";
import { useSubnameRegistration } from "../hooks/useSubnameRegistration.js";
import { useAddressRecord } from "../hooks/useAddressRecord.js";
import { computeNode } from "../utils/ens.js";
import { formatEth } from "../utils/format.js";
import { containsBlockedWord } from "../utils/obscenity.js";
import { signNftGenerationRequest } from "../utils/backendAuth.js";
import NeonButton from "./NeonButton.jsx";
import Spinner from "./Spinner.jsx";
import { EXPLORER_BASE_URL, BACKEND_IMAGE_URL, DURATION_OPTIONS } from "../config.js";

const YEAR_SECONDS = 365 * 24 * 60 * 60;

// Buyer picks their own label under a domain the owner has set a price for — single-level
// subnames only (e.g. "shop.alice" -> shop.alice.etn), no commit-reveal, one transaction.
export default function SubnameSearch({ wallet, onBack = null }) {
  const [rawInput, setRawInput] = useState("");
  const [checkLoading, setCheckLoading] = useState(false);
  const [checkError, setCheckError] = useState(null);
  const [checked, setChecked] = useState(null); // { subLabel, parentLabel, parentNode, pricePerYear, availableDurations }
  const [selectedDuration, setSelectedDuration] = useState(null);

  const [registerLoading, setRegisterLoading] = useState(false);
  const [registerError, setRegisterError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [txHash, setTxHash] = useState(null);
  const [nftImage, setNftImage] = useState(null);
  const [nftStorageUrl, setNftStorageUrl] = useState(null);
  const [addrStatus, setAddrStatus] = useState(null); // null | "pending" | "success" | "error"

  const [parentDomains, setParentDomains] = useState([]);
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [domainsError, setDomainsError] = useState(null);

  const inputRef = useRef(null);

  const {
    getSubnamePricePerYear,
    getParentExpiry,
    checkSubnameAvailable,
    getAvailableParentDomains,
    registerSubname,
  } = useSubnameRegistration();
  const { setAddr } = useAddressRecord();

  useEffect(() => {
    (async () => {
      setDomainsLoading(true);
      try {
        const domains = await getAvailableParentDomains();
        setParentDomains(domains);
      } catch (err) {
        console.error("Failed to list domains selling subnames:", err);
        setDomainsError("Couldn't load the list of domains — you can still type a name directly below.");
      } finally {
        setDomainsLoading(false);
      }
    })();
  }, [getAvailableParentDomains]);

  const handleSelectParent = (label) => {
    setRawInput(`.${label}`);
    setChecked(null);
    setSelectedDuration(null);
    setCheckError(null);
    const el = inputRef.current;
    if (el) {
      el.focus();
      // Cursor at the start so typing a subname prepends it before the dot, e.g. "shop.alice".
      requestAnimationFrame(() => el.setSelectionRange(0, 0));
    }
  };

  const parseInput = (value) => {
    const dotIndex = value.indexOf(".");
    if (dotIndex <= 0 || dotIndex === value.length - 1) return null;
    const subLabel = value.slice(0, dotIndex);
    const parentLabel = value.slice(dotIndex + 1);
    if (!subLabel || !parentLabel || parentLabel.includes(".")) return null;
    return { subLabel, parentLabel };
  };

  const handleCheck = async () => {
    setCheckError(null);
    setChecked(null);
    setSelectedDuration(null);
    setRegisterError(null);

    const parsed = parseInput(rawInput);
    if (!parsed) {
      setCheckError('Enter as "subname.parentname" (e.g. shop.alice)');
      return;
    }
    const { subLabel, parentLabel } = parsed;

    if (containsBlockedWord(subLabel)) {
      setCheckError("This name isn't allowed");
      return;
    }

    setCheckLoading(true);
    try {
      const parentNode = computeNode(parentLabel);
      const pricePerYear = await getSubnamePricePerYear(parentNode);

      if (pricePerYear === 0n) {
        setCheckError(`"${parentLabel}.etn" isn't selling subnames`);
        return;
      }

      const available = await checkSubnameAvailable(parentNode, subLabel);
      if (!available) {
        setCheckError(`"${subLabel}.${parentLabel}.etn" is already taken`);
        return;
      }

      // A subname can never outlive its parent — only offer presets that fit within whatever
      // time the parent domain actually has left.
      const parentExpiry = await getParentExpiry(parentNode);
      const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
      const remaining = parentExpiry - nowSeconds;
      const availableDurations = DURATION_OPTIONS.filter((o) => BigInt(o.seconds) <= remaining);

      if (availableDurations.length === 0) {
        setCheckError(
          `"${parentLabel}.etn" doesn't have enough time left (${Math.max(0, Number(remaining) / 86400).toFixed(0)} days) for any subname length — ask the owner to renew it first.`
        );
        return;
      }

      setChecked({ subLabel, parentLabel, parentNode, pricePerYear, availableDurations });
      setSelectedDuration(availableDurations[0].seconds);
    } catch (err) {
      console.error("Subname check failed:", err);
      setCheckError(err?.reason || err?.message || "Check failed");
    } finally {
      setCheckLoading(false);
    }
  };

  const generateNftAndLink = async (fullName, nodeHex, signer) => {
    try {
      // Proves to the backend we actually own this node before it'll generate/store art for
      // it — see backend/utils/verifyOwnership.js.
      const { timestamp, signature } = await signNftGenerationRequest(signer, nodeHex);

      const res = await fetch(`${BACKEND_IMAGE_URL}/api/generate-nft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // "default" is the blue template — subnames get this, top-level parent names get the
        // gold "namespace" template (see RegistrationFlow.jsx). Explicit here even though the
        // backend already defaults to it, so the mapping is visible from either file.
        body: JSON.stringify({ fullName, nodeHex, template: "default", timestamp, signature }),
      });
      const data = await res.json();
      if (data.success) {
        setNftImage(data.image);
        setNftStorageUrl(data.storageUrl || null);
      }
    } catch (err) {
      console.error("NFT generation request failed:", err);
    }
  };

  // Newly-registered subnames are wrapped straight to the buyer, so they're immediately
  // recognized as the real owner by the resolver's own NameWrapper-aware authorization — no
  // separate approval step needed here (unlike activating a retro-registered name).
  // Fire-and-forget, same as generateNftAndLink above: a failure here doesn't mean the
  // registration itself failed, just that the subname won't resolve to a wallet yet — the owner
  // can still set it later from "Your Names" (see ManageSubdomain.jsx's "Wallet Address" section).
  const assignAddress = async (nodeHex, signer) => {
    setAddrStatus("pending");
    try {
      await setAddr(nodeHex, wallet.account, signer);
      setAddrStatus("success");
    } catch (err) {
      console.error("Setting address record failed:", err);
      setAddrStatus("error");
    }
  };

  // Mirrors the contract's own quoteSubname math exactly (pricePerYear * duration / 365 days) —
  // computed client-side so the price updates instantly as the buyer changes the duration
  // picker, without a round trip per click.
  const selectedPrice =
    checked && selectedDuration != null
      ? (checked.pricePerYear * BigInt(selectedDuration)) / BigInt(YEAR_SECONDS)
      : 0n;

  const handleRegister = async () => {
    if (!wallet.isConnected) {
      await wallet.connectWallet();
      return;
    }

    setRegisterError(null);
    setRegisterLoading(true);
    try {
      await wallet.ensureCorrectNetwork();
      const signer = await wallet.getSigner();
      const { subLabel, parentLabel, parentNode } = checked;
      const result = await registerSubname(parentNode, subLabel, selectedDuration, selectedPrice, signer);

      setTxHash(result.txHash);
      setSuccess(true);
      generateNftAndLink(`${subLabel}.${parentLabel}.etn`, result.subNode, signer);
      assignAddress(result.subNode, signer);
    } catch (err) {
      console.error("Subname registration failed:", err);
      setRegisterError(err?.reason || err?.message || "Registration failed");
    } finally {
      setRegisterLoading(false);
    }
  };

  const displayName = checked ? `${checked.subLabel}.${checked.parentLabel}.etn` : "";
  const priceEth = checked ? formatEth(selectedPrice) : "0.00";

  if (success) {
    return (
      <div style={{ width: "100%", maxWidth: 600, margin: "0 auto", padding: "0 16px" }}>
        <div style={{ textAlign: "center", padding: "40px 20px" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
          <h2 style={{ fontSize: 28, fontWeight: 900, color: green, marginBottom: 8 }}>
            Subname Registered!
          </h2>

          {nftImage ? (
            <img
              src={nftImage}
              alt={displayName}
              style={{
                width: "100%",
                maxWidth: 280,
                borderRadius: 14,
                border: `1px solid ${border}`,
                boxShadow: `0 0 20px ${greenGlow}`,
                marginBottom: 20,
              }}
            />
          ) : (
            <div style={{
              width: "100%",
              maxWidth: 280,
              aspectRatio: "1 / 1",
              margin: "0 auto 20px",
              borderRadius: 14,
              border: `1px solid ${border}`,
              background: panel2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              color: muted,
            }}>
              Generating artwork...
            </div>
          )}

          <p style={{ fontSize: 13, color: mutedLight, marginBottom: 24, lineHeight: 1.6 }}>
            <strong>{displayName}</strong> is now yours.
          </p>

          {addrStatus && (
            <p style={{
              fontSize: 12,
              color: addrStatus === "error" ? error : addrStatus === "success" ? green : orange,
              marginTop: -12,
              marginBottom: 24,
            }}>
              {addrStatus === "pending" && "Confirm in your wallet to point this name at your address..."}
              {addrStatus === "success" && `✓ ${displayName} now resolves to your wallet`}
              {addrStatus === "error" && "Couldn't set your wallet address — you can do this later from \"Your Names\"."}
            </p>
          )}

          {(txHash || nftStorageUrl) && (
            <div style={{
              display: "flex",
              justifyContent: "center",
              gap: 16,
              flexWrap: "wrap",
              marginBottom: 24,
            }}>
              {txHash && (
                <a
                  href={`${EXPLORER_BASE_URL}/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontSize: 12,
                    color: green,
                    textDecoration: "none",
                    borderBottom: `1px solid ${green}`,
                  }}
                >
                  View Transaction →
                </a>
              )}
              {nftStorageUrl && (
                <a
                  href={nftStorageUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontSize: 12,
                    color: green,
                    textDecoration: "none",
                    borderBottom: `1px solid ${green}`,
                  }}
                >
                  View Stored Image →
                </a>
              )}
            </div>
          )}

          <NeonButton variant="green" onClick={() => window.location.reload()} style={{ width: "100%" }}>
            Get Another Subname
          </NeonButton>
        </div>
      </div>
    );
  }

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
            background: "rgba(18,86,131,0.06)",
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
          Subnames
        </div>
        <h2 style={{
          fontSize: 28,
          fontWeight: 900,
          margin: "0 0 12px 0",
          color: "#fff",
          textShadow: `0 0 16px ${greenGlow}`,
        }}>
          Get a Subname
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

      <div style={{ marginBottom: 24 }}>
        <input
          ref={inputRef}
          type="text"
          placeholder="subname.parentname"
          value={rawInput}
          onChange={(e) => {
            setRawInput(e.target.value.toLowerCase().trim());
            setChecked(null);
            setSelectedDuration(null);
            setCheckError(null);
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
          onClick={handleCheck}
          disabled={checkLoading || !rawInput}
          loading={checkLoading}
          style={{ width: "100%", justifyContent: "center" }}
        >
          {checkLoading ? "Checking..." : "Check"}
        </NeonButton>
        {checkError && (
          <div style={{ fontSize: 12, color: error, marginTop: 8, textAlign: "center" }}>
            {checkError}
          </div>
        )}
      </div>

      {!domainsLoading && !domainsError && parentDomains.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
            Domains selling subnames
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {parentDomains.map(({ label, pricePerYear }) => (
              <button
                key={label}
                onClick={() => handleSelectParent(label)}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 6,
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: `1px solid ${border}`,
                  background: panel2,
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = green; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = border; }}
              >
                {label}.etn
                <span style={{ fontSize: 11, fontWeight: 600, color: mutedLight }}>
                  {formatEth(pricePerYear)} ETN/year
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {domainsLoading && (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          fontSize: 12,
          color: mutedLight,
          marginBottom: 24,
        }}>
          <Spinner size={14} />
          Loading domains selling subnames...
        </div>
      )}
      {domainsError && (
        <div style={{ fontSize: 12, color: mutedLight, marginBottom: 24, textAlign: "center" }}>
          {domainsError}
        </div>
      )}
      {!domainsLoading && !domainsError && parentDomains.length === 0 && (
        <div style={{ fontSize: 12, color: mutedLight, marginBottom: 24, textAlign: "center" }}>
          No domains are selling subnames yet.
        </div>
      )}

      {checked && (
        <div style={{
          padding: 16,
          borderRadius: 12,
          background: panel2,
          border: `1px solid ${border}`,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 12 }}>
            {displayName}
          </div>

          <div style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 1,
            textTransform: "uppercase",
            color: muted,
            marginBottom: 10,
          }}>
            Length
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            {checked.availableDurations.map((option) => (
              <button
                key={option.seconds}
                onClick={() => setSelectedDuration(option.seconds)}
                style={{
                  flex: 1,
                  padding: "10px 8px",
                  borderRadius: 10,
                  border: `1px solid ${option.seconds === selectedDuration ? green : border}`,
                  background: option.seconds === selectedDuration ? "rgba(18,86,131,0.12)" : panel2,
                  color: option.seconds === selectedDuration ? green : mutedLight,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          {checked.availableDurations.length < DURATION_OPTIONS.length && (
            <div style={{ fontSize: 11, color: mutedLight, marginBottom: 16, textAlign: "center" }}>
              Longer lengths aren't offered — "{checked.parentLabel}.etn" doesn't have that much time left.
            </div>
          )}

          <div style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 16,
            fontWeight: 900,
            color: green,
            marginBottom: 16,
          }}>
            <span>Price</span>
            <span>{priceEth} ETN</span>
          </div>

          {registerError && (
            <div style={{ fontSize: 12, color: error, marginBottom: 12 }}>
              {registerError}
            </div>
          )}

          <NeonButton
            variant="green"
            onClick={handleRegister}
            disabled={registerLoading}
            loading={registerLoading}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {!wallet.isConnected
              ? "Connect Wallet"
              : registerLoading
              ? "Registering..."
              : `Register for ${priceEth} ETN`}
          </NeonButton>
        </div>
      )}
    </div>
  );
}
