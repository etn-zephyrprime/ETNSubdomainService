import React, { useEffect, useMemo, useState } from "react";
import { green, error as red, blue, muted, mutedLight, panel2, border } from "../theme.js";
import TokenLogo from "./TokenLogo.jsx";
import StatCard from "./StatCard.jsx";
import HyperlaneChart, { signedUsd } from "./HyperlaneChart.jsx";
import { useHyperlaneBridge } from "../hooks/useHyperlaneBridge.js";
import { formatInt, formatUsdCompact, timeAgo } from "../utils/format.js";
import { EXPLORER_BASE_URL } from "../config.js";
import { WINDOW_DAYS, chainName, chainOptions, chainSummary, dailyFlows, netAllTime, totals } from "../utils/hyperlaneSeries.js";

// Time-range filter. Everything on the tab (charts, stat cards, per-chain panels and table) follows it; the
// default stays the full rolling 12 months. `label` is the pill, `long` reads in the section headings.
const RANGES = [
  { days: 7, label: "7D", long: "7 Days" },
  { days: 30, label: "30D", long: "30 Days" },
  { days: 90, label: "90D", long: "90 Days" },
  { days: WINDOW_DAYS, label: "12M", long: "12 Months" },
];

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
  const [rangeDays, setRangeDays] = useState(WINDOW_DAYS);
  const range = RANGES.find((r) => r.days === rangeDays) ?? RANGES[RANGES.length - 1];

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

  // Every chain that is an ACTIVE ROUTE for the selected token(s) — plus any that has carried traffic in the past —
  // whether or not it moved anything recently. (USDT is routed to Ethereum only; USDC to Ethereum, Base and
  // Avalanche.) Read from the contracts' own enrolled-domain lists, so a new route appears by itself.
  const allChains = useMemo(() => {
    const forToken = selectedTokenIndex === null ? events : events.filter((e) => e[1] === selectedTokenIndex);
    return chainOptions(forToken, enrolled);
  }, [events, selectedTokenIndex, enrolled]);
  // A chain picked for one token may not be a route for another: fall back to "all chains" rather than show nothing.
  const activeChain = chainFilter !== null && allChains.some((c) => c.domain === chainFilter) ? chainFilter : null;

  // A chain that isn't active for the selected token still shows in the filter, just with no traffic.
  const rows = useMemo(
    () => (events.length || tokens.length ? dailyFlows(events, { tokenIndex: selectedTokenIndex, domain: activeChain, nowMs, days: range.days }) : []),
    [events, tokens, selectedTokenIndex, activeChain, nowMs, range.days]
  );
  const sum = useMemo(() => totals(rows), [rows]);
  const breakdown = useMemo(
    () => chainSummary(events, { tokenIndex: selectedTokenIndex, nowMs, days: range.days, enrolledDomains: enrolled }),
    [events, selectedTokenIndex, nowMs, range.days, enrolled]
  );
  const allTimeNet = useMemo(() => netAllTime(events, { tokenIndex: selectedTokenIndex, domain: activeChain }), [events, selectedTokenIndex, activeChain]);

  const panels = useMemo(
    () => allChains.map((c) => {
      const chainRows = dailyFlows(events, { tokenIndex: selectedTokenIndex, domain: c.domain, nowMs, days: range.days });
      return { ...c, rows: chainRows, sum: totals(chainRows) };
    }),
    [allChains, events, selectedTokenIndex, nowMs, range.days]
  );

  const scopeLabel = `${tokenFilter ?? "USDT + USDC"}${activeChain === null ? "" : ` via ${chainName(activeChain)}`}`;
  const hasData = data && events.length > 0;
  const chainNote = activeChain === null ? "across all chains" : `via ${chainName(activeChain)}`;

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
              <div style={{ ...sectionLabel, marginBottom: 6 }}>Range</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {RANGES.map((r) => (
                  <Pill key={r.days} active={range.days === r.days} onClick={() => setRangeDays(r.days)}>{r.label}</Pill>
                ))}
              </div>
            </div>
            <div>
              <div style={{ ...sectionLabel, marginBottom: 6 }}>Chain</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <Pill active={activeChain === null} onClick={() => setChainFilter(null)}>All chains</Pill>
                {allChains.map((c) => (
                  <Pill key={c.domain} active={activeChain === c.domain} onClick={() => setChainFilter(c.domain)}>{c.name}</Pill>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginBottom: 16 }}>
            <StatCard
              label={`Net Flow · ${range.long}`}
              value={<span style={{ color: netColor(sum.net) }}>{signedUsd(sum.net)}</span>}
              sub={`${sum.net >= 0 ? "More came in than left" : "More left than came in"} ${chainNote} · ${formatInt(sum.count)} transfers`}
            />
            <StatCard label={`Inflow · ${range.long}`}value={<span style={{ color: green }}>{formatUsdCompact(sum.inflow)}</span>} sub="Bridged onto Electroneum" />
            <StatCard label={`Outflow · ${range.long}`}value={<span style={{ color: red }}>{formatUsdCompact(sum.outflow)}</span>} sub="Bridged off Electroneum" />
            <StatCard
              label={activeChain === null ? "Bridged Supply" : "All-Time Net"}
              value={<span style={{ color: netColor(allTimeNet) }}>{signedUsd(allTimeNet)}</span>}
              sub={activeChain === null ? `${tokenFilter ?? "USDT + USDC"} currently on Electroneum` : `Since launch, ${scopeLabel}`}
            />
          </div>

          <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 16 }}>
            <div style={{ ...sectionLabel, marginBottom: 14 }}>Net Flow per Day — {scopeLabel} — {range.days === WINDOW_DAYS ? "Rolling 12 Months" : `Last ${range.long}`}</div>
            {rows.length > 0 && <HyperlaneChart rows={rows} />}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: 12, fontSize: 11, color: mutedLight }}>
              <LegendSwatch color={green} label="Net inflow (more bridged in)" />
              <LegendSwatch color={red} label="Net outflow (more bridged out)" />
            </div>
          </div>

          <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 16 }}>
            <div style={{ ...sectionLabel, marginBottom: 4 }}>Net Flow per Day, by Chain — {tokenFilter ?? "USDT + USDC"}</div>
            <div style={{ fontSize: 11, color: mutedLight, marginBottom: 10 }}>
              Every chain {tokenFilter ?? "USDT and USDC"} can be bridged through on Hyperlane, including any with no activity. Each chart has its own scale. Click a chain to focus it above.
            </div>
            {panels.map((c, i) => (
              <div key={c.domain} style={{ borderTop: i === 0 ? "none" : `1px solid ${border}`, paddingTop: i === 0 ? 0 : 10, marginTop: i === 0 ? 0 : 10 }}>
                <button
                  onClick={() => setChainFilter(activeChain === c.domain ? null : c.domain)}
                  style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: "2px 12px", width: "100%", background: "transparent", border: "none", padding: "0 0 6px", cursor: "pointer", textAlign: "left" }}
                >
                  <span style={{ fontSize: 12, fontWeight: 800, color: activeChain === c.domain ? green : "#fff" }}>{c.name}</span>
                  <span style={{ fontSize: 11, color: mutedLight }}>
                    {c.sum.count === 0 ? `No activity in the last ${range.long.toLowerCase()}` : (
                      <>
                        Net <span style={{ color: netColor(c.sum.net), fontWeight: 800 }}>{signedUsd(c.sum.net)}</span> · In {formatUsdCompact(c.sum.inflow)} · Out {formatUsdCompact(c.sum.outflow)} · {formatInt(c.sum.count)} transfers
                      </>
                    )}
                  </span>
                </button>
                <HyperlaneChart rows={c.rows} height={80} compact showXAxis={i === panels.length - 1} />
              </div>
            ))}
          </div>

          <div style={{ padding: 16, borderRadius: 12, background: panel2, border: `1px solid ${border}`, marginBottom: 16 }}>
            <div style={{ ...sectionLabel, marginBottom: 10 }}>By Chain — {tokenFilter ?? "USDT + USDC"} — Last {range.long}</div>
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
                      onClick={() => setChainFilter(activeChain === c.domain ? null : c.domain)}
                      style={{ borderTop: `1px solid ${border}`, cursor: "pointer", textAlign: "right", background: activeChain === c.domain ? "rgba(24,187,26,0.08)" : undefined }}
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
