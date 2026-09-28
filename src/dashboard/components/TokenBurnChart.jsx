import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { green, mutedLight, muted, panel2, border, monoFont, error as errorColor } from "../theme.js";
import { useTokenBurns } from "../hooks/useTokenBurns.js";
import { useDisplayNames } from "../hooks/useDisplayNames.js";
import { formatTokenAmount, formatChartDate, timeAgo } from "../utils/format.js";
import { isTeamWallet } from "../utils/teamWallets.js";
import { EXPLORER_BASE_URL } from "../config.js";
import SparklineChart from "./SparklineChart.jsx";
import TeamWalletTag from "./TeamWalletTag.jsx";

const RECENT_BURNS_SHOWN = 10;
const TOP_BURNERS_PAGE_SIZE = 5;
const MAX_TOP_BURNERS_SHOWN = 20; // matches tokenBurnService.js's own MAX_TOP_BURNERS cap

// CORE's total STARTING supply — same value, same reasoning, as src/components/CoreBurnedCard.jsx's
// own identical constant: not something CORE's contract exposes (there's no "initial supply" view,
// only the current, shrinking totalSupply()), so this is a fixed number rather than a read. "% of
// supply" for CORE is deliberately measured against this fixed figure, not the live token.total_supply
// prop every other token here uses — CORE's own totalSupply() falls every time burn() runs, so
// dividing by it would be a moving, ever-smaller denominator instead of "how much of what CORE
// originally had is now gone."
const CORE_STARTING_SUPPLY = 1_000_000;

// Cumulative "how much of this token has been burned" chart for TokenDetail.jsx's Tokens tab — see
// tokenBurnService.js's own header comment for the two different things "burned" means depending on
// the token, mirrored in the caption below: CORE has a real burn() function that reduces its own
// total supply; every other token has no such function at all, so a transfer to the conventional
// 0x000...dEaD address is a widely-used CONVENTION for "gone forever", not an actual supply
// reduction — shown just as honestly, without implying the token's own total supply changed.
export default function TokenBurnChart({ address, decimals, totalSupply }) {
  const { getTokenBurns } = useTokenBurns();
  const [data, setData] = useState(null); // { isCore, burnAddresses, totalBurnedRaw, series, recentEvents, fullyBackfilled, refreshing } | null while loading
  const [error, setError] = useState(null);
  const [showAllBurners, setShowAllBurners] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    setData(null);
    setError(null);
    setShowAllBurners(false);

    function load() {
      getTokenBurns(address)
        .then((res) => {
          if (cancelled) return;
          setData(res);
          setError(null);
          // The scan now runs in the background (see tokenBurnService.js) rather than blocking this
          // request — `refreshing: true` means it hasn't finished yet, so poll again shortly for the
          // events it's about to add, same "keep showing what's there, refresh behind it" shape as
          // the Core Tier panels' own stale-while-revalidate polling.
          if (res.refreshing) timer = setTimeout(load, 4000);
        })
        .catch((err) => {
          console.error("Failed to load token burn history:", err);
          if (!cancelled) setError("Couldn't load burn history — try again shortly.");
        });
    }
    load();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [address, getTokenBurns]);

  const series = useMemo(
    () =>
      (data?.series || []).map((p) => ({
        label: p.date,
        value: parseFloat(formatTokenAmount(p.cumulativeRaw, decimals).replace(/,/g, "")),
      })),
    [data, decimals]
  );

  // ENS/primary names for every address either list below shows — same page-wide cached resolver
  // used elsewhere on this dashboard (Team Wallets, Balance History), so an address already
  // resolved there (or by an earlier token's burn lists) doesn't pay for a second lookup.
  const burnerAddresses = useMemo(
    () => [...(data?.topBurners || []).map((b) => b.address), ...(data?.recentEvents || []).map((e) => e.fromAddress)],
    [data]
  );
  const { resolve: resolveName } = useDisplayNames(burnerAddresses);

  const percentOfSupply = useMemo(() => {
    if (!data?.totalBurnedRaw) return null;
    try {
      if (data.isCore) {
        // Against the fixed STARTING supply, not the current (shrinking) one — see
        // CORE_STARTING_SUPPLY's own comment. Same float-division precision tradeoff
        // CoreBurnedCard.jsx's own identical calculation already accepts.
        const burnedTokens = parseFloat(ethers.formatUnits(data.totalBurnedRaw, decimals));
        if (!Number.isFinite(burnedTokens)) return null;
        return (burnedTokens / CORE_STARTING_SUPPLY) * 100;
      }
      if (!totalSupply) return null;
      const total = BigInt(totalSupply);
      if (total <= 0n) return null;
      const basisPoints = (BigInt(data.totalBurnedRaw) * 1000000n) / total; // 1e6 precision, same "raw BigInt basis points" precision reasoning as TokenDetail.jsx's own holderPercentage
      return Number(basisPoints) / 10000;
    } catch {
      return null;
    }
  }, [data, totalSupply, decimals]);

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
          ? `CORE has a real burn() function — every figure here combines that (Transfers to the true zero address) with CORE also sent directly to the conventional "dead" address, both real, permanent removals from circulation. % of Supply is measured against CORE's fixed starting supply of ${CORE_STARTING_SUPPLY.toLocaleString()}, not its current (shrinking) total supply.`
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

          {data.topBurners && data.topBurners.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: mutedLight, margin: "18px 0 8px", textTransform: "uppercase", letterSpacing: 0.6 }}>
                Top Burners
              </div>
              <div style={{ display: "flex", padding: "0 0 6px", fontFamily: monoFont, fontSize: 10, fontWeight: 700, color: muted, textTransform: "uppercase", letterSpacing: 1 }}>
                <div style={{ width: 24 }}>#</div>
                <div style={{ flex: 1 }}>Address</div>
                <div style={{ textAlign: "right" }}>Burned</div>
              </div>
              {data.topBurners.slice(0, showAllBurners ? MAX_TOP_BURNERS_SHOWN : TOP_BURNERS_PAGE_SIZE).map((b, i) => (
                <a
                  key={b.address}
                  href={`${EXPLORER_BASE_URL}/address/${b.address}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: "flex", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${border}`, textDecoration: "none" }}
                >
                  <div style={{ width: 24, fontSize: 11, color: muted, fontWeight: 700 }}>{i + 1}</div>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 12, color: "#fff", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{resolveName(b.address)}</span>
                    {isTeamWallet(b.address) && <TeamWalletTag style={{ fontSize: 8 }} />}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: green }}>{formatTokenAmount(b.totalRaw, decimals)}</div>
                    <div style={{ fontSize: 10, color: mutedLight }}>{b.eventCount} burn{b.eventCount === 1 ? "" : "s"}</div>
                  </div>
                </a>
              ))}
              {!showAllBurners && data.topBurners.length > TOP_BURNERS_PAGE_SIZE && (
                <div style={{ textAlign: "center", marginTop: 10 }}>
                  <button
                    onClick={() => setShowAllBurners(true)}
                    style={{ background: "transparent", border: `1px solid ${border}`, borderRadius: 6, color: mutedLight, fontFamily: monoFont, textTransform: "uppercase", letterSpacing: 0.6, fontSize: 11, fontWeight: 700, padding: "6px 14px", cursor: "pointer" }}
                  >
                    Show {Math.min(TOP_BURNERS_PAGE_SIZE, data.topBurners.length - TOP_BURNERS_PAGE_SIZE)} more
                  </button>
                </div>
              )}
            </>
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
                <div style={{ fontSize: 12, color: "#fff", fontFamily: "monospace" }}>{resolveName(e.fromAddress)}</div>
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
