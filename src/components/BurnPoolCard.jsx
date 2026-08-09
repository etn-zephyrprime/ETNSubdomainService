import React, { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { Flame } from "lucide-react";
import Panel from "./Panel.jsx";
import NeonButton from "./NeonButton.jsx";
import { useBurnPool } from "../hooks/useBurnPool.js";
import { formatEth } from "../utils/format.js";
import { MARKETPLACE_OWNER_ADDRESS } from "../config.js";
import { green, greenGlow, muted, mutedLight, border, panel2, error as errorColor } from "../styles/theme.js";

// Re-polls the on-chain burnPool balance periodically so the card doesn't go stale while it's
// sitting on screen — e.g. after someone else's marketplace sale tops it up, or after this
// admin's own buyBackAndBurn drains it.
const POLL_INTERVAL_MS = 30000;

export default function BurnPoolCard({ wallet }) {
  const { getBurnPool, buyBackAndBurn, loading: burnLoading } = useBurnPool();

  const [burnPool, setBurnPool] = useState(null);
  const [poolError, setPoolError] = useState(null);
  const [minCoreOut, setMinCoreOut] = useState("0");
  const [txHash, setTxHash] = useState(null);
  const [txSuccess, setTxSuccess] = useState(false);
  const [txError, setTxError] = useState(null);

  const isAdmin =
    !!wallet?.account &&
    wallet.account.toLowerCase() === MARKETPLACE_OWNER_ADDRESS.toLowerCase();

  const refreshBurnPool = useCallback(async () => {
    try {
      const value = await getBurnPool();
      setBurnPool(value);
      setPoolError(null);
    } catch (err) {
      console.error("Failed to load burn pool:", err);
      setPoolError("Couldn't load burn pool balance");
    }
  }, [getBurnPool]);

  useEffect(() => {
    refreshBurnPool();
    const id = setInterval(refreshBurnPool, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refreshBurnPool]);

  const handleBuyBackAndBurn = async () => {
    setTxError(null);
    setTxSuccess(false);
    setTxHash(null);
    try {
      await wallet.ensureCorrectNetwork();
      const signer = await wallet.getSigner();
      // minCoreOut is entered as a human CORE amount (18 decimals, same as ETN) — convert before
      // sending. An empty/invalid field falls back to 0 (no slippage protection) rather than
      // blocking the call.
      let minCoreOutWei;
      try {
        minCoreOutWei = ethers.parseUnits(minCoreOut || "0", 18);
      } catch {
        minCoreOutWei = 0n;
      }
      const result = await buyBackAndBurn(minCoreOutWei, signer);
      setTxHash(result.txHash);
      setTxSuccess(true);
      await refreshBurnPool();
    } catch (err) {
      console.error("Buy back and burn failed:", err);
      setTxError(err?.reason || err?.message || "Buy back and burn failed");
    }
  };

  return (
    <Panel style={{ width: "100%", maxWidth: 600, margin: "16px auto 0", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Flame size={18} color={green} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Burn Pool
        </div>
      </div>

      {poolError ? (
        <div style={{ fontSize: 12, color: errorColor }}>{poolError}</div>
      ) : (
        <div style={{ fontSize: 26, fontWeight: 900, color: green, textShadow: `0 0 12px ${greenGlow}` }}>
          {burnPool === null ? "Loading…" : `${formatEth(burnPool)} ETN`}
        </div>
      )}
      <div style={{ fontSize: 11, color: mutedLight, marginTop: 6 }}>
        Accumulated from marketplace sales, awaiting a buy back &amp; burn into CORE.
      </div>

      {isAdmin && (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
            Admin
          </div>

          <label style={{ fontSize: 11, color: mutedLight, display: "block", marginBottom: 6 }}>
            Minimum CORE out (slippage protection — 0 accepts any amount)
          </label>
          <input
            type="text"
            inputMode="decimal"
            value={minCoreOut}
            onChange={(e) => setMinCoreOut(e.target.value)}
            placeholder="0"
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${border}`,
              background: panel2,
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              boxSizing: "border-box",
              outline: "none",
              marginBottom: 12,
            }}
          />

          {txError && (
            <div style={{ fontSize: 12, color: errorColor, marginBottom: 12 }}>{txError}</div>
          )}
          {txSuccess && (
            <div style={{ fontSize: 12, color: green, marginBottom: 12 }}>
              ✓ Buy back and burn submitted
              {txHash && (
                <div style={{ color: mutedLight, marginTop: 2, wordBreak: "break-all" }}>{txHash}</div>
              )}
            </div>
          )}

          <NeonButton
            variant="orange"
            onClick={handleBuyBackAndBurn}
            disabled={burnLoading || !burnPool || burnPool === 0n}
            loading={burnLoading}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {burnLoading ? "Burning..." : "Buy Back & Burn"}
          </NeonButton>
        </div>
      )}
    </Panel>
  );
}
