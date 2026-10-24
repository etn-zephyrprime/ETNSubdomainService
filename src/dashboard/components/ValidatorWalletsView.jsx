import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { green, blue, mutedLight, muted, panel2, border, error as red, monoFont } from "../theme.js";
import TokenLogo from "./TokenLogo.jsx";
import StatCard from "./StatCard.jsx";
import SparklineChart from "./SparklineChart.jsx";
import CornerBrackets from "./CornerBrackets.jsx";
import { useValidatorWallets } from "../hooks/useValidatorWallets.js";
import { useEtnPrice } from "../../hooks/useEtnPrice.js";
import { formatEtnShort, formatEtnShortWei, formatInt, formatTokenAmount, formatUsdPrice, formatChartDate, shortHash, timeAgo } from "../utils/format.js";
import { EXPLORER_BASE_URL } from "../config.js";

// The Validators view of the Team Wallets tab: every Electroneum validator's ETN balance, the
// combined balance over 90 days, and EVERY outgoing transfer at any size — the point is spotting
// the moment validators stop just accumulating their block rewards and start moving (or selling)
// ETN. Backed by backend/utils/validatorWalletsCache.js's R2 snapshot (useValidatorWallets.js).
const POLL_INTERVAL_MS = 60000;
const RECENT_DAYS = 30; // the status banner's window

const sectionLabelStyle = { fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 };
const amber = "#f5b942";

function balanceOf(v) {
  try {
    return BigInt(v.balance || "0");
  } catch {
    return 0n;
  }
}

// How a destination reads: a DEX router or exchange is the selling signal.
function destinationStyle(destination) {
  switch (destination?.kind) {
    case "dex":
      return { tag: "DEX SWAP", color: red };
    case "cex":
      return { tag: "EXCHANGE", color: red };
    case "team":
      return { tag: "TEAM WALLET", color: blue };
    case "validator":
      return { tag: "VALIDATOR", color: blue };
    default:
      return { tag: "OUT", color: amber };
  }
}

function amountText(o) {
  if (o.symbol === "ETN") {
    let small = false;
    try { small = BigInt(o.value) < 1000n * 10n ** 18n; } catch { /* unparseable: the short form shows "—" */ }
    return `${small ? formatTokenAmount(o.value, 18) : formatEtnShortWei(o.value)} ETN`;
  }
  return `${formatTokenAmount(o.value, o.decimals)} ${o.symbol}`;
}

function StatusBanner({ outgoing, validatorCount }) {
  const cutoff = Date.now() - RECENT_DAYS * 86400000;
  const recent = outgoing.filter((o) => Date.parse(o.timestamp) >= cutoff && !o.failed);
  const selling = recent.filter((o) => o.destination?.kind === "dex" || o.destination?.kind === "cex");
  const last = outgoing.find((o) => !o.failed);

  let tone, title, detail;
  if (selling.length > 0) {
    tone = red;
    title = `Selling signal — ${selling.length} transfer${selling.length === 1 ? "" : "s"} to a DEX or exchange in the last ${RECENT_DAYS} days`;
    detail = `Latest: ${amountText(selling[0])} → ${selling[0].destination.label}, ${timeAgo(selling[0].timestamp)}.`;
  } else if (recent.length > 0) {
    tone = amber;
    title = `Validators are moving ETN — ${recent.length} outgoing transfer${recent.length === 1 ? "" : "s"} in the last ${RECENT_DAYS} days`;
    detail = `Latest: ${amountText(recent[0])} to ${recent[0].destination?.label || shortHash(recent[0].to)}, ${timeAgo(recent[0].timestamp)}.`;
  } else {
    tone = green;
    title = `No outgoing transfers — all ${validatorCount} validators are only accumulating`;
    detail = last
      ? `Last outgoing transfer ever: ${amountText(last)}, ${new Date(last.timestamp).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}.`
      : "No validator has ever sent a transaction.";
  }

  return (
    <div style={{ padding: "12px 14px", borderRadius: 4, border: `1px solid ${tone}`, background: `${tone}14`, marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: tone, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, color: mutedLight }}>{detail}</div>
    </div>
  );
}

