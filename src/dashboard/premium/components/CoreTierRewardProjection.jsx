import React, { useEffect, useState } from "react";
import DashboardButton from "./DashboardButton.jsx";
import { useScenarios } from "../../hooks/useScenarios.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { formatUsdPrice } from "../../utils/format.js";
import { mutedLight, orange, border, error as errorColor } from "../../theme.js";
import { AUTH_PURPOSE, inputStyle, labelStyle, toggleStyle, Stat, Warnings, Assumptions, ProjectionTable, tokenFmt, multFmt, colorOf, signed } from "./ScenarioBits.jsx";

/** Scenarios — Tool 4: reward projections for ElectroSwap yield farms and Core Ascension staking
 * (backend/services/scenarioRewards.js runRewardProjection). A range, never a single promise. */
export default function CoreTierRewardProjection({ wallet, getAuthParams, active }) {
  const { runRewardProjection, getActiveFarms } = useScenarios();
  const { resolve: resolveWalletName } = useDisplayNames(active.map((w) => w.address));
  const [walletAddress, setWalletAddress] = useState(active[0]?.address || "");
  const [farms, setFarms] = useState([]);
  const [target, setTarget] = useState("staking");
  const [mode, setMode] = useState("current"); // "current" | "deposit"
  const [usd, setUsd] = useState("1000");
  const [core, setCore] = useState("500");
  const [nfts, setNfts] = useState("1");
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    getActiveFarms()
      .then((r) => setFarms(r.farms || []))
      .catch(() => setFarms([]));
  }, [getActiveFarms]);

  const isStaking = target === "staking";
  const run = async () => {
    setError(null);
    setRunning(true);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const deposit = mode === "current" ? null : isStaking ? { core: Number(core), nfts: Number(nfts) } : { usd: Number(usd) };
      setResult(await runRewardProjection(wallet.account, signature, timestamp, walletAddress, target, deposit));
    } catch (err) {
      setResult(null);
      setError(err.message || "Couldn't run the projection");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 12, color: mutedLight, lineHeight: 1.6 }}>
        What a stake or farm position could earn over the next month, quarter and year — from the contracts' live emission rates, your share and your multipliers. Shown as a range, because the result depends on how much everyone else stakes and what the reward token is worth.
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <label style={labelStyle}>Wallet</label>
          <select value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} style={inputStyle}>
            {active.map((w) => (
              <option key={w.address} value={w.address}>{resolveWalletName(w.address)}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <label style={labelStyle}>Earn from</label>
          <select value={target} onChange={(e) => { setTarget(e.target.value); setResult(null); }} style={inputStyle}>
            <option value="staking">Core Ascension staking — earns CORE</option>
            {farms.map((f) => (
              <option key={f.key} value={f.key}>{`${f.name} farm — earns ${f.rewards.join(" + ") || "nothing"}`}</option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <button type="button" onClick={() => setMode("current")} style={toggleStyle(mode === "current")}>My current position</button>
        <button type="button" onClick={() => setMode("deposit")} style={toggleStyle(mode === "deposit")}>{isStaking ? "If I stake…" : "If I deposit…"}</button>
        {mode === "deposit" && !isStaking && (
          <div style={{ width: 160 }}>
            <label style={labelStyle}>Deposit (USD)</label>
            <input type="number" min="0" step="any" value={usd} onChange={(e) => setUsd(e.target.value)} style={inputStyle} />
          </div>
        )}
        {mode === "deposit" && isStaking && (
          <>
            <div style={{ width: 140 }}>
              <label style={labelStyle}>Stake (CORE)</label>
              <input type="number" min="0" step="any" value={core} onChange={(e) => setCore(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ width: 120 }}>
              <label style={labelStyle}>NFTs staked</label>
              <select value={nfts} onChange={(e) => setNfts(e.target.value)} style={inputStyle}>
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>{`${n} (${[1.0, 1.1, 1.2, 1.3][n - 1].toFixed(1)}×)`}</option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>
      {error && <div style={{ fontSize: 12, color: errorColor }}>{error}</div>}
      <DashboardButton onClick={run} disabled={running} style={{ alignSelf: "flex-start", padding: "8px 16px", fontSize: 12 }}>
        {running ? "Running…" : "Project rewards"}
      </DashboardButton>
      {result && (result.target === "staking" ? <StakingResult r={result} /> : <FarmResult r={result} />)}
    </div>
  );
}

function StakingResult({ r }) {
  const e = r.earlyExit;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 12, borderTop: `1px solid ${border}` }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Stat label="Stake" tooltip="Your reward weight is CORE staked × your NFT boost.">
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{tokenFmt(r.stake.core)} CORE</div>
          <div style={{ fontSize: 11, color: mutedLight }}>{r.stake.nfts} NFT{r.stake.nfts === 1 ? "" : "s"} · {multFmt(r.stake.boost)} boost</div>
        </Stat>
        <Stat label="If you need out early" tooltip="Withdrawing within 60 days of your last stake costs 15% of what you withdraw.">
          {e.daysLeft != null && e.daysLeft > 0 ? (
            <>
              <div style={{ fontSize: 16, fontWeight: 800, color: orange }}>−{tokenFmt(e.penaltyCore)} CORE</div>
              <div style={{ fontSize: 11, color: mutedLight }}>15% penalty for {e.daysLeft.toFixed(0)} more days</div>
            </>
          ) : (
            <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>No penalty — past the 60 days</div>
          )}
        </Stat>
      </div>
      <ProjectionTable rows={r.projection} showMultiplier={false} />
      <Warnings warnings={r.warnings} />
      <Assumptions assumptions={r.assumptions} />
    </div>
  );
}

function FarmResult({ r }) {
  const il = r.impermanentLoss;
  const ilUsd = il?.lossUsd != null ? Number(il.lossUsd) : null;
  const yearRow = r.projection.find((p) => p.days === 365);
  const yearSpot = yearRow ? (Number(yearRow.reward?.spotUsd) || 0) + (Number(yearRow.partner?.spotUsd) || 0) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 12, borderTop: `1px solid ${border}` }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Stat label={r.hypothetical ? "Hypothetical position" : "Your position"}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>{r.label}</div>
          <div style={{ fontSize: 11, color: mutedLight }}>
            duration {multFmt(r.multiplierNow)} · BOLT {multFmt(r.boltMultiplier)}
            {r.farm.valueUsd != null && ` · whole farm ${formatUsdPrice(Number(r.farm.valueUsd))}`}
          </div>
        </Stat>
        {ilUsd != null && yearSpot != null && (
          <Stat label="Rewards vs impermanent loss" tooltip="A year's projected rewards (at spot) against the impermanent loss your position already carries at today's prices. Rewards that look good can be smaller than IL on the pair.">
            <div style={{ fontSize: 16, fontWeight: 800, color: colorOf(yearSpot + ilUsd) }}>{signed(yearSpot + ilUsd, formatUsdPrice)}</div>
            <div style={{ fontSize: 11, color: mutedLight }}>
              {formatUsdPrice(yearSpot)} rewards (1 yr) − {formatUsdPrice(Math.abs(ilUsd))} IL ({Number(il.percent).toFixed(2)}%)
            </div>
          </Stat>
        )}
      </div>
      <ProjectionTable rows={r.projection} />
      <Warnings warnings={r.warnings} />
      <Assumptions assumptions={r.assumptions} />
    </div>
  );
}
