import React, { useEffect, useState } from "react";
import DashboardButton from "./DashboardButton.jsx";
import { useScenarios } from "../../hooks/useScenarios.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { error as errorColor } from "../../theme.js";
import { AUTH_PURPOSE, inputStyle, labelStyle, toggleStyle, tokenFmt, multFmt, signed, ResultCard, Hero, Kpi, KpiRow, AssumptionsStrip, WarningList, ProjectionCards, Intro, usdShort, toneFor } from "./ScenarioBits.jsx";

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
      <Intro>What a stake or farm could earn over a month, a quarter and a year — as a range, not a promise.</Intro>
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

const spotOf = (row) => (row ? (Number(row.reward?.spotUsd) || 0) + (Number(row.partner?.spotUsd) || 0) : null);

export function StakingResult({ r }) {
  const e = r.earlyExit;
  const year = r.projection.find((p) => p.days === 365);
  return (
    <ResultCard accent="#e8bf4c">
      <Hero
        label="Core Ascension · projected over 1 year"
        value={year ? usdShort(spotOf(year)) : "—"}
        sub={year ? `${tokenFmt(year.rewardTokens)} CORE · range ${usdShort(year.rangeUsd.low)}–${usdShort(year.rangeUsd.high)}` : undefined}
        tone="up"
      />
      <KpiRow>
        <Kpi label="Stake" value={`${tokenFmt(r.stake.core)} CORE`} sub={`${r.stake.nfts} NFT${r.stake.nfts === 1 ? "" : "s"} · ${multFmt(r.stake.boost)} boost`} tooltip="Your reward weight is CORE staked × your NFT boost." />
        <Kpi label="Share of rewards" value={year ? `${(year.share * 100).toFixed(2)}%` : "—"} />
        <Kpi
          label="Exit early"
          value={e.daysLeft != null && e.daysLeft > 0 ? `−${tokenFmt(e.penaltyCore)} CORE` : "No penalty"}
          sub={e.daysLeft != null && e.daysLeft > 0 ? `15% until ${e.daysLeft.toFixed(0)} more days pass` : "past the 60 days"}
          tone={e.daysLeft != null && e.daysLeft > 0 ? "warn" : "up"}
          tooltip="Withdrawing within 60 days of your last stake costs 15% of what you withdraw."
        />
      </KpiRow>
      <ProjectionCards rows={r.projection} showMultiplier={false} />
      <WarningList warnings={r.warnings} />
      <AssumptionsStrip assumptions={r.assumptions} facts={["Today's emission rate", "Funded schedule only", "Others' stake constant"]} />
    </ResultCard>
  );
}

export function FarmResult({ r }) {
  const il = r.impermanentLoss;
  const ilUsd = il?.lossUsd != null ? Number(il.lossUsd) : null;
  const year = r.projection.find((p) => p.days === 365);
  const yearSpot = spotOf(year);
  return (
    <ResultCard>
      <Hero
        label={`${r.label}${r.hypothetical ? " · if you deposit" : ""} · projected over 1 year`}
        value={yearSpot != null ? usdShort(yearSpot) : "—"}
        sub={year ? `${tokenFmt(year.rewardTokens)} ${year.rewardSymbol}${year.partnerTokens ? ` + ${tokenFmt(year.partnerTokens)} ${year.partnerSymbol}` : ""} · range ${usdShort(year.rangeUsd.low)}–${usdShort(year.rangeUsd.high)}` : undefined}
        tone="up"
      />
      <KpiRow>
        <Kpi label="Multiplier now" value={multFmt(r.multiplierNow)} sub={`BOLT ${multFmt(r.boltMultiplier)}`} />
        {year && <Kpi label="Multiplier in 1 year" value={multFmt(year.multiplierAt)} tone="up" />}
        {ilUsd != null && yearSpot != null && (
          <Kpi
            label="Rewards − IL"
            value={signed(yearSpot + ilUsd, usdShort)}
            sub={`IL today ${Number(il.percent).toFixed(2)}% (${usdShort(Math.abs(ilUsd))})`}
            tone={toneFor(yearSpot + ilUsd)}
            tooltip="A year's projected rewards against the impermanent loss the position already carries at today's prices. Rewards that look good can be smaller than the IL on the pair."
          />
        )}
      </KpiRow>
      <ProjectionCards rows={r.projection} />
      <WarningList warnings={r.warnings} />
      <AssumptionsStrip assumptions={r.assumptions} facts={["Today's emission rate", "Collected at period end", "Others' stake constant"]} />
    </ResultCard>
  );
}
