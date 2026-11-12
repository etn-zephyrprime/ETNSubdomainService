import React, { useState } from "react";
import { BadgeCheck, OctagonAlert, HelpCircle, Globe, ChevronDown, ChevronRight, History } from "lucide-react";
import { OverallBadge, RiskFlagList, shortAddr } from "./ContractCheckBits.jsx";
import { green, gold, error as errorColor, muted, mutedLight, border, panel2, monoFont } from "../theme.js";

// The App Check result card, wallet-free so the free lookalike box can use it too. Core-only sections
// (domain facts, contracts, changes, actions) render only when the result has them. Nothing here shows text a
// scanned site controls: hosts come from what the member typed, labels from our registry / Contract Check,
// and React escapes everything anyway.

// Where to ask for an app to be added to the registry (and checked by us).
export const REGISTRY_REQUEST_URL = "https://t.me/ETN_ZephyrPrime";

/** "Want an app listed?" — a link to discuss it with ZephyrPrime on Telegram (with their profile picture). */
export function RegistryRequestLink({ style = {} }) {
  return (
    <a
      href={REGISTRY_REQUEST_URL}
      target="_blank"
      rel="noopener noreferrer"
      style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", border: `1px solid ${border}`, borderRadius: 6, padding: "8px 10px", ...style }}
    >
      <img src="/team/zephyrprime-pfp.jpg" alt="ZephyrPrime" width={32} height={32} style={{ borderRadius: "50%", flexShrink: 0 }} />
      <span style={{ fontSize: 12, color: mutedLight, lineHeight: 1.45 }}>
        Want an app added to our registry and verified on Argus? <span style={{ color: green, fontWeight: 700 }}>Discuss it with ZephyrPrime on Telegram</span>{" "}
        <span style={{ fontFamily: monoFont, fontSize: 11, color: muted }}>t.me/ETN_ZephyrPrime</span>
      </span>
    </a>
  );
}

export const APP_CHECK_FOOTER = "Automated analysis of the contracts we could find. It can't see what a site will ask you to sign. Not financial advice.";

const label = { fontFamily: monoFont, fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: mutedLight, margin: "16px 0 8px" };
const rowStyle = { display: "flex", alignItems: "center", gap: 10, width: "100%", background: panel2, border: `1px solid ${border}`, borderRadius: 6, padding: "9px 12px", color: "#fff", textAlign: "left", boxSizing: "border-box" };

