import React, { useState, useEffect, useCallback } from "react";
import { Flame } from "lucide-react";
import Panel from "./Panel.jsx";
import { useBurnPool } from "../hooks/useBurnPool.js";
import { formatEth } from "../utils/format.js";
import { green, greenGlow, mutedLight, error as errorColor } from "../styles/theme.js";

// Same 30s re-poll cadence as BurnPoolCard — this only ever goes up (each buyBackAndBurn adds to
// it), but someone else triggering one while this card is on screen should still show up without
// a refresh.
const POLL_INTERVAL_MS = 30000;

// Lifetime CORE burned via this app's own Marketplace contract specifically — not a network-wide
// CORE burn statistic, just what ETN Subdomain Service (ENS) itself has bought back and burned.
export default function CoreBurnedCard() {
  const { getTotalCoreBurned } = useBurnPool();

  const [totalBurned, setTotalBurned] = useState(null);
  const [burnedError, setBurnedError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const value = await getTotalCoreBurned();
      setTotalBurned(value);
      setBurnedError(null);
    } catch (err) {
      console.error("Failed to load total CORE burned:", err);
      setBurnedError("Couldn't load total CORE burned");
    }
  }, [getTotalCoreBurned]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <Panel style={{ width: "100%", maxWidth: 600, margin: "16px auto 0", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Flame size={18} color={green} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Total CORE Burned
        </div>
      </div>

      {burnedError ? (
        <div style={{ fontSize: 12, color: errorColor }}>{burnedError}</div>
      ) : (
        <div style={{ fontSize: 26, fontWeight: 900, color: green, textShadow: `0 0 12px ${greenGlow}` }}>
          {totalBurned === null ? "Loading…" : `${formatEth(totalBurned)} CORE`}
        </div>
      )}
      <div style={{ fontSize: 11, color: mutedLight, marginTop: 6 }}>
        Lifetime total bought back and burned from ETN Subdomain Service (ENS) marketplace sales.
      </div>
    </Panel>
  );
}
