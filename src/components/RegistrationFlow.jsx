import React, { useState, useEffect, useRef } from "react";
import { ethers } from "ethers";
import { ArrowLeft } from "lucide-react";
import { green, greenGlow, muted, mutedLight, error, panel2, border, orange } from "../styles/theme.js";
import { useRegistration } from "../hooks/useRegistration.js";
import { useAddressRecord } from "../hooks/useAddressRecord.js";
import { formatEth } from "../utils/format.js";
import { signNftGenerationRequest } from "../utils/backendAuth.js";
import NeonButton from "./NeonButton.jsx";
import UsdEstimate from "./UsdEstimate.jsx";
import { EXPLORER_BASE_URL, BACKEND_IMAGE_URL, DEFAULT_DURATION_SECONDS, DURATION_OPTIONS } from "../config.js";

const COMMIT_WAIT_MESSAGES = [
  "Broadcasting your commitment to the Electroneum network...",
  "Locking in your name before anyone else can grab it...",
  "This short wait keeps registrations fair — no front-running bots allowed...",
  "Charging up the NameWrapper...",
  "Give it a moment — good things take a few seconds...",
];

// Circular countdown ring — drains as the commitment wait elapses, with an orbiting particle and
// a pulse that intensifies in the final stretch. Pure inline-SVG + CSS animation, no libraries.
function CommitmentRing({ countdown, totalWait }) {
  const size = 160;
  const radius = 68;
  const circumference = 2 * Math.PI * radius;
  const progress = totalWait > 0 ? Math.min(1, Math.max(0, 1 - countdown / totalWait)) : 1;
  const ready = countdown <= 0;
  const finalStretch = !ready && countdown <= 10;

  return (
    <div style={{ position: "relative", width: size, height: size, margin: "0 auto 20px" }}>
      <style>{`
        @keyframes rfw-orbit { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes rfw-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
        @keyframes rfw-ready-pulse { 0%, 100% { box-shadow: 0 0 20px ${greenGlow}; } 50% { box-shadow: 0 0 40px ${greenGlow}; } }
      `}</style>

      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={border} strokeWidth="6" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={green}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          style={{
            transition: "stroke-dashoffset 1s linear",
            filter: `drop-shadow(0 0 ${ready ? 10 : 6}px ${greenGlow})`,
          }}
        />
      </svg>

      {!ready && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            animation: `rfw-orbit ${finalStretch ? 1.2 : 3}s linear infinite`,
          }}
        >
          <div
            style={{
              position: "absolute",
              top: -2,
              left: "50%",
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: green,
              boxShadow: `0 0 10px ${greenGlow}`,
              transform: "translateX(-50%)",
            }}
          />
        </div>
      )}

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          animation: ready ? "rfw-ready-pulse 1.6s ease-in-out infinite" : "none",
        }}
      >
        <div
          style={{
            fontSize: ready ? 34 : 40,
            fontWeight: 900,
            fontFamily: '"Orbitron", sans-serif',
            color: green,
            textShadow: `0 0 20px ${greenGlow}`,
            animation: finalStretch ? "rfw-pulse 1s ease-in-out infinite" : "none",
            lineHeight: 1,
          }}
        >
          {ready ? "✓" : countdown}
        </div>
        {!ready && (
          <div style={{ fontSize: 11, color: mutedLight, marginTop: 6, letterSpacing: 1 }}>
            SECONDS
          </div>
        )}
        {ready && (
          <div style={{ fontSize: 11, color: green, marginTop: 6, letterSpacing: 1, fontWeight: 700 }}>
            READY
          </div>
        )}
      </div>
    </div>
  );
}

