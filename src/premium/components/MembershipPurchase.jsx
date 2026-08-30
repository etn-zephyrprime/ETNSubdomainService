import React, { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { Crown } from "lucide-react";
import Panel from "../../components/Panel.jsx";
import NeonButton from "../../components/NeonButton.jsx";
import { usePremiumSubscription } from "../../hooks/usePremiumSubscription.js";
import { green, greenGlow, muted, mutedLight, border, panel2, error as errorColor } from "../../styles/theme.js";

const MONTH_OPTIONS = [1, 3, 6, 12];

// Shows the connected wallet's current premium membership status and lets them extend it —
// membership doesn't unlock anything on its own yet (v1 ships only the PnL statement feature),
// except one thing: an active member gets every PnL statement period free (see
// PnlStatementRequest.jsx) instead of paying pnlPricePerPeriod.
export default function MembershipPurchase({ wallet }) {
  const { isConfigured, getMembershipPricePerMonth, getMembershipExpiry, subscribe, loading, error } = usePremiumSubscription();

  const [pricePerMonth, setPricePerMonth] = useState(null);
  const [expiry, setExpiry] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [numMonths, setNumMonths] = useState(1);
  const [txHash, setTxHash] = useState(null);
  const [txSuccess, setTxSuccess] = useState(false);

  const refresh = useCallback(async () => {
    if (!isConfigured) return;
    try {
      const [price, exp] = await Promise.all([
        getMembershipPricePerMonth(),
        wallet?.account ? getMembershipExpiry(wallet.account) : Promise.resolve(null),
      ]);
      setPricePerMonth(price);
      setExpiry(exp);
      setLoadError(null);
    } catch (err) {
      console.error("Failed to load membership status:", err);
      setLoadError("Couldn't load membership status");
    }
  }, [isConfigured, getMembershipPricePerMonth, getMembershipExpiry, wallet?.account]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!isConfigured) {
    return (
      <Panel style={{ width: "100%", maxWidth: 600, margin: "0 auto" }}>
        <div style={{ fontSize: 13, color: mutedLight }}>Premium membership isn't available yet — check back soon.</div>
      </Panel>
    );
  }

  const isActive = expiry != null && Number(expiry) * 1000 > Date.now();
  const expiryDate = expiry != null && Number(expiry) > 0 ? new Date(Number(expiry) * 1000) : null;

  const handleSubscribe = async () => {
    setTxSuccess(false);
    setTxHash(null);
    if (!wallet.isConnected) {
      await wallet.connectWallet();
      return;
    }
    try {
      await wallet.ensureCorrectNetwork();
      const signer = await wallet.getSigner();
      const result = await subscribe(numMonths, pricePerMonth, signer);
      setTxHash(result.txHash);
      setTxSuccess(true);
      await refresh();
    } catch (err) {
      // subscribe() already records the error via the hook's own `error` state.
    }
  };

  return (
    <Panel style={{ width: "100%", maxWidth: 600, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Crown size={18} color={green} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Premium Membership
        </div>
      </div>

      {loadError && <div style={{ fontSize: 12, color: errorColor, marginBottom: 12 }}>{loadError}</div>}

      <div style={{ fontSize: 13, color: mutedLight, marginBottom: 6 }}>
        Status: {wallet?.account ? (
          <span style={{ color: isActive ? green : mutedLight, fontWeight: 700 }}>
            {isActive ? `Active until ${expiryDate.toLocaleDateString()}` : "Not active"}
          </span>
        ) : (
          "Connect your wallet to check"
        )}
      </div>

      <div style={{ fontSize: 13, color: mutedLight, marginBottom: 16 }}>
        Price: {pricePerMonth != null ? <b style={{ color: "#fff" }}>{ethers.formatEther(pricePerMonth)} ETN / month</b> : "Loading…"}
      </div>

      <label style={{ fontSize: 11, color: mutedLight, display: "block", marginBottom: 6 }}>
        Months to purchase{isActive ? " (extends your current expiry)" : ""}
      </label>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {MONTH_OPTIONS.map((m) => (
          <button
            key={m}
            onClick={() => setNumMonths(m)}
            style={{
              flex: 1,
              padding: "10px 0",
              borderRadius: 10,
              border: `1px solid ${numMonths === m ? green : border}`,
              background: numMonths === m ? "rgba(18,86,131,0.15)" : panel2,
              color: numMonths === m ? green : mutedLight,
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {m}mo
          </button>
        ))}
      </div>

      {pricePerMonth != null && (
        <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>
          Total: <b style={{ color: "#fff" }}>{ethers.formatEther(pricePerMonth * BigInt(numMonths))} ETN</b>
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: errorColor, marginBottom: 12 }}>{error}</div>}
      {txSuccess && (
        <div style={{ fontSize: 12, color: green, marginBottom: 12 }}>
          ✓ Membership updated
          {txHash && <div style={{ color: mutedLight, marginTop: 2, wordBreak: "break-all" }}>{txHash}</div>}
        </div>
      )}

      <NeonButton
        variant="green"
        onClick={handleSubscribe}
        disabled={loading || pricePerMonth == null}
        loading={loading}
        style={{ width: "100%", justifyContent: "center" }}
      >
        {!wallet.isConnected ? "Connect Wallet" : isActive ? "Extend Membership" : "Subscribe"}
      </NeonButton>
    </Panel>
  );
}
