import React, { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { Crown, TriangleAlert } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import DashboardButton from "./DashboardButton.jsx";
import { usePremiumSubscription } from "../../../hooks/usePremiumSubscription.js";
import { green, mutedLight, border, panel2, error as errorColor, orange, orangeGlow, monoFont } from "../../theme.js";

const MONTH_OPTIONS = [1, 3, 6, 12];
const YEAR_OPTIONS = [1, 2, 3];

// How many days out each tier's "renew soon" warning kicks in — a monthly sub gets a 7-day heads
// up (roughly a quarter of its own billing cycle), an annual sub gets 30 (same proportion would be
// ~91 days, but 30 keeps the warning from firing for most of the year on a sub nobody's actually
// at risk of losing yet) — exact thresholds per the user's own request.
const MONTHLY_RENEWAL_WARNING_DAYS = 7;
const ANNUAL_RENEWAL_WARNING_DAYS = 30;
const SECONDS_PER_DAY = 86400;

/** Whichever tier is actually keeping Core Tier access alive right now, and how close ITS expiry
 * is — not just "is monthly expiring soon", since a member who ALSO holds a far-out annual sub
 * isn't at any real risk of losing access just because their monthly happens to lapse first. When
 * both are simultaneously active, the LATER of the two is the one that matters (it's what access
 * actually depends on); its own tier's threshold applies. Returns null when neither tier is
 * currently active (nothing to warn about — PortfolioDashboardSection already shows the full
 * "not a member" panel in that case). */
function computeExpiryStatus(monthlyExpiry, annualExpiry) {
  const nowSec = Date.now() / 1000;
  const monthlyActive = monthlyExpiry != null && Number(monthlyExpiry) > nowSec;
  const annualActive = annualExpiry != null && Number(annualExpiry) > nowSec;
  if (!monthlyActive && !annualActive) return null;

  let effectiveTier;
  let effectiveExpiry;
  if (monthlyActive && annualActive) {
    if (Number(annualExpiry) >= Number(monthlyExpiry)) {
      effectiveTier = "annual";
      effectiveExpiry = annualExpiry;
    } else {
      effectiveTier = "monthly";
      effectiveExpiry = monthlyExpiry;
    }
  } else if (annualActive) {
    effectiveTier = "annual";
    effectiveExpiry = annualExpiry;
  } else {
    effectiveTier = "monthly";
    effectiveExpiry = monthlyExpiry;
  }

  const daysRemaining = (Number(effectiveExpiry) - nowSec) / SECONDS_PER_DAY;
  const warningThresholdDays = effectiveTier === "annual" ? ANNUAL_RENEWAL_WARNING_DAYS : MONTHLY_RENEWAL_WARNING_DAYS;
  return {
    effectiveTier,
    daysRemaining,
    isEndingSoon: daysRemaining <= warningThresholdDays,
  };
}

// Shows the connected wallet's current membership status for both independent tiers and lets
// them extend either. Both tiers now unlock Core Tier's multi-wallet portfolio tracking (see
// CoreTierPortfolio.jsx / backend/utils/premiumAccess.js's hasCoreAccess) — but ONLY annual
// membership additionally grants the 50% PnL statement discount (see PnlStatementRequest.jsx) —
// see PremiumSubscription.sol's header comment for why a cheap monthly signup deliberately can't
// reach that discount.
//
// `onExpiryStatusChange`, if given, is called with computeExpiryStatus's own result (or null)
// every time it changes — PortfolioDashboardSection.jsx uses this to move this WHOLE panel back up
// to the top of the page (same spot a non-member sees it) once access is genuinely at risk of
// lapsing soon, not just to decide whether to show the alert below (which this component always
// renders itself, regardless of where its caller places it).
export default function MembershipPurchase({ wallet, onMembershipChange, onExpiryStatusChange }) {
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

  // Recomputed from scratch on every monthlyExpiry/annualExpiry change rather than stored in its
  // own state — it's a pure derivation of the two expiries already held above, nothing about it
  // needs independent state.
  const expiryStatus = computeExpiryStatus(monthlyExpiry, annualExpiry);
  useEffect(() => {
    onExpiryStatusChange?.(expiryStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiryStatus?.isEndingSoon, expiryStatus?.effectiveTier, expiryStatus?.daysRemaining]);

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
      // Tells CoreTierPortfolio (a sibling, not a parent/child of this component — see
      // PortfolioDashboardSection.jsx) that a subscribe just went through, so it re-checks Core
      // tier access instead of sitting on whatever it found on mount. This alone doesn't
      // guarantee access flips to true immediately: the backend's own membership record only
      // updates once premiumSubscriptionWatcher.js has polled and processed this tx's event
      // (up to ~a minute later, see that file's own POLL_INTERVAL_MS) — CoreTierPortfolio handles
      // that gap itself with a short bounded retry, not this component's job.
      onMembershipChange?.();
    } catch (err) {
      // subscribe()/subscribeAnnual() already record the error via the hook's own `error` state.
    }
  };

  const tabStyle = (active) => ({
    flex: 1,
    padding: "10px 0",
    borderRadius: 6,
    border: `1px solid ${active ? green : border}`,
    background: active ? "rgba(24,187,26,0.15)" : panel2,
    color: active ? green : mutedLight,
    fontFamily: monoFont,
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  });

  return (
    <DashboardPanel>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Crown size={18} color={green} />
        <div style={{ fontFamily: monoFont, fontSize: 12, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Premium Membership
        </div>
      </div>

      {/* Renewal warning — see computeExpiryStatus's own comment for exactly when this fires
          (7 days out for a monthly sub, 30 for annual, whichever tier is the one actually keeping
          access alive right now). PortfolioDashboardSection.jsx also moves this whole panel to the
          top of the page while this is showing — this banner is what makes that move make sense
          once the member gets there, not just a "why is this panel here" surprise. */}
      {expiryStatus?.isEndingSoon && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "10px 12px",
            borderRadius: 6,
            border: `1px solid ${orange}`,
            background: "rgba(232,145,30,0.12)",
            boxShadow: `0 0 10px ${orangeGlow}`,
            marginBottom: 16,
          }}
        >
          <TriangleAlert size={16} color={orange} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 12, color: "#fff", lineHeight: 1.5 }}>
            <b style={{ color: orange }}>
              {/* daysRemaining is always > 0 here — computeExpiryStatus only ever derives it from
                  a tier it already confirmed is still active (expiry > now). */}
              Your {expiryStatus.effectiveTier} membership expires in {Math.max(1, Math.ceil(expiryStatus.daysRemaining))} day{Math.ceil(expiryStatus.daysRemaining) === 1 ? "" : "s"}.
            </b>{" "}
            Renew now to keep your Argus Core Tier access — multi-wallet portfolio tracking, PnL, and everything else on this page.
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={() => setTier("annual")} style={tabStyle(isAnnual)}>Annual</button>
        <button onClick={() => setTier("monthly")} style={tabStyle(!isAnnual)}>Monthly</button>
      </div>

      {isAnnual ? (
        <div style={{ fontSize: 11, color: mutedLight, marginBottom: 12 }}>
          Unlocks Core Tier (multi-wallet portfolio tracking) and grants the 50% PnL statement
          discount. Monthly unlocks Core Tier too, just not the discount.
        </div>
      ) : (
        <div style={{ fontSize: 11, color: mutedLight, marginBottom: 12 }}>
          Unlocks Core Tier (multi-wallet portfolio tracking) — does not grant the PnL statement
          discount, no matter how many months you hold.
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
              borderRadius: 6,
              border: `1px solid ${numUnits === n ? green : border}`,
              background: numUnits === n ? "rgba(24,187,26,0.15)" : panel2,
              color: numUnits === n ? green : mutedLight,
              fontFamily: monoFont,
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
          {txHash && <div style={{ color: mutedLight, fontFamily: monoFont, fontSize: 11, marginTop: 2, wordBreak: "break-all" }}>{txHash}</div>}
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
