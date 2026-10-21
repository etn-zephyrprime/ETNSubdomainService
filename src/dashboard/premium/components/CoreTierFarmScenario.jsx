import React, { useEffect, useState } from "react";
import DashboardButton from "./DashboardButton.jsx";
import { useScenarios } from "../../hooks/useScenarios.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { muted, mutedLight, orange, error as errorColor } from "../../theme.js";
import { AUTH_PURPOSE, inputStyle, labelStyle, toggleStyle, tokenFmt, multFmt, signed, ResultCard, Hero, Kpi, KpiRow, Eyebrow, Callout, Details, AssumptionsStrip, WarningList, MultiplierGauge, ProjectionCards, Intro, usdShort, toneFor } from "./ScenarioBits.jsx";

/** Scenarios — Tool 2: ElectroSwap yield farm "add more" / "withdraw now"
 * (backend/services/scenarioRewards.js runFarmScenario). */
export default function CoreTierFarmScenario({ wallet, getAuthParams, active }) {
  const { runFarmScenario, getActiveFarms } = useScenarios();
  const { resolve: resolveWalletName } = useDisplayNames(active.map((w) => w.address));
  const [walletAddress, setWalletAddress] = useState(active[0]?.address || "");
  const [farms, setFarms] = useState(null);
  const [farmKey, setFarmKey] = useState("");
  const [action, setAction] = useState("add");
  const [addUsd, setAddUsd] = useState("500");
  const [withdrawPct, setWithdrawPct] = useState("100");
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    getActiveFarms()
      .then((r) => setFarms(r.farms || []))
      .catch(() => setFarms([]));
  }, [getActiveFarms]);

  const run = async () => {
    setError(null);
    if (!farmKey) return setError("Pick a farm");
    setRunning(true);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      setResult(await runFarmScenario(wallet.account, signature, timestamp, walletAddress, { farmKey, action, addUsd: Number(addUsd), withdrawPct: Number(withdrawPct) }));
    } catch (err) {
      setResult(null);
      setError(err.message || "Couldn't run the farm scenario");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Intro>What topping up a farm — or leaving it now — does to your multiplier and rewards.</Intro>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => { setAction("add"); setResult(null); }} style={toggleStyle(action === "add")}>Add more</button>
        <button type="button" onClick={() => { setAction("withdraw"); setResult(null); }} style={toggleStyle(action === "withdraw")}>Withdraw now</button>
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
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <label style={labelStyle}>Farm</label>
          <select value={farmKey} onChange={(e) => setFarmKey(e.target.value)} disabled={!farms} style={inputStyle}>
            <option value="">{farms ? "Choose a farm…" : "Loading…"}</option>
            {(farms || []).map((f) => (
              <option key={f.key} value={f.key}>{`${f.name} — earns ${f.rewards.join(" + ") || "nothing"}`}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: "1 1 160px", minWidth: 0 }}>
          {action === "add" ? (
            <>
              <label style={labelStyle}>Add (USD)</label>
              <input type="number" min="0" step="any" value={addUsd} onChange={(e) => setAddUsd(e.target.value)} style={inputStyle} />
            </>
          ) : (
            <>
              <label style={labelStyle}>Withdraw (%)</label>
              <input type="number" min="1" max="100" step="any" value={withdrawPct} onChange={(e) => setWithdrawPct(e.target.value)} style={inputStyle} />
            </>
          )}
        </div>
      </div>
      {error && <div style={{ fontSize: 12, color: errorColor }}>{error}</div>}
      <DashboardButton onClick={run} disabled={running || !farmKey} style={{ alignSelf: "flex-start", padding: "8px 16px", fontSize: 12 }}>
        {running ? "Running…" : "Run"}
      </DashboardButton>
      {result?.action === "add" && <AddResult r={result} />}
      {result?.action === "withdraw" && <WithdrawResult r={result} />}
    </div>
  );
}

function PositionHeader({ r }) {
  const il = r.position.impermanentLoss?.percent != null ? Number(r.position.impermanentLoss.percent) : null;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{r.farm.name}</div>
      <div style={{ fontSize: 11, color: mutedLight }}>
        {r.position.valueUsd != null && `${usdShort(Number(r.position.valueUsd))} · `}BOLT {multFmt(r.position.boltMultiplier)}
        {il != null && ` · IL ${il.toFixed(2)}%`}
        {!r.farm.active && <span style={{ color: orange }}> · inactive, no rewards</span>}
      </div>
    </div>
  );
}

