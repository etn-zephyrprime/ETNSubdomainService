import React from "react";
import { ShieldCheck, ShieldAlert, ShieldX, Shield, BadgeCheck, Info, AlertTriangle, OctagonAlert } from "lucide-react";
import { green, gold, error as errorColor, mutedLight, muted, border, panel2, monoFont, blue } from "../theme.js";

// Shared, wallet-free pieces of Contract Check (no wallet code, so the free Tokens tab can use the overall
// badge): the overall badge, the "Known contract" badge, and the risk-flag list.

export const OVERALL = {
  green: { label: "No caution flags", color: green, Icon: ShieldCheck },
  amber: { label: "Caution", color: gold, Icon: ShieldAlert },
  red: { label: "High risk flags", color: errorColor, Icon: ShieldX },
  // App Check only: a site we can't vouch for (not in the registry) with nothing flagged — never green
  unassessed: { label: "Unassessed", color: mutedLight, Icon: Shield },
};
const SEVERITY = {
  info: { color: blue, Icon: Info, label: "Info" },
  caution: { color: gold, Icon: AlertTriangle, label: "Caution" },
  high: { color: errorColor, Icon: OctagonAlert, label: "High" },
};

export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

/** The contract's display name: registry label, contract name, token symbol, or short address. */
export function contractLabel(facts, fallback) {
  return facts?.identity?.known?.label || (facts?.token?.symbol && facts?.identity?.contractName ? `${facts.identity.contractName} (${facts.token.symbol})` : facts?.identity?.contractName) || fallback || shortAddr(facts?.address);
}

export function OverallBadge({ overall, small = false }) {
  const o = OVERALL[overall];
  if (!o) {
    return <span style={{ fontFamily: monoFont, fontSize: small ? 10 : 11, color: muted, border: `1px solid ${border}`, borderRadius: 999, padding: small ? "1px 7px" : "3px 9px", whiteSpace: "nowrap" }}>Not checked yet</span>;
  }
  const { Icon } = o;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: monoFont, fontSize: small ? 10 : 11, fontWeight: 800, color: o.color, border: `1px solid ${o.color}`, borderRadius: 999, padding: small ? "1px 7px" : "3px 9px", whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: 0.4 }}>
      <Icon size={small ? 11 : 13} /> {o.label}
    </span>
  );
}

export function KnownBadge({ known, small = false }) {
  if (!known) return null;
  return (
    <span title={known.project || known.label} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: monoFont, fontSize: small ? 10 : 11, color: green, border: `1px solid ${border}`, borderRadius: 999, padding: small ? "1px 7px" : "3px 9px", whiteSpace: "nowrap" }}>
      <BadgeCheck size={small ? 11 : 13} /> Known contract
    </span>
  );
}

/** One line on how far the code can be checked, plus age. */
export function VerificationLine({ facts }) {
  const v = facts?.verification?.status;
  const text =
    v === "verified" ? "Verified source" : v === "verifiedTwin" ? "Code matches a verified contract" : v === "unverified" ? "Source not published" : v === "notContract" ? "Not a contract" : "Verification unknown";
  const age = facts?.creation?.ageDays != null ? (facts.creation.ageDays < 1 ? "deployed today" : `${Math.floor(facts.creation.ageDays)} days old`) : null;
  const proxy = facts?.proxy?.isProxy ? "upgradeable proxy" : null;
  return <div style={{ fontSize: 12, color: mutedLight }}>{[text, proxy, age].filter(Boolean).join(" · ")}</div>;
}

export function RiskFlagList({ flags }) {
  if (!flags?.length) return <div style={{ fontSize: 12, color: mutedLight }}>No risk flags raised from the facts we could check.</div>;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
      {flags.map((f) => {
        const s = SEVERITY[f.severity] || SEVERITY.info;
        const { Icon } = s;
        return (
          <li key={f.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", background: panel2, border: `1px solid ${border}`, borderLeft: `3px solid ${s.color}`, borderRadius: 4, padding: "8px 10px" }}>
            <Icon size={15} color={s.color} style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 13, lineHeight: 1.4, overflowWrap: "anywhere" }}>{f.fact}</span>
          </li>
        );
      })}
    </ul>
  );
}