function OutgoingRow({ o }) {
  const d = destinationStyle(o.destination);
  return (
    <a
      className="dash-team-row"
      href={`${EXPLORER_BASE_URL}/tx/${o.hash}`}
      target="_blank"
      rel="noreferrer"
      style={{ display: "block", padding: "10px 0", borderBottom: `1px solid ${border}`, textDecoration: "none", opacity: o.failed ? 0.5 : 1 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontFamily: monoFont, fontSize: 10, fontWeight: 800, letterSpacing: 0.6, color: d.color }}>
          {d.tag}
          {o.failed ? " · FAILED" : ""}
        </span>
        <span style={{ fontSize: 10, color: muted }}>{timeAgo(o.timestamp)}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden", fontSize: 12, fontFamily: monoFont, color: mutedLight, whiteSpace: "nowrap" }}>
          <span>{shortHash(o.from)}</span>
          <span style={{ color: d.color }}>→</span>
          <span>{o.destination?.label || shortHash(o.to)}</span>
        </div>
        <div style={{ fontSize: 12, color: d.color, fontWeight: 700, flexShrink: 0, whiteSpace: "nowrap" }}>
          {o.symbol === "ETN" && <TokenLogo address="NATIVE" label="ETN" size={14} spacing={5} />}−{amountText(o)}
        </div>
      </div>
    </a>
  );
}