function StatusBanner({ r }) {
  const host = r.normalised?.displayHost || r.input;
  if (r.status === "known" && r.app.source === "explorer") {
    // on the explorer's Apps list: a listing, not a check by us — no tick, no green border
    return (
      <div style={{ display: "flex", gap: 10, alignItems: "center", border: `1px solid ${border}`, borderRadius: 6, padding: "10px 12px" }}>
        <Globe size={18} color={mutedLight} style={{ flexShrink: 0 }} />
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          On the Electroneum block explorer's app list as {r.app.name}
          <div style={{ fontSize: 11, color: muted, fontWeight: 400 }}>A listing there isn't a safety check — the badge below comes from its contracts.</div>
          <div style={{ fontFamily: monoFont, fontSize: 11, color: muted, fontWeight: 400, overflowWrap: "anywhere" }}>{host}</div>
        </div>
      </div>
    );
  }
  if (r.status === "known") {
    return (
      <div style={{ display: "flex", gap: 10, alignItems: "center", border: `1px solid ${green}`, borderRadius: 6, padding: "10px 12px" }}>
        <BadgeCheck size={18} color={green} style={{ flexShrink: 0 }} />
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          Listed site for {r.app.name}
          <div style={{ fontFamily: monoFont, fontSize: 11, color: muted, fontWeight: 400, overflowWrap: "anywhere" }}>{host}</div>
        </div>
      </div>
    );
  }
  if (r.status === "lookalike") {
    return (
      <div role="alert" style={{ display: "flex", gap: 10, alignItems: "flex-start", border: `2px solid ${errorColor}`, background: "rgba(255,107,107,0.08)", borderRadius: 6, padding: "12px 14px" }}>
        <OctagonAlert size={22} color={errorColor} style={{ flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: errorColor }}>
            Resembles {r.app.name} but isn't a listed site
          </div>
          <div style={{ fontFamily: monoFont, fontSize: 11, color: mutedLight, overflowWrap: "anywhere", margin: "2px 0 8px" }}>
            {host} — the listed site is {r.resembles}
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>
            {(r.lookalikeReasons || []).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", border: `1px solid ${border}`, borderRadius: 6, padding: "10px 12px" }}>
      <HelpCircle size={18} color={mutedLight} style={{ flexShrink: 0 }} />
      <div style={{ fontSize: 14, fontWeight: 700 }}>
        Not in our registry
        <div style={{ fontFamily: monoFont, fontSize: 11, color: muted, fontWeight: 400, overflowWrap: "anywhere" }}>{host}</div>
      </div>
    </div>
  );
}

function DomainFacts({ r }) {
  const d = r.domain;
  if (!d) return null;
  const age = typeof d.ageDays === "number" ? `Registered ${d.ageDays === 0 ? "today" : `${d.ageDays} day${d.ageDays === 1 ? "" : "s"} ago`}` : "Age unknown";
  const https = d.https === true ? "HTTPS" : d.https === false ? "Not HTTPS" : "HTTPS not stated";
  const puny = r.normalised?.punycode ? `International characters (${r.normalised.punycode})` : null;
  return (
    <>
      <div style={label}>
        <Globe size={12} style={{ verticalAlign: -2 }} /> Domain
      </div>
      <div style={{ fontSize: 13, color: mutedLight }}>{[age, https, puny].filter(Boolean).join(" · ")}</div>
    </>
  );
}

const CHANGE_TEXT = {
  contract_added: (d) => `New contract ${d.label || shortAddr(d.address)}${d.overall && d.overall !== "unknown" ? ` (${d.overall})` : ""}`,
  contract_removed: (d) => `Contract ${shortAddr(d.address)} no longer in its code`,
  contract_changed: (d) => `${d.label || shortAddr(d.address)} changed its ${(d.changes || []).map((c) => ({ codeHash: "code", implementation: "implementation", owner: "owner" })[c.field] || c.field).join(" and ")}`,
  frontend_redeployed: () => "Site updated (same contracts)",
  domain_changed: (d) => `Registry websites changed${d.added?.length ? ` — added ${d.added.join(", ")}` : ""}${d.removed?.length ? ` — removed ${d.removed.join(", ")}` : ""}`,
};
const SEV_COLOR = { high: errorColor, caution: gold, info: mutedLight };

function Changes({ changes }) {
  if (!changes?.length) return null;
  return (
    <>
      <div style={label}>
        <History size={12} style={{ verticalAlign: -2 }} /> Changes
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {changes.map((e) => (
          <div key={e.id} style={{ fontSize: 12, color: mutedLight, borderLeft: `3px solid ${SEV_COLOR[e.severity] || border}`, paddingLeft: 8 }}>
            {(CHANGE_TEXT[e.type] || (() => e.type))(e.details || {})}
            <span style={{ color: muted }}> · {new Date(e.detectedAt).toLocaleDateString()}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Contracts({ r, onOpenContract }) {
  const [walletsOpen, setWalletsOpen] = useState(false);
  const contracts = r.contracts || [];
  const wallets = r.scan?.wallets || [];
  if (!contracts.length && !wallets.length) return null;
  const notAnalysed = contracts.filter((c) => c.note === "not analysed (contract cap reached)").length;
  return (
    <>
      <div style={label}>Contracts ({contracts.length})</div>
      <div style={{ display: "grid", gap: 6 }}>
        {contracts.map((c) => (
          <button key={c.address} type="button" onClick={() => onOpenContract?.(c.address, c.label || c.role)} style={{ ...rowStyle, cursor: onOpenContract ? "pointer" : "default" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, overflowWrap: "anywhere" }}>{c.label || c.role || shortAddr(c.address)}</div>
              <div style={{ fontFamily: monoFont, fontSize: 11, color: muted }}>
                {shortAddr(c.address)}
                {c.role && c.label ? ` · ${c.role}` : ""}
                {c.source === "scan" ? " · found in this site's code, not confirmed by the project" : ""}
                {c.note ? ` · ${c.note}` : ""}
              </div>
            </div>
            <OverallBadge overall={c.overall === "unknown" ? null : c.overall} small />
          </button>
        ))}
      </div>
      {notAnalysed > 0 && <div style={{ fontSize: 12, color: muted, marginTop: 6 }}>{notAnalysed} more contracts were found but not checked (we check up to 25 per scan).</div>}
      {wallets.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button type="button" onClick={() => setWalletsOpen((o) => !o)} style={{ background: "transparent", border: "none", color: mutedLight, fontSize: 12, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4 }}>
            {walletsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {wallets.length} wallet or other-chain address{wallets.length === 1 ? "" : "es"} (not part of the badge)
          </button>
          {walletsOpen && (
            <div style={{ fontFamily: monoFont, fontSize: 11, color: muted, marginTop: 6, display: "grid", gap: 2 }}>
              {wallets.map((w) => (
                <div key={w.address} style={{ overflowWrap: "anywhere" }}>
                  {w.address}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

const minutesAgo = (r) => {
  const sec = r.cache?.hit ? r.cache.ageSeconds : 0;
  return sec < 90 ? "just now" : sec < 5400 ? `${Math.round(sec / 60)} min ago` : `${Math.round(sec / 3600)} h ago`;
};

/** The result card. `actions` (Core): a node with Scan / Rescan / Watch buttons. */
export default function AppCheckResult({ r, onOpenContract = null, actions = null, freeNote = null }) {
  if (!r) return null;
  if (r.status === "invalid") return <div style={{ color: errorColor, fontSize: 13 }}>{r.error?.message || r.overallReason}</div>;
  const flags = (r.flags || r.domain?.flags || []).filter((f) => f.id !== "lookalike_domain");
  return (
    <div style={{ display: "grid", gap: 0 }}>
      <StatusBanner r={r} />
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        {r.overall && <OverallBadge overall={r.overall} />}
        <div style={{ flex: "1 1 220px", fontSize: 13, color: mutedLight, lineHeight: 1.5 }}>{r.overallReason}</div>
      </div>
      {flags.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <RiskFlagList flags={flags} />
        </div>
      )}
      <DomainFacts r={r} />
      <Contracts r={r} onOpenContract={onOpenContract} />
      <Changes changes={r.changes} />
      {r.tier === "core" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
          <span style={{ fontSize: 12, color: muted }}>
            Checked {minutesAgo(r)}
            {r.scan ? ` · scanned ${new Date(r.scan.scannedAt).toLocaleString()}${r.scan.status !== "ok" ? ` (${r.scan.status})` : ""}` : ""}
            {r.scan?.url && r.scan.url.replace(/\/$/, "") !== r.normalised?.origin ? ` · page: ${r.scan.url.replace(/^https?:\/\//, "")}${r.scan.pageOnly ? " (page only)" : ""}` : ""}
          </span>
          <span style={{ flex: 1 }} />
          {actions}
        </div>
      )}
      {freeNote}
      <div style={{ fontSize: 11, color: muted, marginTop: 14, lineHeight: 1.5 }}>{APP_CHECK_FOOTER}</div>
    </div>
  );
}
