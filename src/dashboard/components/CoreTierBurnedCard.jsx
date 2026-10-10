import React, { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { Flame } from "lucide-react";
import DashboardPanel from "../premium/components/DashboardPanel.jsx";
import { usePremiumSubscription } from "../../hooks/usePremiumSubscription.js";
import { formatEtnBalance } from "../utils/format.js";
import { green, greenGlow, mutedLight, error as errorColor } from "../theme.js";

// Same 30s re-poll cadence as the ETN Subdomain Service site's own CoreBurnedCard.jsx — this only
// ever goes up (each executeSplitForPeriod adds to it), so a short poll is enough to catch a burn
// without a manual refresh.
const POLL_INTERVAL_MS = 30000;

// CORE's total starting supply — same fixed constant CoreBurnedCard.jsx uses, not something either
// contract exposes on-chain.
const CORE_TOTAL_SUPPLY = 1_000_000;

// Argus's OWN "Total CORE Burned" card — reads PremiumSubscription's own totalCoreBurned
// (usePremiumSubscription.js's own comment), lifetime CORE burned via Core Tier/PnL Statement
// subscription revenue's "Split & Burn" specifically. Deliberately NOT a reuse of
// src/components/CoreBurnedCard.jsx: that one reads MARKETPLACE_ADDRESS (ETN Subdomain Service's
// own domain marketplace sales) — confirmed live these are two separate contracts with two
// independent counters, not the same number under two labels. Argus briefly reused that component
// with just a reworded footer sentence, which was still factually wrong (right-sounding words,
// wrong underlying number) — this card exists specifically to show Argus's own correct figure.
export default function CoreTierBurnedCard() {
  const { getTotalCoreBurned } = usePremiumSubscription();

  const [totalBurned, setTotalBurned] = useState(null);
  const [burnedError, setBurnedError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const value = await getTotalCoreBurned();
      setTotalBurned(value);
      setBurnedError(null);
    } catch (err) {
      console.error("Failed to load Core Tier/PnL Statement total CORE burned:", err);
      setBurnedError("Couldn't load total CORE burned");
    }
  }, [getTotalCoreBurned]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Full-precision float, not a pre-rounded display string — burned-so-far is a tiny fraction of a
  // million-token supply, so a couple decimals would just read as "0.00%" for a long time.
  const percentBurned =
    totalBurned !== null ? (parseFloat(ethers.formatEther(totalBurned)) / CORE_TOTAL_SUPPLY) * 100 : null;

  return (
    <DashboardPanel style={{ width: "100%", maxWidth: 600, margin: "16px auto 0", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Flame size={18} color={green} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Total CORE Burned
        </div>
      </div>

      {burnedError ? (
        <div style={{ fontSize: 12, color: errorColor }}>{burnedError}</div>
      ) : (
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 26, fontWeight: 900, color: green, textShadow: `0 0 12px ${greenGlow}` }}>
            {totalBurned === null ? "Loading…" : `${formatEtnBalance(totalBurned)} CORE`}
          </div>
          {percentBurned !== null && (
            <div style={{ fontSize: 14, fontWeight: 700, color: mutedLight }}>
              ({percentBurned.toFixed(4)}% of supply)
            </div>
          )}
        </div>
      )}
      <div style={{ fontSize: 11, color: mutedLight, marginTop: 6 }}>
        Lifetime total bought back and burned from Core Tier and PnL Statement revenue —
        {" "}{CORE_TOTAL_SUPPLY.toLocaleString()} CORE total starting supply.
      </div>
    </DashboardPanel>
  );
}