export function AddResult({ r }) {
  const a = r.add;
  const sym = r.pending.rewardSymbol;
  const rateDelta = a.rewardPerDayAfter - a.rewardPerDayBefore;
  return (
    <ResultCard>
      <PositionHeader r={r} />
      <div>
        <Eyebrow>Duration multiplier · {multFmt(r.position.multiplier)} → {multFmt(a.multiplierAfter)}</Eyebrow>
        <MultiplierGauge value={r.position.multiplier} next={a.multiplierAfter} />
      </div>
      <KpiRow>
        <Kpi label="Back to today's level" value={a.recoverDays > 0.05 ? `${a.recoverDays.toFixed(0)} days` : "No change"} tooltip="A top-up dilutes your time served by your old share of the position (contract rule), so the multiplier drops for the WHOLE position." />
        <Kpi label="Your share" value={`${(a.shareAfter * 100).toFixed(2)}%`} sub={`from ${(a.shareBefore * 100).toFixed(2)}%`} />
        <Kpi label={`${sym} per day`} value={tokenFmt(a.rewardPerDayAfter)} sub={`${signed(rateDelta, tokenFmt)} vs ${tokenFmt(a.rewardPerDayBefore)}`} tone={toneFor(rateDelta)} />
      </KpiRow>
      {a.pendingLostIfNotClaimed > 0.0001 && (
        <Callout>
          <strong>Claim first.</strong> A top-up doesn't collect your {tokenFmt(r.pending.rewardTokens)} pending {sym} — they'd be paid later at the lower multiplier, about {tokenFmt(a.pendingLostIfNotClaimed)} {sym} less.
        </Callout>
      )}
      <div>
        <Eyebrow>Projected rewards after adding {usdShort(a.usd)}</Eyebrow>
        <ProjectionCards rows={r.projectionAfter} />
      </div>
      <Details label="Projected rewards without adding">
        <ProjectionCards rows={r.projectionBefore} />
      </Details>
      <AssumptionsStrip assumptions={r.assumptions} facts={["Today's emission rate", "Others' stake constant", "Cost basis carries over"]} />
    </ResultCard>
  );
}

export function WithdrawResult({ r }) {
  const w = r.withdraw;
  const sym = r.pending.rewardSymbol;
  const m = w.nextMilestone;
  const paid = w.paidNow.value;
  return (
    <ResultCard>
      <PositionHeader r={r} />
      <Hero
        label={`Paid out on withdrawal`}
        value={paid.spotUsd != null ? usdShort(Number(paid.spotUsd)) : `${tokenFmt(w.paidNow.rewardTokens)} ${sym}`}
        sub={`${tokenFmt(w.paidNow.rewardTokens)} ${sym}${w.paidNow.partnerTokens > 0 ? ` + ${tokenFmt(w.paidNow.partnerTokens)} ${r.pending.partnerSymbol}` : ""}${paid.soldUsd != null ? ` · ${usdShort(Number(paid.soldUsd))} if sold` : ""}`}
      />
      <div>
        <Eyebrow>Duration multiplier · {multFmt(r.position.multiplier)}</Eyebrow>
        <MultiplierGauge value={r.position.multiplier} />
      </div>
      <KpiRow>
        <Kpi label="You give up" value={w.full ? `${multFmt(w.multiplierLost)} multiplier` : "Nothing"} sub={w.full ? (w.boltReturned > 0 ? `${tokenFmt(w.boltReturned)} BOLT returned` : "a new deposit restarts at 1.0×") : "partial exits keep it"} tone={w.full ? "warn" : undefined} />
        <Kpi label="Next milestone" value={m ? `${multFmt(m.multiplier)} in ${m.days.toFixed(0)}d` : "At 2.5× max"} sub={m && w.waitGainTokens != null ? `+${tokenFmt(w.waitGainTokens)} ${sym} if you wait` : undefined} tone={m ? "up" : undefined} />
      </KpiRow>
      {!w.full && r.position.boltDeposited > 0 && <Callout>Your staked BOLT only comes back on a 100% withdrawal.</Callout>}
      <div>
        <Eyebrow>If you stay in · includes the {tokenFmt(w.paidNow.rewardTokens)} {sym} already pending</Eyebrow>
        <ProjectionCards rows={r.projection} />
      </div>
      <div style={{ fontSize: 11, color: muted }}>For what the exit returns and its profit/loss, use Sell / exit → Exit a position.</div>
      <WarningList warnings={r.warnings} />
      <AssumptionsStrip assumptions={r.assumptions} facts={["Today's emission rate", "Others' stake constant", "No withdrawal fee"]} />
    </ResultCard>
  );
}