// Registration is commit-reveal: commit() on the real registrar, wait minCommitmentAge, then
// registerName() on the marketplace. Two separate wallet confirmations plus a wait in between.
export default function RegistrationFlow({
  nameData,
  wallet,
  onBack = null,
  onSuccess = null,
}) {
  const [quote, setQuote] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [step, setStep] = useState("choose"); // choose | committing | waiting | registering | success | error
  const [countdown, setCountdown] = useState(0);
  const [expired, setExpired] = useState(false);
  const [waitMessageIndex, setWaitMessageIndex] = useState(0);
  const [txHash, setTxHash] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [errorStage, setErrorStage] = useState(null); // "commit" | "register"
  const [nftImage, setNftImage] = useState(null);
  const [nftStorageUrl, setNftStorageUrl] = useState(null);
  const [addrStatus, setAddrStatus] = useState(null); // null | "pending" | "success" | "error"

  const {
    quoteRegistration,
    computeCommitment,
    getMinCommitmentAge,
    getMaxCommitmentAge,
    commitRegistration,
    registerName,
    savePendingCommitment,
    loadPendingCommitment,
    clearPendingCommitment,
  } = useRegistration();
  const { setAddr } = useAddressRecord();

  const label = nameData.name;
  const displayName = `${label}.etn`;
  const [duration, setDuration] = useState(DEFAULT_DURATION_SECONDS);
  const selectedOption = DURATION_OPTIONS.find((o) => o.seconds === duration) ?? DURATION_OPTIONS[0];

  // Holds the in-flight commitment's details across the async handleRegister sequence.
  const pendingRef = useRef({ secret: null, referrer: null, commitTimestamp: null, minAge: null, maxAge: null });

  useEffect(() => {
    (async () => {
      setQuoteLoading(true);
      try {
        const q = await quoteRegistration(label, duration);
        setQuote(q);
      } catch (err) {
        console.error("Price fetch failed:", err);
        setQuote(null);
      }
      setQuoteLoading(false);
    })();
  }, [label, duration, quoteRegistration]);

  // Resume a pending commitment (e.g. after a page reload) if one exists and hasn't expired.
  useEffect(() => {
    const pending = loadPendingCommitment(label);
    if (!pending) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const maxAgeExpiry = pending.commitTimestamp + pending.maxAge;
    if (nowSec >= maxAgeExpiry) {
      clearPendingCommitment(label);
      return;
    }

    pendingRef.current = {
      secret: pending.secret,
      referrer: pending.referrer,
      commitTimestamp: pending.commitTimestamp,
      minAge: pending.minAge,
      maxAge: pending.maxAge,
    };
    setStep("waiting");
  }, [label, loadPendingCommitment, clearPendingCommitment]);

  // Live countdown + expiry check while waiting.
  useEffect(() => {
    if (step !== "waiting") return;

    const tick = () => {
      const { commitTimestamp, minAge, maxAge } = pendingRef.current;
      if (commitTimestamp == null) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const remaining = commitTimestamp + minAge - nowSec;
      setCountdown(Math.max(0, remaining));
      setExpired(nowSec >= commitTimestamp + maxAge);
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [step]);

  // Cycles the flavor text under the commitment ring so the wait doesn't feel static.
  useEffect(() => {
    if (step !== "waiting") {
      setWaitMessageIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setWaitMessageIndex((i) => (i + 1) % COMMIT_WAIT_MESSAGES.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [step]);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const runCommit = async (signer) => {
    setStep("committing");
    setErrorStage(null);

    const secret = ethers.hexlify(ethers.randomBytes(32));
    const referrer = ethers.ZeroHash;

    const commitment = await computeCommitment(label, duration, secret, referrer);
    await commitRegistration(commitment, signer);

    const [minAge, maxAge] = await Promise.all([getMinCommitmentAge(), getMaxCommitmentAge()]);
    const commitTimestamp = Math.floor(Date.now() / 1000);

    pendingRef.current = { secret, referrer, commitTimestamp, minAge: Number(minAge), maxAge: Number(maxAge) };
    savePendingCommitment(label, {
      secret,
      referrer,
      commitTimestamp,
      minAge: Number(minAge),
      maxAge: Number(maxAge),
    });

    setStep("waiting");
  };

  const runRegister = async (signer) => {
    setStep("registering");
    setErrorStage(null);

    // Re-quote defensively in case pricing drifted during the wait.
    const freshQuote = await quoteRegistration(label, duration);
    setQuote(freshQuote);

    const { secret, referrer } = pendingRef.current;
    const result = await registerName(label, duration, secret, referrer, wallet.account, freshQuote.totalPrice, signer);

    setTxHash(result.txHash);
    setStep("success");
    onSuccess?.(result);

    if (result.node) {
      generateNftAndLink(result.name, result.node, signer);
      assignAddress(result.node, signer);
    }
  };

  const handleRegister = async () => {
    if (!wallet.isConnected) {
      setErrorMsg("Wallet not connected");
      return;
    }

    try {
      const signer = await wallet.getSigner();
      await runCommit(signer);
    } catch (err) {
      console.error("Commit error:", err);
      setErrorMsg(err?.reason || err?.message || "Commit failed");
      setErrorStage("commit");
      setStep("error");
    }
  };

  const handleCompleteRegistration = async () => {
    try {
      const signer = await wallet.getSigner();
      await runRegister(signer);
    } catch (err) {
      console.error("Registration error:", err);
      setErrorMsg(err?.reason || err?.message || "Registration failed");
      setErrorStage("register");
      setStep("error");
    }
  };

  const handleRetry = async () => {
    setErrorMsg(null);
    if (errorStage === "register" && pendingRef.current.commitTimestamp != null) {
      // Commitment may still be valid — try registering again without re-committing.
      const nowSec = Math.floor(Date.now() / 1000);
      const { commitTimestamp, maxAge } = pendingRef.current;
      if (nowSec < commitTimestamp + maxAge) {
        setStep("waiting");
        return;
      }
    }
    clearPendingCommitment(label);
    pendingRef.current = { secret: null, referrer: null, commitTimestamp: null, minAge: null, maxAge: null };
    setStep("choose");
  };

  const generateNftAndLink = async (fullName, nodeHex, signer) => {
    try {
      // Proves to the backend we actually own this node before it'll generate/store art for
      // it — see backend/utils/verifyOwnership.js.
      const { timestamp, signature } = await signNftGenerationRequest(signer, nodeHex);

      const res = await fetch(`${BACKEND_IMAGE_URL}/api/generate-nft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // "namespace" is the gold template — reserved for top-level parent names, distinct from
        // the blue "default" template subnames get (see SubnameSearch.jsx).
        body: JSON.stringify({ fullName, nodeHex, template: "namespace", timestamp, signature }),
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

  // Newly-registered names are wrapped straight to the buyer, so they're immediately recognized
  // as the real owner by the resolver's own NameWrapper-aware authorization — no separate
  // approval step needed here (unlike activating a retro-registered name). Fire-and-forget, same
  // as generateNftAndLink above: a failure here doesn't mean the registration itself failed, just
  // that the name won't resolve to a wallet yet — the owner can still set it later from "Your
  // Names" (see ManageSubdomain.jsx's "Wallet Address" section).
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

  const basePriceEth = quote ? formatEth(quote.basePrice) : "0.00";
  const brokerageFeeEth = quote ? formatEth(quote.brokerageFee) : "0.00";
  const totalPriceEth = quote ? formatEth(quote.totalPrice) : "0.00";

  return (
    <div style={{ width: "100%", maxWidth: 600, margin: "0 auto", padding: "0 16px" }}>
      {(step === "choose" || step === "committing" || step === "waiting" || step === "registering") && (
        <>
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
              Register Your Name
            </div>
            <h2 style={{
              fontSize: 30,
              fontWeight: 900,
              margin: "0 0 12px 0",
              color: "#fff",
              fontFamily: "monospace",
              letterSpacing: 0.5,
              textShadow: `0 0 16px ${greenGlow}`,
            }}>
              {displayName}
            </h2>
            <div style={{
              width: 40,
              height: 2,
              background: green,
              margin: "0 auto 14px",
              borderRadius: 2,
              boxShadow: `0 0 8px ${greenGlow}`,
            }} />
          </div>

          {/* Duration picker — only changeable before the commitment is locked in */}
          {step === "choose" && (
            <div style={{ marginBottom: 20 }}>
              <div style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: "uppercase",
                color: muted,
                marginBottom: 10,
                textAlign: "center",
              }}>
                Registration Length
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {DURATION_OPTIONS.map((option) => (
                  <button
                    key={option.seconds}
                    onClick={() => setDuration(option.seconds)}
                    disabled={quoteLoading}
                    style={{
                      flex: 1,
                      padding: "10px 8px",
                      borderRadius: 10,
                      border: `1px solid ${option.seconds === duration ? green : border}`,
                      background: option.seconds === duration ? "rgba(18,86,131,0.12)" : panel2,
                      color: option.seconds === duration ? green : mutedLight,
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: quoteLoading ? "not-allowed" : "pointer",
                      opacity: quoteLoading ? 0.6 : 1,
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Price breakdown */}
          <div style={{
            padding: 16,
            borderRadius: 12,
            background: panel2,
            border: `1px solid ${border}`,
            marginBottom: 24,
          }}>
            {quoteLoading ? (
              <div style={{ fontSize: 13, color: muted, textAlign: "center" }}>Loading price...</div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: mutedLight, marginBottom: 6 }}>
                  <span>Registration ({selectedOption.label}) paid to Electroneum</span>
                  <span>{basePriceEth} ETN</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: mutedLight, marginBottom: 10 }}>
                  <span>Brokerage fee</span>
                  <span>{brokerageFeeEth} ETN</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 16, fontWeight: 900, color: green, paddingTop: 10, borderTop: `1px solid ${border}` }}>
                  <span>Total</span>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    {totalPriceEth} ETN
                    <UsdEstimate etn={totalPriceEth} />
                  </span>
                </div>
              </>
            )}
          </div>

          {/* Step-specific content */}
          {step === "choose" && (
            <>
              <div style={{
                padding: 12,
                borderRadius: 10,
                background: `rgba(255,122,0,0.1)`,
                border: `1px solid ${orange}`,
                marginBottom: 24,
                fontSize: 12,
                color: "#ffb366",
                textAlign: "center",
                lineHeight: 1.6,
              }}>
                Registration requires 2 transactions with a short wait in between —
                first a commitment, then the actual registration.
              </div>

              <div style={{ display: "flex", gap: 12 }}>
                {onBack && (
                  <NeonButton variant="dark" onClick={onBack} style={{ flex: 1 }}>
                    Back
                  </NeonButton>
                )}
                <NeonButton
                  variant="green"
                  onClick={handleRegister}
                  disabled={quoteLoading}
                  style={{ flex: 1 }}
                >
                  Register for {totalPriceEth} ETN
                </NeonButton>
              </div>
            </>
          )}

          {step === "committing" && (
            <div style={{ textAlign: "center", padding: "20px 0", fontSize: 13, color: mutedLight }}>
              Submitting commitment — confirm in your wallet...
            </div>
          )}

          {step === "waiting" && !expired && (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <CommitmentRing countdown={countdown} totalWait={pendingRef.current.minAge || 60} />
              <div
                style={{
                  fontSize: 12,
                  color: mutedLight,
                  marginBottom: 20,
                  minHeight: 32,
                  padding: "0 12px",
                  lineHeight: 1.5,
                }}
              >
                {countdown > 0 ? COMMIT_WAIT_MESSAGES[waitMessageIndex] : `${displayName} is ready to claim.`}
              </div>
              <NeonButton
                variant="green"
                onClick={handleCompleteRegistration}
                disabled={countdown > 0}
                style={{ width: "100%", justifyContent: "center" }}
              >
                Complete Registration
              </NeonButton>
            </div>
          )}

          {step === "waiting" && expired && (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ fontSize: 13, color: error, marginBottom: 16 }}>
                Your commitment expired before registration was completed. Please start over.
              </div>
              <NeonButton
                variant="dark"
                onClick={() => {
                  clearPendingCommitment(label);
                  pendingRef.current = { secret: null, referrer: null, commitTimestamp: null, minAge: null, maxAge: null };
                  setStep("choose");
                }}
                style={{ width: "100%", justifyContent: "center" }}
              >
                Start Over
              </NeonButton>
            </div>
          )}

          {step === "registering" && (
            <div style={{ textAlign: "center", padding: "20px 0", fontSize: 13, color: mutedLight }}>
              Submitting registration — confirm in your wallet...
            </div>
          )}
        </>
      )}

      {step === "success" && (
        <div style={{ textAlign: "center", padding: "40px 20px" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
          <h2 style={{ fontSize: 28, fontWeight: 900, color: green, marginBottom: 8 }}>
            Subdomain Registered - You are now eligible to earn fees!
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
            {!nftImage && (
              <>
                <br />
                Your NFT is being generated and will appear shortly.
              </>
            )}
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
            Register Another Name
          </NeonButton>
        </div>
      )}

      {step === "error" && (
        <div style={{ textAlign: "center", padding: "40px 20px" }}>
          <div style={{ fontSize: 48, marginBottom: 16, color: error }}>✗</div>
          <h2 style={{ fontSize: 24, fontWeight: 900, color: error, marginBottom: 8 }}>
            Registration Failed
          </h2>
          <p style={{
            fontSize: 13,
            color: mutedLight,
            marginBottom: 24,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}>
            {errorMsg || "Something went wrong. Please try again."}
          </p>
          <div style={{ display: "flex", gap: 12 }}>
            <NeonButton variant="dark" onClick={() => setStep("choose")} style={{ flex: 1 }}>
              Back
            </NeonButton>
            <NeonButton variant="green" onClick={handleRetry} style={{ flex: 1 }}>
              Try Again
            </NeonButton>
          </div>
        </div>
      )}
    </div>
  );
}
