import React, { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { Crown } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import DashboardButton from "./DashboardButton.jsx";
import { usePremiumSubscription } from "../../../hooks/usePremiumSubscription.js";
import { green, mutedLight, border, panel2, error as errorColor } from "../../theme.js";

const MONTH_OPTIONS = [1, 3, 6, 12];
const YEAR_OPTIONS = [1, 2, 3];

// Shows the connected wallet's current membership status for both independent tiers and lets
// them extend either. Monthly unlocks nothing on its own yet (reserved for future premium
// features to gate on); ONLY annual membership grants the 50% PnL statement discount (see
// PnlStatementRequest.jsx) — see PremiumSubscription.sol's header comment for why a cheap monthly
// signup deliberately can't reach that discount.
export default function MembershipPurchase({ wallet }) {
  const {
    isConfigured,
    getMembershipPricePerMonth,
    getAnnualMembershipPricePerYear,
    getMembershipExpiry,
    getAnnualMembershipExpiry,
    subscribe,
    subscribeAnnual,
    loading,
    error,
  } = usePremiumSubscription();

  const [tier, setTier] = useState("annual"); // annual first — it's the one that actually does something today

  const [pricePerMonth, setPricePerMonth] = useState(null);
  const [pricePerYear, setPricePerYear] = useState(null);
  const [monthlyExpiry, setMonthlyExpiry] = useState(null);
  const [annualExpiry, setAnnualExpiry] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [numMonths, setNumMonths] = useState(1);
  const [numYears, setNumYears] = useState(1);
  const [txHash, setTxHash] = useState(null);
  const [txSuccess, setTxSuccess] = useState(false);

  const refresh = useCallback(async () => {
    if (!isConfigured) return;
    try {
      const [monthPrice, yearPrice, monthExp, yearExp] = await Promise.all([
        getMembershipPricePerMonth(),
        getAnnualMembershipPricePerYear(),
        wallet?.account ? getMembershipExpiry(wallet.account) : Promise.resolve(null),
        wallet?.account ? getAnnualMembershipExpiry(wallet.account) : Promise.resolve(null),
      ]);
      setPricePerMonth(monthPrice);
      setPricePerYear(yearPrice);
      setMonthlyExpiry(monthExp);
      setAnnualExpiry(yearExp);
      setLoadError(null);
    } catch (err) {
      console.error("Failed to load membership status:", err);
      setLoadError("Couldn't load membership status");
    }
  }, [isConfigured, getMembershipPricePerMonth, getAnnualMembershipPricePerYear, getMembershipExpiry, getAnnualMembershipExpiry, wallet?.account]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!isConfigured) {
    return (
      <DashboardPanel>
        <div style={{ fontSize: 13, color: mutedLight }}>Premium membership isn't available yet — check back soon.</div>
      </DashboardPanel>
    );
  }

  const isAnnual = tier === "annual";
  const expiry = isAnnual ? annualExpiry : monthlyExpiry;
  const isActive = expiry != null && Number(expiry) * 1000 > Date.now();
  const expiryDate = expiry != null && Number(expiry) > 0 ? new Date(Number(expiry) * 1000) : null;
  const pricePerUnit = isAnnual ? pricePerYear : pricePerMonth;
  const numUnits = isAnnual ? numYears : numMonths;

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
      const result = isAnnual
        ? await subscribeAnnual(numYears, pricePerYear, signer)
        : await subscribe(numMonths, pricePerMonth, signer);
      setTxHash(result.txHash);
      setTxSuccess(true);
      await refresh();
    } catch (err) {
      // subscribe()/subscribeAnnual() already record the error via the hook's own `error` state.
    }
  };

  const tabStyle = (active) => ({
    flex: 1,
    padding: "10px 0",
    borderRadius: 10,
    border: `1px solid ${active ? green : border}`,
    background: active ? "rgba(24,187,26,0.15)" : panel2,
    color: active ? green : mutedLight,
    fontSize: 13,
    fontWeight: 800,
    cursor: "pointer",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  });

  return (
    <DashboardPanel>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Crown size={18} color={green} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Premium Membership
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={() => setTier("annual")} style={tabStyle(isAnnual)}>Annual</button>
        <button onClick={() => setTier("monthly")} style={tabStyle(!isAnnual)}>Monthly</button>
      </div>

      {isAnnual ? (
        <div style={{ fontSize: 11, color: mutedLight, marginBottom: 12 }}>
          Grants the 50% PnL statement discount. Monthly membership does not.
        </div>
      ) : (
        <div style={{ fontSize: 11, color: mutedLight, marginBottom: 12 }}>
          Reserved for future premium features — does not grant the PnL statement discount, no
          matter how many months you hold.
        </div>
      )}

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
        Price: {pricePerUnit != null ? <b style={{ color: "#fff" }}>{ethers.formatEther(pricePerUnit)} ETN / {isAnnual ? "year" : "month"}</b> : "Loading…"}
      </div>

      <label style={{ fontSize: 11, color: mutedLight, display: "block", marginBottom: 6 }}>
        {isAnnual ? "Years" : "Months"} to purchase{isActive ? " (extends your current expiry)" : ""}
      </label>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(isAnnual ? YEAR_OPTIONS : MONTH_OPTIONS).map((n) => (
          <button
            key={n}
            onClick={() => (isAnnual ? setNumYears(n) : setNumMonths(n))}
            style={{
              flex: 1,
              padding: "10px 0",
              borderRadius: 10,
              border: `1px solid ${numUnits === n ? green : border}`,
              background: numUnits === n ? "rgba(24,187,26,0.15)" : panel2,
              color: numUnits === n ? green : mutedLight,
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {n}{isAnnual ? "yr" : "mo"}
          </button>
        ))}
      </div>

      {pricePerUnit != null && (
        <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>
          Total: <b style={{ color: "#fff" }}>{ethers.formatEther(pricePerUnit * BigInt(numUnits))} ETN</b>
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: errorColor, marginBottom: 12 }}>{error}</div>}
      {txSuccess && (
        <div style={{ fontSize: 12, color: green, marginBottom: 12 }}>
          ✓ Membership updated
          {txHash && <div style={{ color: mutedLight, marginTop: 2, wordBreak: "break-all" }}>{txHash}</div>}
        </div>
      )}

      <DashboardButton
        onClick={handleSubscribe}
        disabled={loading || pricePerUnit == null}
        loading={loading}
        style={{ width: "100%", justifyContent: "center" }}
      >
        {!wallet.isConnected ? "Connect Wallet" : isActive ? "Extend Membership" : "Subscribe"}
      </DashboardButton>
    </DashboardPanel>
  );
}
