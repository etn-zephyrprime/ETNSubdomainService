import React, { useEffect, useState } from "react";
import DashboardButton from "./DashboardButton.jsx";
import { useScenarios } from "../../hooks/useScenarios.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { formatUsdPrice } from "../../utils/format.js";
import { muted, mutedLight, orange, border, error as errorColor } from "../../theme.js";
import { AUTH_PURPOSE, inputStyle, labelStyle, toggleStyle, Stat, Warnings, Assumptions, ProjectionTable, tokenFmt, multFmt, colorOf, signed } from "./ScenarioBits.jsx";

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
      <div style={{ fontSize: 12, color: mutedLight, lineHeight: 1.6 }}>
        What adding to a yield-farm position, or leaving it now, would do to your duration multiplier and rewards — worked out from the farm contract's own rules.
      </div>
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

function PositionLine({ r }) {
  const il = r.position.impermanentLoss?.percent != null ? Number(r.position.impermanentLoss.percent) : null;
  return (
    <div style={{ fontSize: 12, color: mutedLight }}>
      <span style={{ color: "#fff", fontWeight: 700 }}>{r.farm.name}</span>
      {r.position.valueUsd != null && <> · position {formatUsdPrice(Number(r.position.valueUsd))}</>} · duration {multFmt(r.position.multiplier)} · BOLT {multFmt(r.position.boltMultiplier)}
      {il != null && <> · impermanent loss {il.toFixed(2)}%</>}
      {!r.farm.active && <span style={{ color: orange }}> · farm inactive (no rewards)</span>}
    </div>
  );
}

function AddResult({ r }) {
  const a = r.add;
  const sym = r.pending.rewardSymbol;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 12, borderTop: `1px solid ${border}` }}>
      <PositionLine r={r} />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Stat label="Duration multiplier" tooltip="The farm dilutes your time served by your old share of the new position (contract rule), so a top-up lowers the multiplier for the WHOLE position, not just the new part.">
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{multFmt(r.position.multiplier)} → {multFmt(a.multiplierAfter)}</div>
          <div style={{ fontSize: 11, color: mutedLight }}>{a.recoverDays > 0.05 ? `back to ${multFmt(r.position.multiplier)} in ${a.recoverDays.toFixed(0)} days` : "no change"}</div>
        </Stat>
        <Stat label="Your share of the farm">
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{(a.shareBefore * 100).toFixed(2)}% → {(a.shareAfter * 100).toFixed(2)}%</div>
        </Stat>
        <Stat label={`${sym} per day`} tooltip="Today's rate at your share and multipliers, if you collected at today's multiplier.">
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{tokenFmt(a.rewardPerDayBefore)} → {tokenFmt(a.rewardPerDayAfter)}</div>
          <div style={{ fontSize: 11, color: colorOf(a.rewardPerDayAfter - a.rewardPerDayBefore) }}>{signed(a.rewardPerDayAfter - a.rewardPerDayBefore, tokenFmt)} {sym}/day</div>
        </Stat>
      </div>
      {a.pendingLostIfNotClaimed > 0.0001 && (
        <div style={{ fontSize: 12, color: orange, lineHeight: 1.6 }}>
          ⚠ Claim first: a top-up doesn't collect your {tokenFmt(r.pending.rewardTokens)} pending {sym}, so they'd be paid later at the lower multiplier — about {tokenFmt(a.pendingLostIfNotClaimed)} {sym} less
          {a.pendingLostEtn != null && <> (≈ {tokenFmt(a.pendingLostEtn)} ETN)</>}. A withdraw of 0 claims them without leaving the farm.
        </div>
      )}
      <div style={{ fontSize: 11, color: mutedLight }}>{r.costBasisNote}</div>
      <div style={{ fontSize: 11, color: muted, fontWeight: 700 }}>Projected rewards — now</div>
      <ProjectionTable rows={r.projectionBefore} />
      <div style={{ fontSize: 11, color: muted, fontWeight: 700 }}>Projected rewards — after adding {formatUsdPrice(a.usd)}</div>
      <ProjectionTable rows={r.projectionAfter} />
      <Assumptions assumptions={r.assumptions} />
    </div>
  );
}

function WithdrawResult({ r }) {
  const w = r.withdraw;
  const sym = r.pending.rewardSymbol;
  const m = w.nextMilestone;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 12, borderTop: `1px solid ${border}` }}>
      <PositionLine r={r} />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Stat label="Paid out on withdrawal" tooltip="Any withdrawal collects every pending reward, at your multiplier at that moment.">
          <div style={{ fontSize: 16, fontWeight: 800, color: "#fff" }}>{tokenFmt(w.paidNow.rewardTokens)} {sym}</div>
          <div style={{ fontSize: 11, color: mutedLight }}>
            {w.paidNow.value.spotUsd != null && `${formatUsdPrice(Number(w.paidNow.value.spotUsd))} at spot`}
            {w.paidNow.value.soldUsd != null && ` · ${formatUsdPrice(Number(w.paidNow.value.soldUsd))} if sold`}
          </div>
          {w.paidNow.partnerTokens > 0 && <div style={{ fontSize: 11, color: mutedLight }}>+ {tokenFmt(w.paidNow.partnerTokens)} {r.pending.partnerSymbol}</div>}
        </Stat>
        <Stat label="What you give up" tooltip="Your duration multiplier lives with the position: leave entirely and a new deposit starts again from 1.0x. A partial withdrawal keeps it for what stays.">
          <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>{w.full ? `${multFmt(w.multiplierLost)} multiplier` : "Nothing — a partial withdrawal keeps your multiplier"}</div>
          {w.full && w.boltReturned > 0 && <div style={{ fontSize: 11, color: mutedLight }}>{tokenFmt(w.boltReturned)} staked BOLT returned</div>}
          {!w.full && r.position.boltDeposited > 0 && <div style={{ fontSize: 11, color: orange }}>Staked BOLT only returns on a 100% withdrawal</div>}
        </Stat>
        <Stat label="Wait for the next milestone?" tooltip="Rewards keep accruing and are paid at the higher multiplier — everything else held constant (see the range).">
          {m ? (
            <>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>{multFmt(m.multiplier)} in {m.days.toFixed(0)} days</div>
              <div style={{ fontSize: 11, color: mutedLight }}>
                about {tokenFmt(w.waitGainTokens)} {sym} more{w.waitGain?.rangeUsd && ` (${formatUsdPrice(w.waitGain.rangeUsd.low)}–${formatUsdPrice(w.waitGain.rangeUsd.high)} in total)`}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>Already at the 2.5× maximum</div>
          )}
        </Stat>
      </div>
      <div style={{ fontSize: 11, color: mutedLight }}>
        {r.exposure} To see what the exit itself returns and its profit/loss, use <strong>Sell / exit → Exit a position</strong>.
      </div>
      <div style={{ fontSize: 11, color: muted, fontWeight: 700 }}>If you stay in — projected rewards (including the {tokenFmt(w.paidNow.rewardTokens)} {sym} already pending)</div>
      <ProjectionTable rows={r.projection} />
      <Warnings warnings={r.warnings} />
      <Assumptions assumptions={r.assumptions} />
    </div>
  );
}
