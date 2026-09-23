import React, { useState, useEffect, useCallback } from "react";
import { ArrowLeft } from "lucide-react";
import { green, greenGlow, muted, mutedLight, error } from "../styles/theme.js";
import { useCheckAvailability } from "../hooks/useCheckAvailability.js";
import NeonButton from "./NeonButton.jsx";
import Panel from "./Panel.jsx";
import { containsBlockedWord } from "../utils/obscenity.js";

export default function SearchBar({ wallet, onNameSelected = null }) {
  const [view, setView] = useState("main");
  const [nameInput, setNameInput] = useState("");
  const [availability, setAvailability] = useState(null);
  const [checkingDebounce, setCheckingDebounce] = useState(false);
  const { checkTopLevelAvailability } = useCheckAvailability();
  const [blockedWord, setBlockedWord] = useState(false);

  // Debounced availability check
  useEffect(() => {
    if (!nameInput || nameInput.length < 1) {
      setAvailability(null);
      setBlockedWord(false);
      return;
    }

    if (containsBlockedWord(nameInput)) {
      setBlockedWord(true);
      setAvailability(false);
      return;
    }
    setBlockedWord(false);

    const timer = setTimeout(async () => {
      setCheckingDebounce(true);
      try {
        const isAvailable = await checkTopLevelAvailability(nameInput);
        setAvailability(isAvailable);
      } catch (err) {
        console.error("Availability check error:", err);
        setAvailability(null);
      }
      setCheckingDebounce(false);
    }, 500);

    return () => clearTimeout(timer);
  }, [nameInput, checkTopLevelAvailability]);

  const displayName = `${nameInput}.etn`;

  const canProceed = wallet?.isConnected && availability === true && !blockedWord;

  const handleContinue = () => {
    if (!canProceed) return;
    onNameSelected?.({ name: nameInput });
  };

  const handleCreateName = useCallback(() => {
    if (!wallet?.isConnected) {
      wallet?.connectWallet?.();
      return;
    }
    setView("name");
  }, [wallet?.isConnected, wallet?.connectWallet]);

  return (
    <div style={{ width: "100%", maxWidth: 600, margin: "0 auto", padding: "0 16px" }}>
      {/* MAIN VIEW */}
      {view === "main" && (
        <NeonButton
          variant="green"
          onClick={handleCreateName}
          style={{ width: "100%", justifyContent: "center", padding: "16px" }}
        >
          Create Name
        </NeonButton>
      )}

      {/* NAME CREATION VIEW */}
      {view === "name" && (
        <>
          <div style={{ marginBottom: 20 }}>
            <button
              onClick={() => {
                setView("main");
                setNameInput("");
                setAvailability(null);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                fontWeight: 600,
                color: green,
                background: "rgba(255,255,255,0.05)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                border: `1px solid rgba(62,166,255,0.25)`,
                borderRadius: 999,
                cursor: "pointer",
                padding: "8px 14px",
              }}
            >
              <ArrowLeft size={14} />
              Back
            </button>
          </div>

          <div style={{ marginBottom: 16 }}>
            <input
              type="text"
              placeholder="alice"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value.toLowerCase().trim())}
              style={{
                width: "100%",
                padding: "14px 20px",
                borderRadius: 999,
                border: `1px solid ${availability === null ? "rgba(62,166,255,0.25)" : availability ? green : error}`,
                background: "rgba(255,255,255,0.05)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                color: "#fff",
                fontSize: 16,
                fontWeight: 600,
                boxSizing: "border-box",
                boxShadow: availability === null ? "none" : `0 0 12px ${availability ? greenGlow : "rgba(255,107,107,0.25)"}`,
                outline: "none",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = green;
                e.currentTarget.style.boxShadow = `0 0 12px ${greenGlow}`;
              }}
              onBlur={(e) => {
                if (availability === null) {
                  e.currentTarget.style.borderColor = "rgba(62,166,255,0.25)";
                  e.currentTarget.style.boxShadow = "none";
                }
              }}
            />
          </div>

          {nameInput && (
            <Panel style={{ marginBottom: 16 }} innerStyle={{ padding: 14, fontSize: 12, color: mutedLight, textAlign: "center" }}>
              {checkingDebounce && "Checking..."}
              <div style={{
                fontSize: 18,
                fontWeight: 700,
                color: "#fff",
                marginTop: checkingDebounce ? 4 : 0,
                fontFamily: '"Orbitron", sans-serif',
              }}>
                {displayName}
              </div>
            </Panel>
          )}

          {availability !== null && !checkingDebounce && (
            <div style={{
              padding: 14,
              borderRadius: 14,
              background: blockedWord ? `rgba(255,107,107,0.1)` : availability ? `rgba(18,86,131,0.1)` : `rgba(255,107,107,0.1)`,
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              border: `1px solid ${blockedWord ? error : availability ? green : error}`,
              marginBottom: 16,
              fontSize: 13,
              color: blockedWord ? error : availability ? green : error,
              fontWeight: 600,
              textAlign: "center",
            }}>
              {blockedWord
                ? "✗ This name isn't allowed"
                : availability
                ? "✓ Available — Ready to register"
                : "✗ Taken or expired"}
            </div>
          )}

          {!wallet?.isConnected && (
            <div style={{
              padding: 12,
              borderRadius: 14,
              background: `rgba(62,166,255,0.1)`,
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              border: `1px solid ${green}`,
              marginBottom: 16,
              fontSize: 12,
              color: "#fff",
              textAlign: "center",
            }}>
              Connect your wallet to continue
            </div>
          )}

          <NeonButton
            variant={canProceed ? "green" : "dark"}
            disabled={!canProceed}
            onClick={handleContinue}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {!wallet?.isConnected ? "Connect Wallet" : availability === true ? "Continue to Registration" : "Check Availability"}
          </NeonButton>

          <div style={{ marginTop: 20, fontSize: 11, color: muted, textAlign: "center", lineHeight: 1.6 }}>
            <div>Valid characters: lowercase letters, numbers, hyphens</div>
            <div>Length: 1–63 characters</div>
          </div>
        </>
      )}
    </div>
  );
}
