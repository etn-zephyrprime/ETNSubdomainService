import React, { useEffect, useState } from "react";
import { green, orange, blue, error as red, muted, mutedLight, panel2, border, monoFont } from "../theme.js";
import TokenLogo from "./TokenLogo.jsx";
import { useTeamWalletDestinations } from "../hooks/useTeamWalletDestinations.js";
import { formatCompact, shortHash, timeAgo } from "../utils/format.js";
import { EXPLORER_BASE_URL } from "../config.js";
import StatCard from "./StatCard.jsx";
import CornerBrackets from "./CornerBrackets.jsx";

const sectionLabel = { fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted };
const etn = (n) => `${formatCompact(n)} ETN`;

const KIND = {
  exchange: { label: "EXCHANGE", color: orange },
  contract: { label: "CONTRACT", color: blue },
  wallet: { label: "WALLET", color: mutedLight },
};

function KindBadge({ kind }) {
  const k = KIND[kind] || KIND.wallet;
  return <span style={{ fontFamily: monoFont, fontSize: 9, fontWeight: 800, letterSpacing: 0.6, color: k.color, border: `1px solid ${k.color}`, borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}>{k.label}</span>;
}

function AddressLink({ address, label, onSelectAddress }) {
  const text = label || shortHash(address);
  if (onSelectAddress && !label) {
    return (
      <button onClick={() => onSelectAddress(address)} style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "#fff", fontFamily: monoFont, fontSize: 12, fontWeight: 700 }}>
        {text}
      </button>
    );
  }
  return (
    <a href={`${EXPLORER_BASE_URL}/address/${address}`} target="_blank" rel="noreferrer" title={address} style={{ color: "#fff", fontSize: 12, fontWeight: 700, textDecoration: "none", fontFamily: label ? undefined : monoFont }}>
      {text}
    </a>
  );
}

function DestinationRow({ d, onSelectAddress }) {
  return (
    <div style={{ padding: "10px 0", borderBottom: `1px solid ${border}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, flexWrap: "wrap" }}>
          <KindBadge kind={d.kind} />
          <AddressLink address={d.address} label={d.label} onSelectAddress={onSelectAddress} />
          {d.label && <span style={{ fontSize: 10, color: muted, fontFamily: monoFont }}>{shortHash(d.address)}</span>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: red }}>
            <TokenLogo address="NATIVE" label="ETN" size={14} spacing={5} />−{etn(d.netOut)}
          </div>
          <div style={{ fontSize: 10, color: muted }}>net from team · {d.transfers} transfer{d.transfers === 1 ? "" : "s"} · last {timeAgo(d.lastOut)}</div>
        </div>
      </div>

      {d.kind === "wallet" && (
        <div style={{ marginTop: 6, fontSize: 11, color: mutedLight, lineHeight: 1.6 }}>
          {d.onward.length > 0 && (
            <div>
              <span style={{ color: muted }}>Then sent on → </span>
              {d.onward.map((o, i) => (
                <span key={o.address}>
                  {i > 0 && <span style={{ color: muted }}> · </span>}
                  <a href={`${EXPLORER_BASE_URL}/address/${o.address}`} target="_blank" rel="noreferrer" style={{ color: o.kind === "exchange" ? orange : mutedLight, fontWeight: o.kind === "exchange" ? 700 : 500, textDecoration: "none" }}>
                    {o.label || shortHash(o.address)}
                  </a>{" "}
                  <span style={{ color: muted }}>({etn(o.amount)})</span>
                </span>
              ))}
            </div>
          )}
          {d.balance >= 1 && (
            <div>
              <span style={{ color: muted }}>Still holds </span>
              <span style={{ color: green, fontWeight: 700 }}>{etn(d.balance)}</span>
            </div>
          )}
          {d.onward.length === 0 && d.balance < 1 && <div style={{ color: muted }}>No onward transfers found.</div>}
        </div>
      )}
      {d.kind === "contract" && <div style={{ marginTop: 6, fontSize: 11, color: muted }}>Sent into a contract (e.g. an NFT purchase or staking) — not followed further.</div>}
    </div>
  );
}

// "Where did the team's ETN go?" — over the last 12 months, what the suspected team wallets sent to addresses outside
// the team, the biggest destinations, and (for receiving wallets) where they sent it next and what they still hold.
// Backed by backend/utils/teamWalletsDestinations.js's R2-published report.
export default function TeamDestinations({ onSelectAddress }) {
  const { getTeamWalletDestinations } = useTeamWalletDestinations();
  const [report, setReport] = useState(undefined); // undefined = loading, null = unavailable

  useEffect(() => {
    let cancelled = false;
    getTeamWalletDestinations().then((res) => { if (!cancelled) setReport(res); });
    return () => { cancelled = true; };
  }, [getTeamWalletDestinations]);

  if (report === null) return null; // not published yet / failed — the rest of the tab is unaffected
  if (report === undefined) return null;

  const { totals, fate, destinations } = report;
  const fateTotal = fate.exchangeEtn + fate.heldEtn + fate.otherEtn;
  const pct = (v) => (fateTotal > 0 ? `${Math.round((v / fateTotal) * 100)}%` : "—");

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ ...sectionLabel, marginBottom: 4 }}>[ Where Team ETN Went — Last 12 Months ]</div>
      <div style={{ fontSize: 11, color: mutedLight, marginBottom: 10, lineHeight: 1.5 }}>
        What the suspected team wallets sent to addresses outside the team, the biggest destinations, and — for receiving wallets — where they sent it next.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
        {[
          { label: "Sent Out", value: etn(totals.outEtn), color: red },
          { label: "Came Back In", value: etn(totals.inEtn), color: green },
          { label: "Net Out", value: etn(totals.netOutEtn), color: "#fff" },
        ].map((c) => (
          <StatCard key={c.label} label={c.label} value={<span style={{ color: c.color }}>{c.value}</span>} />
        ))}
      </div>

      <div style={{ position: "relative", padding: "12px 14px", borderRadius: 4, background: panel2, border: `1px solid ${border}` }}>
        <CornerBrackets color={green} />
        {fateTotal > 0 && (
          <div style={{ fontSize: 12, color: mutedLight, marginBottom: 6, lineHeight: 1.6 }}>
            Of the {etn(fateTotal)} received by the top destinations below (net):{" "}
            <b style={{ color: orange }}>{etn(fate.exchangeEtn)} ({pct(fate.exchangeEtn)})</b> ended up at exchanges,{" "}
            <b style={{ color: green }}>{etn(fate.heldEtn)} ({pct(fate.heldEtn)})</b> is still held by the receiving wallets, and{" "}
            <b style={{ color: "#fff" }}>{etn(fate.otherEtn)} ({pct(fate.otherEtn)})</b> went elsewhere (other wallets, contracts, unclear).
          </div>
        )}
        {destinations.map((d) => <DestinationRow key={d.address} d={d} onSelectAddress={onSelectAddress} />)}
        <div style={{ fontSize: 10, color: muted, marginTop: 10, lineHeight: 1.5 }}>
          Plain ETN transfers only, followed one hop. "Sent on" counts everything a receiving wallet forwarded afterwards, so it can include ETN
          from other sources, and the exchange / held / elsewhere split is approximate. Exchanges are addresses already labelled in this
          dashboard's list. Updated {timeAgo(report.generatedAt)}.
        </div>
      </div>
    </div>
  );
}
