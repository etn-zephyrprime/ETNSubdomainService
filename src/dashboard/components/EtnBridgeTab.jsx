import React, { useEffect, useMemo, useState } from "react";
import { green, orange, blue, muted, mutedLight, panel2, border, monoFont } from "../theme.js";
import TokenLogo from "./TokenLogo.jsx";
import StatCard from "./StatCard.jsx";
import BridgeChart from "./BridgeChart.jsx";
import CornerBrackets from "./CornerBrackets.jsx";
import { useEtnBridge } from "../hooks/useEtnBridge.js";
import { formatCompact, formatInt, shortHash, timeAgo } from "../utils/format.js";
import { EXPLORER_BASE_URL } from "../config.js";
import { DEADLINE_DAY, DEADLINE_MS, bridgeTotal, buildRemainingSeries, computeForecast } from "../utils/bridgeSeries.js";

// backend/utils/etnBridge.js re-publishes hourly; this just needs to be frequent enough to pick it up.
const POLL_INTERVAL_MS = 60000;
const BRIDGE_ADDRESS = "0xB7990022d3F22B6FB3afb626E05289ee3bf0AE62";

const sectionLabel = { fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted };
const etn = (n) => `${Math.round(n).toLocaleString()} ETN`;

function TopMigrationRow({ m, rank }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "22px minmax(0,1fr) auto", gap: 10, alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${border}` }}>
      <div style={{ fontFamily: monoFont, fontSize: 12, fontWeight: 800, color: muted }}>#{rank}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, color: mutedLight, display: "flex", flexWrap: "wrap", gap: "2px 6px", alignItems: "center" }}>
          <span title={m.legacyAddress} style={{ fontFamily: monoFont }}>{shortHash(m.legacyAddress, 8)}</span>
          <span style={{ color: muted }}>→</span>
          <a href={`${EXPLORER_BASE_URL}/address/${m.to}`} target="_blank" rel="noreferrer" style={{ fontFamily: monoFont, color: blue, textDecoration: "none" }}>{shortHash(m.to)}</a>
        </div>
        <div style={{ fontSize: 10, color: muted, marginTop: 2 }}>
          <a href={`${EXPLORER_BASE_URL}/tx/${m.txHash}`} target="_blank" rel="noreferrer" style={{ color: muted }}>{timeAgo(m.timestamp)}</a>
        </div>
      </div>
      <div style={{ fontSize: 13, color: green, fontWeight: 800, textAlign: "right", whiteSpace: "nowrap" }}>
        <TokenLogo address="NATIVE" label="ETN" size={14} spacing={5} />{Math.round(m.etn).toLocaleString()} ETN
      </div>
    </div>
  );
}

// Free-tier tab for the ETNBridge — the contract that migrates legacy-chain ETN onto the Electroneum 2.0
// chain. The chart counts the ETN still sitting in the bridge down towards 0 at the migration deadline.
// Backed entirely by backend/utils/etnBridge.js's R2-published data (useEtnBridge.js); nothing here talks to
// the chain directly.
export default function EtnBridgeTab() {
  const { getEtnBridge } = useEtnBridge();
  const [data, setData] = useState(undefined); // undefined = loading, null = failed

  useEffect(() => {
    let cancelled = false;
    const refresh = () => getEtnBridge().then((res) => { if (!cancelled) setData(res); });
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [getEtnBridge]);

  const total = useMemo(() => bridgeTotal(data?.current), [data]);
  const series = useMemo(() => buildRemainingSeries(data?.points, total), [data, total]);
  const nowMs = useMemo(() => (data?.current?.asOf ? Date.parse(data.current.asOf) : series[series.length - 1]?.t), [data, series]);
  const forecast = useMemo(() => computeForecast({ series, nowMs }), [series, nowMs]);

  const cur = data?.current;
  const top = data?.top7d;
  const deadlineDate = new Date(DEADLINE_MS).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const daysLeft = Math.max(0, Math.ceil((DEADLINE_MS - Date.now()) / 86400000));
  const backfilling = data && !data.backfill && series.length < 30;

  return (
    <div>
      <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16, lineHeight: 1.5 }}>
        The{" "}
        <a href={`${EXPLORER_BASE_URL}/address/${BRIDGE_ADDRESS}`} target="_blank" rel="noreferrer" style={{ color: blue }}>ETNBridge</a>{" "}
        holds the legacy-chain ETN that hasn't yet migrated to the Electroneum 2.0 EVM chain. Every migration pays ETN out of the bridge, so the
        balance can only fall — the goal is for it to reach 0 by the migration deadline, {deadlineDate}.
      </div>

      {data === null && <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>Couldn't load bridge data — try again shortly.</div>}
      {data === undefined && <div style={{ fontSize: 12, color: muted, marginBottom: 16 }}>Loading…</div>}
      {data && !cur && <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>No bridge data has been published yet — check back shortly.</div>}

      {cur && total && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12, marginBottom: 16 }}>
            <StatCard
              label="Remaining in Bridge"
              value={<><TokenLogo address="NATIVE" label="ETN" size={22} spacing={8} />{formatCompact(cur.balanceEtn)} ETN</>}
              sub={`${etn(cur.balanceEtn)} · ${((cur.balanceEtn / total) * 100).toFixed(1)}% of the total`}
            />
            <StatCard
              label="Migrated"
              value={<><TokenLogo address="NATIVE" label="ETN" size={22} spacing={8} />{formatCompact(cur.migratedEtn)} ETN</>}
              sub={`${((cur.migratedEtn / total) * 100).toFixed(1)}% of ${formatCompact(total)} ETN · ${formatInt(cur.count)} migrations`}
            />
            <StatCard
              label="Time Left"
              value={`${daysLeft.toLocaleString()} days`}
              sub={`Deadline ${DEADLINE_DAY}`}
            />
          </div>

          <div style={{ position: "relative", padding: 16, borderRadius: 4, background: panel2, border: `1px solid ${border}`, marginBottom: 16 }}>
            <CornerBrackets color={green} />
            <div style={{ ...sectionLabel, marginBottom: 14 }}>
              <TokenLogo address="NATIVE" label="ETN" size={16} spacing={7} />ETN Remaining in the Bridge — Towards the Deadline
            </div>
            {series.length < 2 ? (
              <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted, textAlign: "center" }}>
                {backfilling ? "History is still being backfilled — check back in a few minutes." : "Not enough history yet."}
              </div>
            ) : (
              <BridgeChart series={series} total={total} forecast={forecast} nowMs={nowMs} />
            )}
            {backfilling && series.length >= 2 && (
              <div style={{ fontSize: 11, color: muted, marginTop: 10 }}>History is still being backfilled — earlier data will appear shortly.</div>
            )}
          </div>

          {forecast && forecast.pacePerDay !== null && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12, marginBottom: 16 }}>
              <StatCard
                label="Current Pace"
                value={<span style={{ color: orange }}>{formatCompact(forecast.pacePerDay)} ETN/day</span>}
                sub="Average over the last 30 days"
              />
              <StatCard
                label="Pace Needed"
                value={<span style={{ color: blue }}>{formatCompact(forecast.requiredPerDay)} ETN/day</span>}
                sub={forecast.pacePerDay > 0 ? `${(forecast.requiredPerDay / forecast.pacePerDay).toFixed(0)}× the current pace to reach 0 by the deadline` : "To reach 0 by the deadline"}
              />
              <StatCard
                label="Forecast at Deadline"
                value={forecast.projectedAtDeadline === 0 ? "Fully migrated" : `${formatCompact(forecast.projectedAtDeadline)} ETN`}
                sub={forecast.projectedAtDeadline === 0 ? "At the current pace" : `still in the bridge (${((forecast.projectedAtDeadline / total) * 100).toFixed(1)}%) at the current pace`}
              />
            </div>
          )}
          {forecast && forecast.pacePerDay !== null && (
            <div style={{ fontSize: 11, color: muted, marginBottom: 24, lineHeight: 1.5 }}>
              The forecast is a straight-line projection of the last 30 days' average pace — a rough guide, not a prediction. Migration activity often
              picks up as a deadline approaches.
            </div>
          )}
        </>
      )}

      {data && cur && (
        <div style={{ position: "relative", padding: 16, borderRadius: 4, background: panel2, border: `1px solid ${border}`, marginBottom: 16 }}>
          <CornerBrackets color={green} />
          <div style={{ ...sectionLabel, marginBottom: 4 }}>Top Migrations — Last 7 Days</div>
          {top ? (
            <>
              <div style={{ fontSize: 11, color: mutedLight, marginBottom: 6 }}>
                {top.count === 0 ? "No migrations in the last 7 days." : `Largest of ${formatInt(top.count)} migration${top.count === 1 ? "" : "s"} · ${etn(top.totalEtn)} in total over the rolling week`}
              </div>
              {top.top.map((m, i) => <TopMigrationRow key={m.txHash} m={m} rank={i + 1} />)}
            </>
          ) : (
            <div style={{ fontSize: 12, color: muted, padding: "12px 0" }}>Not available yet.</div>
          )}
        </div>
      )}

      {data?.updatedAt && <div style={{ fontSize: 10, color: muted }}>Updated {timeAgo(data.updatedAt)}</div>}
    </div>
  );
}
