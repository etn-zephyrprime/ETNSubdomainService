import React, { useEffect, useMemo, useState } from "react";
import { green, error as red, blue, muted, mutedLight, panel2, border } from "../theme.js";
import TokenLogo from "./TokenLogo.jsx";
import StatCard from "./StatCard.jsx";
import HyperlaneChart, { signedUsd } from "./HyperlaneChart.jsx";
import { useHyperlaneBridge } from "../hooks/useHyperlaneBridge.js";
import { formatInt, formatUsdCompact, timeAgo } from "../utils/format.js";
import { EXPLORER_BASE_URL } from "../config.js";
import { chainName, chainOptions, chainSummary, dailyFlows, netAllTime, totals } from "../utils/hyperlaneSeries.js";

// The published file refreshes every 10 minutes; this just needs to be frequent enough to pick that up.
const POLL_INTERVAL_MS = 60000;

const sectionLabel = { fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted };
const netColor = (v) => (v > 0 ? green : v < 0 ? red : "#fff");

function Pill({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 12px",
        borderRadius: 8,
        border: `1px solid ${active ? green : border}`,
        background: active ? "rgba(24,187,26,0.12)" : panel2,
        color: active ? green : mutedLight,
        fontSize: 12,
        fontWeight: 700,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function LegendSwatch({ color, label }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
      {label}
    </span>
  );
}

// Free-tier tab for USD stablecoin flows over Hyperlane: net USDT + USDC bridged into (+) or out of (−)
// Electroneum per day over a rolling 12 months, filterable by token and by the other chain. Backed entirely by
// backend/utils/hyperlaneBridge.js's R2-published events (useHyperlaneBridge.js) — nothing here talks to the
// chain directly.
export default function HyperlaneBridgeTab() {
  const { getHyperlaneBridge } = useHyperlaneBridge();
  const [data, setData] = useState(undefined); // undefined = loading, null = failed
  const [tokenFilter, setTokenFilter] = useState(null); // token symbol, null = all
  const [chainFilter, setChainFilter] = useState(null); // Hyperlane domain, null = all

  useEffect(() => {
    let cancelled = false;
    const refresh = () => getHyperlaneBridge().then((res) => { if (!cancelled) setData(res); });
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [getHyperlaneBridge]);

  const tokens = data?.tokens ?? [];
  const events = data?.events ?? [];
  const tokenIndex = tokenFilter === null ? null : tokens.findIndex((t) => t.symbol === tokenFilter);
  const selectedTokenIndex = tokenIndex === -1 ? null : tokenIndex;
  const nowMs = useMemo(() => Date.now(), [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const enrolled = useMemo(() => {
    const set = new Set();
    for (const t of tokens) {
      if (tokenFilter !== null && t.symbol !== tokenFilter) continue;
      for (const d of data?.current?.[t.symbol]?.domains ?? []) set.add(d);
    }
    return [...set];
  }, [data, tokens, tokenFilter]);

  const allChains = useMemo(() => {
    const set = new Set();
    for (const t of tokens) for (const d of data?.current?.[t.symbol]?.domains ?? []) set.add(d);
    return chainOptions(events, [...set]);
  }, [data, tokens, events]);

  // A chain that isn't active for the selected token still shows in the filter, just with no traffic.
  const rows = useMemo(
    () => (events.length || tokens.length ? dailyFlows(events, { tokenIndex: selectedTokenIndex, domain: chainFilter, nowMs }) : []),
    [events, tokens, selectedTokenIndex, chainFilter, nowMs]
  );
  const sum = useMemo(() => totals(rows), [rows]);
  const breakdown = useMemo(
    () => chainSummary(events, { tokenIndex: selectedTokenIndex, nowMs, enrolledDomains: enrolled }),
    [events, selectedTokenIndex, nowMs, enrolled]
  );
  const allTimeNet = useMemo(() => netAllTime(events, { tokenIndex: selectedTokenIndex, domain: chainFilter }), [events, selectedTokenIndex, chainFilter]);

  const scopeLabel = `${tokenFilter ?? "USDT + USDC"}${chainFilter === null ? "" : ` via ${chainName(chainFilter)}`}`;
  const hasData = data && events.length > 0;
  const chainNote = chainFilter === null ? "across all chains" : `via ${chainName(chainFilter)}`;

  return (
    <div>
      <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16, lineHeight: 1.5 }}>
        USDT and USDC on Electroneum are{" "}
        <a href="https://hyperlane.xyz" target="_blank" rel="noreferrer" style={{ color: blue }}>Hyperlane</a>{" "}
        warp-route tokens: bridging in mints them here, bridging out burns them. Every transfer records which chain it came from or went to, so
        this shows the net USD moving onto (+) or off (−) Electroneum each day, and which chain it moved through.
      </div>

      {data === null && <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>Couldn't load Hyperlane data — try again shortly.</div>}
      {data === undefined && <div style={{ fontSize: 12, color: muted, marginBottom: 16 }}>Loading…</div>}
      {data && !hasData && <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16 }}>No Hyperlane data has been published yet — check back shortly.</div>}

      {hasData && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 24px", marginBottom: 16 }}>
            <div>
              <div style={{ ...sectionLabel, marginBottom: 6 }}>Token</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <Pill active={tokenFilter === null} onClick={() => setTokenFilter(null)}>All USD</Pill>
                {tokens.map((t) => (
                  <Pill key={t.symbol} active={tokenFilter === t.symbol} onClick={() => setTokenFilter(t.symbol)}>
                    <TokenLogo address={t.address} label={t.symbol} size={14} spacing={5} />{t.symbol}
                  </Pill>
                ))}
              </div>
            </div>
            <div>
              <div style={{ ...sectionLabel, marginBottom: 6 }}>Chain</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <Pill active={chainFilter === null} onClick={() => setChainFilter(null)}>All chains</Pill>
                {allChains.map((c) => (
                  <Pill key={c.domain} active={chainFilter === c.domain} onClick={() => setChainFilter(c.domain)}>{c.name}</Pill>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginBottom: 16 }}>
            <StatCard
              label="Net Flow · 12 Months"
              value={<span style={{ color: netColor(sum.net) }}>{signedUsd(sum.net)}</span>}
              sub={`${sum.net >= 0 ? "More came in than left" : "More left than came in"} ${chainNote} · ${formatInt(sum.count)} transfers`}
            />
            <StatCard label="Inflow · 12 Months" value={<span style={{ color: green }}>{formatUsdCompact(sum.inflow)}</span>} sub="Bridged onto Electroneum" />
            <StatCard label="Outflow · 12 Months" value={<span style={{ color: red }}>{formatUsdCompact(sum.outflow)}</span>} sub="Bridged off Electroneum" />
            <StatCard
              label={chainFilter === null ? "Bridged Supply" : "All-Time Net"}
              value={<span style={{ color: netColor(allTimeNet) }}>{signedUsd(allTimeNet)}</span>}
              sub={chainFilter === null ? `${tokenFilter ?? "USDT + USDC"} currently on Electroneum` : `Since launch, ${scopeLabel}`}
            />
          </div>

          <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 16 }}>
            <div style={{ ...sectionLabel, marginBottom: 14 }}>Net Flow per Day — {scopeLabel} — Rolling 12 Months</div>
            {rows.length > 0 && <HyperlaneChart rows={rows} />}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 12, fontSize: 11, color: mutedLight }}>
              <LegendSwatch color={green} label="Net inflow (more bridged in)" />
              <LegendSwatch color={red} label="Net outflow (more bridged out)" />
            </div>
          </div>

          <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 16 }}>
            <div style={{ ...sectionLabel, marginBottom: 10 }}>By Chain — {tokenFilter ?? "USDT + USDC"} — Last 12 Months</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 380 }}>
                <thead>
                  <tr style={{ color: muted, textAlign: "right" }}>
                    <th style={{ textAlign: "left", fontWeight: 700, padding: "4px 0" }}>Chain</th>
                    <th style={{ fontWeight: 700 }}>Inflow</th>
                    <th style={{ fontWeight: 700 }}>Outflow</th>
                    <th style={{ fontWeight: 700 }}>Net</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.map((c) => (
                    <tr
                      key={c.domain}
                      onClick={() => setChainFilter(chainFilter === c.domain ? null : c.domain)}
                      style={{ borderTop: `1px solid ${border}`, cursor: "pointer", textAlign: "right", background: chainFilter === c.domain ? "rgba(24,187,26,0.08)" : undefined }}
                    >
                      <td style={{ textAlign: "left", padding: "9px 0", color: "#fff", fontWeight: 700 }}>{c.name}</td>
                      <td style={{ color: mutedLight }}>{formatUsdCompact(c.inflow)}</td>
                      <td style={{ color: mutedLight }}>{formatUsdCompact(c.outflow)}</td>
                      <td style={{ color: netColor(c.net), fontWeight: 800 }}>{signedUsd(c.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 10, color: muted, marginTop: 8 }}>Click a chain to filter the chart. Only chains the tokens are enrolled with on Hyperlane appear.</div>
          </div>
        </>
      )}

      {data?.updatedAt && (
        <div style={{ fontSize: 10, color: muted }}>
          Updated {timeAgo(data.updatedAt)} · contracts:{" "}
          {tokens.map((t, i) => (
            <span key={t.symbol}>
              {i > 0 && ", "}
              <a href={`${EXPLORER_BASE_URL}/address/${t.address}`} target="_blank" rel="noreferrer" style={{ color: muted }}>{t.symbol}</a>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
