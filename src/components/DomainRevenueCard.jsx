import React from "react";
import { ethers } from "ethers";
import { Coins } from "lucide-react";
import Panel from "./Panel.jsx";
import { useNameServiceRevenue } from "../hooks/useNameServiceRevenue.js";
import { formatEth } from "../utils/format.js";
import { green, greenGlow, mutedLight, error as errorColor } from "../styles/theme.js";

// Lifetime total paid out to domain owners across every subname sale and resale via this app's
// Marketplace contract — the contract's own emitted sellerAmount (already the 80% cut; see
// SELLER_BPS in PlanetZephyrosSubdomainNameServiceV3.sol), summed by nameServiceStatsCache.js as a
// running total, not recomputed here. Same "lifetime total, own card" treatment as
// CoreBurnedCard.jsx right above this one on the homepage — the two together tell the same 80/20
// split story from both sides (seller payout vs. buyback/burn pool).
export default function DomainRevenueCard() {
  const { totalSellerRevenueWei, error } = useNameServiceRevenue();

  return (
    <Panel style={{ width: "100%", maxWidth: 600, margin: "16px auto 0", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Coins size={18} color={green} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Total Domain Revenue
        </div>
      </div>

      {error ? (
        <div style={{ fontSize: 12, color: errorColor }}>{error}</div>
      ) : (
        <div style={{ fontSize: 26, fontWeight: 900, color: green, textShadow: `0 0 12px ${greenGlow}` }}>
          {totalSellerRevenueWei === null ? "Loading…" : `${formatEth(ethers.getBigInt(totalSellerRevenueWei))} ETN`}
        </div>
      )}
      <div style={{ fontSize: 11, color: mutedLight, marginTop: 6 }}>
        Lifetime total paid directly to domain owners — 80% of every subname sale and resale made
        through ETN Subdomain Service (ENS).
      </div>
    </Panel>
  );
}