export default function ValidatorWalletsView() {
  const { getValidatorWallets } = useValidatorWallets();
  const etnUsdPrice = useEtnPrice();

  const [data, setData] = useState(null); // null = loading
  const [selected, setSelected] = useState("all");

  useEffect(() => {
    let cancelled = false;
    const refresh = () => getValidatorWallets().then((res) => { if (!cancelled) setData(res); });
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [getValidatorWallets]);

  const validators = useMemo(() => [...(data?.validators || [])].sort((a, b) => {
    const diff = balanceOf(b) - balanceOf(a);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  }), [data]);
  const outgoing = data?.outgoing || [];
  const totalWei = validators.reduce((s, v) => s + balanceOf(v), 0n);

  const chartData = useMemo(() => {
    if (selected === "all") return (data?.series || []).map((p) => ({ label: p.date, value: p.etn }));
    const v = validators.find((x) => x.address === selected);
    return (v?.daily || []).map((p) => ({ label: p.date, value: p.etn }));
  }, [data, validators, selected]);

  // Accumulation rate over the last 30 days of the chart's series.
  const perDay = useMemo(() => {
    if (chartData.length < 2) return null;
    const end = chartData[chartData.length - 1];
    const start = chartData[Math.max(0, chartData.length - 1 - 30)];
    const days = (Date.parse(end.label) - Date.parse(start.label)) / 86400000;
    return days > 0 ? (end.value - start.value) / days : null;
  }, [chartData]);
  const change90 = chartData.length >= 2 ? chartData[chartData.length - 1].value - chartData[0].value : null;

  if (data === null) return <div style={{ fontSize: 12, color: muted, padding: "14px 0" }}>Loading…</div>;
  if (validators.length === 0) return <div style={{ fontSize: 12, color: muted, padding: "14px 0" }}>No validator data available yet — the backend publishes it every 10 minutes.</div>;

  return (
    <div>
      <div style={{ fontSize: 12, color: mutedLight, marginBottom: 16, lineHeight: 1.5 }}>
        Every address that produced an Electroneum block in the last 90 days. Their balances grow from the protocol's block reward, which isn't a transaction — so any
        outgoing transfer, at any size, is listed here. A transfer to a DEX router or a known exchange is flagged as a selling signal.
      </div>

      <StatusBanner outgoing={outgoing} validatorCount={validators.length} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 24 }}>
        <StatCard
          label="Combined Validator Balance"
          value={<><TokenLogo address="NATIVE" label="ETN" size={20} spacing={7} />{formatEtnShortWei(totalWei)} ETN</>}
          sub={etnUsdPrice != null ? formatUsdPrice(parseFloat(ethers.formatEther(totalWei)) * etnUsdPrice) : undefined}
        >
          {data.updatedAt && <div style={{ fontSize: 11, color: mutedLight, marginTop: 4 }}>Updated {timeAgo(data.updatedAt)}</div>}
        </StatCard>
        <StatCard
          label={selected === "all" ? "Accumulating (30-day avg)" : "This Validator (30-day avg)"}
          value={perDay == null ? "—" : `${perDay >= 0 ? "+" : "−"}${formatEtnShort(Math.abs(perDay))} ETN/day`}
          sub={change90 == null ? undefined : `${change90 >= 0 ? "+" : "−"}${formatEtnShort(Math.abs(change90))} ETN over 90 days`}
        />
        <StatCard label="Validators" value={formatInt(validators.length)} sub={`${outgoing.filter((o) => !o.failed).length} outgoing transfer(s) on record`} />
      </div>

      <div style={{ position: "relative", padding: 16, borderRadius: 4, background: panel2, border: `1px solid ${border}`, marginBottom: 24 }}>
        <CornerBrackets color={green} />
        <div style={{ ...sectionLabelStyle, marginBottom: 14 }}>
          <TokenLogo address="NATIVE" label="ETN" size={16} spacing={7} />{selected === "all" ? "Combined Validator Balance" : "Validator Balance"} — Last 90 Days
        </div>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="Filter by validator"
          style={{ width: "100%", maxWidth: 360, marginBottom: 14, padding: "8px 12px", borderRadius: 6, border: `1px solid ${border}`, background: "#0b0b0b", color: "#fff", fontFamily: monoFont, fontSize: 12, fontWeight: 600, outline: "none" }}
        >
          <option value="all">All validators</option>
          {validators.map((v) => (
            <option key={v.address} value={v.address}>{shortHash(v.address)} — {formatEtnShortWei(v.balance)} ETN</option>
          ))}
        </select>
        {chartData.length < 2 ? (
          <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: muted }}>No balance history available yet.</div>
        ) : (
          <SparklineChart data={chartData} height={140} formatValue={(v) => `${formatEtnShort(v)} ETN`} formatLabel={formatChartDate} />
        )}
      </div>

      <div style={sectionLabelStyle}>Validators ({validators.length})</div>
      <div style={{ position: "relative", padding: "0 14px 6px", background: panel2, border: `1px solid ${border}`, borderRadius: 4, marginBottom: 24 }}>
        <CornerBrackets color={green} />
        {validators.map((v) => (
          <div key={v.address} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${border}`, flexWrap: "wrap" }}>
            <div style={{ minWidth: 0 }}>
              <a href={`${EXPLORER_BASE_URL}/address/${v.address}`} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#fff", fontFamily: monoFont, textDecoration: "none", wordBreak: "break-all" }}>
                {v.address}
              </a>
              <div style={{ fontSize: 10, color: muted, marginTop: 2 }}>
                {v.validations != null ? `${formatInt(v.validations)} blocks validated · ` : ""}
                {v.lastOutgoingAt ? <span style={{ color: amber }}>last sent {timeAgo(v.lastOutgoingAt)}</span> : "never sent ETN"}
                {v.stale ? " · not refreshed this cycle" : ""}
              </div>
            </div>
            <div style={{ fontSize: 12, color: green, fontWeight: 700, whiteSpace: "nowrap" }}>{formatEtnShortWei(v.balance)} ETN</div>
          </div>
        ))}
      </div>

      <div style={{ ...sectionLabelStyle, marginBottom: 4 }}>Outgoing Validator Transfers</div>
      <div style={{ fontSize: 11, color: mutedLight, marginBottom: 10 }}>
        Every transfer out of a validator, any size, newest first.{" "}
        <span style={{ color: red, fontWeight: 700 }}>DEX SWAP / EXCHANGE</span> = likely selling,{" "}
        <span style={{ color: blue, fontWeight: 700 }}>TEAM WALLET / VALIDATOR</span> = moved within the team,{" "}
        <span style={{ color: amber, fontWeight: 700 }}>OUT</span> = anywhere else.
      </div>
      <div style={{ position: "relative", padding: "0 14px", background: panel2, border: `1px solid ${border}`, borderRadius: 4 }}>
        <CornerBrackets color={green} />
        {outgoing.length === 0 ? (
          <div style={{ fontSize: 12, color: muted, padding: "14px 0" }}>No validator has ever sent a transfer.</div>
        ) : (
          outgoing.map((o) => <OutgoingRow key={`${o.hash}:${o.symbol}`} o={o} />)
        )}
      </div>
    </div>
  );
}
