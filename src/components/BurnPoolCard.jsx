import React, { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { Flame } from "lucide-react";
import Panel from "./Panel.jsx";
import NeonButton from "./NeonButton.jsx";
import UsdEstimate from "./UsdEstimate.jsx";
import { useBurnPool } from "../hooks/useBurnPool.js";
import { formatEth } from "../utils/format.js";
import { MARKETPLACE_OWNER_ADDRESS } from "../config.js";
import { green, greenGlow, muted, mutedLight, border, error as errorColor } from "../styles/theme.js";

// Re-polls the on-chain burn pool balances periodically so the card doesn't go stale while it's
// sitting on screen — e.g. after someone else's marketplace sale tops one up, or after this
// admin's own burn drains it.
const POLL_INTERVAL_MS = 30000;

function formatPoolAmount(amount, decimals) {
  return parseFloat(ethers.formatUnits(amount, decimals)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function BurnPoolCard({ wallet }) {
  const { getAllBurnPools, buyBackAndBurn, buyBackAndBurnToken, loading: burnLoading } = useBurnPool();

  // Array of { symbol, address, decimals, amount } — one entry per currency (ETN first, then
  // every candidate payment token), null while the first load is in flight. See getAllBurnPools's
  // own comment on why this includes a de-whitelisted token's pool too, not just currently-
  // whitelisted ones.
  const [pools, setPools] = useState(null);
  const [poolError, setPoolError] = useState(null);
  const [minCoreOut, setMinCoreOut] = useState("0");

  // Which single currency (by symbol) is mid-burn right now — null when idle. Used to disable
  // every OTHER burn button while one is in flight, since they all share the same wallet/nonce
  // and running two at once would just have the wallet queue (or reject) the second anyway.
  const [burningSymbol, setBurningSymbol] = useState(null);
  // One entry per currency actually attempted this session (single burn or as part of Burn All),
  // most-recent first — { symbol, status: "success" | "error", txHash, message }. Kept across
  // refreshes so a completed burn's result stays visible even after the pool list re-polls to 0.
  const [burnLog, setBurnLog] = useState([]);

  const isAdmin =
    !!wallet?.account &&
    wallet.account.toLowerCase() === MARKETPLACE_OWNER_ADDRESS.toLowerCase();

  const refreshPools = useCallback(async () => {
    try {
      const value = await getAllBurnPools();
      setPools(value);
      setPoolError(null);
    } catch (err) {
      console.error("Failed to load burn pools:", err);
      setPoolError("Couldn't load burn pool balances");
    }
  }, [getAllBurnPools]);

  useEffect(() => {
    refreshPools();
    const id = setInterval(refreshPools, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refreshPools]);

  const etnPool = pools?.find((p) => p.address === ethers.ZeroAddress) ?? null;
  const otherPools = (pools ?? []).filter((p) => p.address !== ethers.ZeroAddress && p.amount > 0n);
  const nonZeroPools = (pools ?? []).filter((p) => p.amount > 0n);

  const logResult = (symbol, entry) => {
    setBurnLog((prev) => [{ symbol, ...entry }, ...prev].slice(0, 20));
  };

  const parsedMinCoreOut = useCallback(() => {
    try {
      return ethers.parseUnits(minCoreOut || "0", 18);
    } catch {
      return 0n;
    }
  }, [minCoreOut]);

  // Burns exactly one currency's pool — `pool` is one of `pools`'s own entries (ETN's has
  // address === ethers.ZeroAddress). Shared by each row's own "Burn" button and burnAll below, so
  // both go through the exact same sequencing/logging.
  const burnOne = async (pool, signer) => {
    setBurningSymbol(pool.symbol);
    try {
      const minCoreOutWei = parsedMinCoreOut();
      const result =
        pool.address === ethers.ZeroAddress
          ? await buyBackAndBurn(minCoreOutWei, signer)
          : await buyBackAndBurnToken(pool.address, minCoreOutWei, signer);
      logResult(pool.symbol, { status: "success", txHash: result.txHash });
      return true;
    } catch (err) {
      console.error(`Buy back and burn (${pool.symbol}) failed:`, err);
      logResult(pool.symbol, { status: "error", message: err?.reason || err?.message || "Burn failed" });
      return false;
    } finally {
      setBurningSymbol(null);
    }
  };

  const handleBurnOne = async (pool) => {
    await wallet.ensureCorrectNetwork();
    const signer = await wallet.getSigner();
    await burnOne(pool, signer);
    await refreshPools();
  };

  // Batches every currently non-zero pool into one sequence of separate transactions — the
  // contract has no single call that drains every token's pool at once (each needs its own swap
  // path; see buyBackAndBurnToken's own comment), so "batch" here means "one admin click instead
  // of N", not one atomic on-chain call. Keeps going even if one currency's burn fails (a bad
  // slippage/quote on one token shouldn't block burning the rest) — burnLog shows each outcome
  // individually. Network is checked once up front rather than per-currency since a wallet
  // doesn't change chains mid-sequence on its own.
  const handleBurnAll = async () => {
    await wallet.ensureCorrectNetwork();
    const signer = await wallet.getSigner();
    // Snapshot the list at the moment the batch starts — refreshPools() below would otherwise
    // shrink `nonZeroPools` out from under an in-progress loop as each burn drains its own pool.
    const targets = nonZeroPools;
    for (const pool of targets) {
      await burnOne(pool, signer);
    }
    await refreshPools();
  };

  return (
    <Panel style={{ width: "100%", maxWidth: 600, margin: "40px auto 0", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Flame size={18} color={green} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Burn Pool
        </div>
      </div>

      {poolError ? (
        <div style={{ fontSize: 12, color: errorColor }}>{poolError}</div>
      ) : (
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <div style={{ fontSize: 26, fontWeight: 900, color: green, textShadow: `0 0 12px ${greenGlow}` }}>
            {etnPool === null ? "Loading…" : `${formatEth(etnPool.amount)} ETN`}
          </div>
          {etnPool !== null && <UsdEstimate etn={formatEth(etnPool.amount)} />}
        </div>
      )}
      <div style={{ fontSize: 11, color: mutedLight, marginTop: 6 }}>
        Accumulated from marketplace sales, awaiting a buy back &amp; burn into CORE.
      </div>

      {/* Other currencies' pools — only shown once loaded and at least one is actually non-zero,
          since most of the 9 candidate tokens will genuinely have nothing pending most of the
          time and an always-visible wall of "0.00" rows would just be noise. */}
      {otherPools.length > 0 && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
          {otherPools.map((pool) => (
            <div key={pool.address} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>
                {formatPoolAmount(pool.amount, pool.decimals)} {pool.symbol}
              </div>
              <UsdEstimate etn={ethers.formatUnits(pool.amount, pool.decimals)} tokenAddress={pool.address} style={{ fontSize: 11 }} />
            </div>
          ))}
        </div>
      )}

      {isAdmin && (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 10 }}>
            Admin
          </div>

          <label style={{ fontSize: 11, color: mutedLight, display: "block", marginBottom: 6 }}>
            Minimum CORE out per burn (slippage protection — 0 accepts any amount; applies to every currency below)
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
              border: `1px solid rgba(62,166,255,0.2)`,
              background: "rgba(255,255,255,0.05)",
              backdropFilter: "blur(14px)",
              WebkitBackdropFilter: "blur(14px)",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              boxSizing: "border-box",
              outline: "none",
              marginBottom: 12,
            }}
          />

          <NeonButton
            variant="orange"
            onClick={() => etnPool && handleBurnOne(etnPool)}
            disabled={burnLoading || !etnPool || etnPool.amount === 0n}
            loading={burningSymbol === "ETN"}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {burningSymbol === "ETN" ? "Burning..." : "Buy Back & Burn ETN"}
          </NeonButton>

          {/* One row per other currency with something actually pending — each burns
              independently via its own button, same buyBackAndBurnToken call Burn All below
              triggers in sequence. */}
          {otherPools.length > 0 && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              {otherPools.map((pool) => (
                <div key={pool.address} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ fontSize: 12, color: mutedLight }}>
                    {formatPoolAmount(pool.amount, pool.decimals)} {pool.symbol}
                  </div>
                  <NeonButton
                    variant="orange"
                    onClick={() => handleBurnOne(pool)}
                    disabled={burnLoading || burningSymbol !== null}
                    loading={burningSymbol === pool.symbol}
                    style={{ padding: "6px 14px", fontSize: 12 }}
                  >
                    {burningSymbol === pool.symbol ? "Burning..." : "Burn"}
                  </NeonButton>
                </div>
              ))}
            </div>
          )}

          {/* Only worth offering once there's more than one currency's pool actually pending —
              with just one (or zero), it's identical to that currency's own single button above. */}
          {nonZeroPools.length > 1 && (
            <NeonButton
              variant="green"
              onClick={handleBurnAll}
              disabled={burnLoading || burningSymbol !== null}
              loading={burningSymbol !== null}
              style={{ width: "100%", justifyContent: "center", marginTop: 12 }}
            >
              {burningSymbol !== null ? `Burning ${burningSymbol}...` : `Burn All (${nonZeroPools.length} currencies)`}
            </NeonButton>
          )}

          {burnLog.length > 0 && (
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto" }}>
              {burnLog.map((entry, i) => (
                <div key={i} style={{ fontSize: 11, color: entry.status === "success" ? green : errorColor }}>
                  {entry.status === "success" ? (
                    <>✓ {entry.symbol} burned — <span style={{ color: mutedLight, wordBreak: "break-all" }}>{entry.txHash}</span></>
                  ) : (
                    <>✗ {entry.symbol} failed — {entry.message}</>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
