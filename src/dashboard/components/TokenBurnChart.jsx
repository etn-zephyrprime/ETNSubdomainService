import React, { useEffect, useMemo, useState } from "react";
import { green, mutedLight, muted, panel2, border, error as errorColor } from "../theme.js";
import { useTokenBurns } from "../hooks/useTokenBurns.js";
import { formatTokenAmount, formatChartDate, shortHash, timeAgo } from "../utils/format.js";
import { EXPLORER_BASE_URL } from "../config.js";
import SparklineChart from "./SparklineChart.jsx";

const RECENT_BURNS_SHOWN = 10;

// Cumulative "how much of this token has been burned" chart for TokenDetail.jsx's Tokens tab — see
// tokenBurnService.js's own header comment for the two different things "burned" means depending on
// the token, mirrored in the caption below: CORE has a real burn() function that reduces its own
// total supply; every other token has no such function at all, so a transfer to the conventional
// 0x000...dEaD address is a widely-used CONVENTION for "gone forever", not an actual supply
// reduction — shown just as honestly, without implying the token's own total supply changed.
export default function TokenBurnChart({ address, decimals, totalSupply }) {
  const { getTokenBurns } = useTokenBurns();
  const [data, setData] = useState(null); // { isCore, burnAddress, totalBurnedRaw, series, recentEvents, fullyBackfilled } | null while loading
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getTokenBurns(address)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => {
        console.error("Failed to load token burn history:", err);
        if (!cancelled) setError("Couldn't load burn history — try again shortly.");
      });
    return () => { cancelled = true; };
  }, [address, getTokenBurns]);

  const series = useMemo(
    () =>
      (data?.series || []).map((p) => ({
        label: p.date,
        value: parseFloat(formatTokenAmount(p.cumulativeRaw, decimals).replace(/,/g, "")),
      })),
    [data, decimals]
  );

  const percentOfSupply = useMemo(() => {
    if (!data?.totalBurnedRaw || !totalSupply) return null;
    try {
      const total = BigInt(totalSupply);
      if (total <= 0n) return null;
      const basisPoints = (BigInt(data.totalBurnedRaw) * 1000000n) / total; // 1e6 precision, same "raw BigInt basis points" precision reasoning as TokenDetail.jsx's own holderPercentage
      return Number(basisPoints) / 10000;
    } catch {
      return null;
    }
  }, [data, totalSupply]);

  if (error) {
    return <div style={{ fontSize: 12, color: errorColor, padding: 16, textAlign: "center" }}>{error}</div>;
  }

  return (
    <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 24 }}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 4 }}>
        Burn History <span style={{ fontWeight: 500, textTransform: "none", color: mutedLight }}>· on-chain</span>
      </div>
      <div style={{ fontSize: 11, color: mutedLight, marginBottom: 14, lineHeight: 1.6 }}>
        {data?.isCore
          ? "CORE has a real burn() function — every figure here actually reduced CORE's own total supply, whether triggered by this app's Buy Back & Burn or anything else."
          : "This token has no burn() function of its own — the amounts here were sent to the widely-used conventional \"dead\" address (0x000…dEaD), a permanent, verifiable removal from circulation, but not a reduction of the token's own total supply."}
      </div>

      {!data ? (
        <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted }}>
          Loading…
        </div>
      ) : Number(data.totalBurnedRaw) === 0 ? (
        <div style={{ fontSize: 12, color: muted, textAlign: "center", padding: "24px 0" }}>
          No burns recorded on-chain for this token{data.fullyBackfilled ? "" : " yet (history is still backfilling — check back later)"}.
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>Total Burned</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{formatTokenAmount(data.totalBurnedRaw, decimals)}</div>
            </div>
            {percentOfSupply != null && (
              <div>
                <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>% of Supply</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{percentOfSupply.toFixed(4)}%</div>
              </div>
            )}
            <div>
              <div style={{ fontSize: 10, color: muted, textTransform: "uppercase" }}>Burn Events</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{data.totalEvents.toLocaleString()}</div>
            </div>
          </div>

          {series.length >= 2 ? (
            <SparklineChart
              data={series}
              height={140}
              formatValue={(v) => v.toLocaleString(undefined, { maximumFractionDigits: 4 })}
              formatLabel={(l) => formatChartDate(l, true)}
            />
          ) : (
            <div style={{ height: 60, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: muted }}>
              Not enough burn history yet for a trend line.
            </div>
          )}

          {!data.fullyBackfilled && (
            <div style={{ fontSize: 10, color: muted, marginTop: 8, textAlign: "center" }}>
              Still backfilling this token's full history — the totals above reflect what's been scanned so far.
            </div>
          )}

          <div style={{ fontSize: 11, fontWeight: 700, color: mutedLight, margin: "18px 0 8px", textTransform: "uppercase", letterSpacing: 0.6 }}>
            Recent Burns
          </div>
          {data.recentEvents.slice(0, RECENT_BURNS_SHOWN).map((e) => (
            <a
              key={`${e.txHash}-${e.logIndex}`}
              href={`${EXPLORER_BASE_URL}/tx/${e.txHash}`}
              target="_blank"
              rel="noreferrer"
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${border}`, textDecoration: "none" }}
            >
              <div>
                <div style={{ fontSize: 12, color: "#fff", fontFamily: "monospace" }}>{shortHash(e.fromAddress)}</div>
                <div style={{ fontSize: 10, color: mutedLight }}>{timeAgo(new Date(e.timestampMs).toISOString())}</div>
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, color: green }}>{formatTokenAmount(e.amount, decimals)}</div>
            </a>
          ))}
        </>
      )}
    </div>
  );
}
