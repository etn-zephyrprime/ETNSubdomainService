import React, { useCallback, useEffect, useRef, useState } from "react";
import { Users, RefreshCw, ExternalLink } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import { PNL_BACKEND_URL } from "../../../config.js";
import { EXPLORER_BASE_URL } from "../../config.js";
import { useDisplayNames } from "../../hooks/useDisplayNames.js";
import { green, orange, gold, blue, muted, mutedLight, border, monoFont, error as errorColor } from "../../theme.js";

// Admins only: every Core Tier membership, who it is and when it ends. Who's an admin lives in the backend
// (utils/adminMembersRouter.js MEMBERS_ADMINS), which checks the wallet's signature on every request; the
// tab only asks it whether to show itself.
const AUTH_PURPOSE = "Premium Dashboard";
const base = `${PNL_BACKEND_URL}/api/admin/members`;
const SOON_DAYS = 7;

/** Whether the connected wallet is a members admin (decides if the tab appears at all). */
export function useMembersAdmin(wallet) {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (!wallet?.isConnected || !wallet?.account) return setIsAdmin(false);
    let live = true;
    fetch(`${base}/access?wallet=${wallet.account}`)
      .then((r) => r.json())
      .then((d) => live && setIsAdmin(!!d.admin))
      .catch(() => live && setIsAdmin(false));
    return () => {
      live = false;
    };
  }, [wallet?.isConnected, wallet?.account]);
  return isAdmin;
}

const PLAN_STYLE = { annual: gold, monthly: green, trial: blue };
const chip = (color) => ({ fontFamily: monoFont, fontSize: 10, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color, border: `1px solid ${color}`, borderRadius: 4, padding: "2px 6px" });
const btn = { display: "inline-flex", alignItems: "center", gap: 4, background: "transparent", border: `1px solid ${border}`, color: mutedLight, borderRadius: 6, padding: "6px 10px", fontFamily: monoFont, fontWeight: 800, fontSize: 11, textTransform: "uppercase", cursor: "pointer" };
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function Stat({ label, value, color = "#fff" }) {
  return (
    <div style={{ flex: "1 1 90px", border: `1px solid ${border}`, borderRadius: 6, padding: "8px 10px", minWidth: 0 }}>
      <div style={{ fontFamily: monoFont, fontSize: 10, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: muted }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}

function MemberRow({ m, name }) {
  const soon = m.active && m.daysLeft <= SOON_DAYS;
  const when = m.active ? `${m.daysLeft} day${m.daysLeft === 1 ? "" : "s"} left` : m.daysSinceExpiry != null ? `ended ${m.daysSinceExpiry} day${m.daysSinceExpiry === 1 ? "" : "s"} ago` : "never active";
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 14px", padding: "10px 0", borderTop: `1px solid ${border}` }}>
      <div style={{ flex: "2 1 200px", minWidth: 0 }}>
        <div style={{ fontWeight: 700, color: m.active ? "#fff" : mutedLight, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
        <a href={`${EXPLORER_BASE_URL}/address/${m.wallet}`} target="_blank" rel="noreferrer" style={{ fontFamily: monoFont, fontSize: 11, color: muted }}>
          {short(m.wallet)}
        </a>
      </div>
      <div style={{ flex: "0 0 auto" }}>
        <span style={chip(m.active ? PLAN_STYLE[m.plan] : muted)}>{m.plan}</span>
      </div>
      <div style={{ flex: "1 1 140px" }}>
        <div style={{ fontSize: 13, color: m.active ? "#fff" : mutedLight }}>{fmtDate(m.expiresAt)}</div>
        <div style={{ fontSize: 11, fontWeight: soon ? 800 : 400, color: soon ? orange : m.active ? mutedLight : errorColor }}>{when}</div>
      </div>
      <div style={{ flex: "0 1 110px", fontSize: 12, color: mutedLight }}>
        {m.trackedWallets} tracked wallet{m.trackedWallets === 1 ? "" : "s"}
      </div>
      <div style={{ flex: "0 1 auto", fontSize: 11 }}>
        {m.lastTxHash ? (
          <a href={`${EXPLORER_BASE_URL}/tx/${m.lastTxHash}`} target="_blank" rel="noreferrer" style={{ color: muted, display: "inline-flex", alignItems: "center", gap: 3 }}>
            last payment <ExternalLink size={11} />
          </a>
        ) : (
          <span style={{ color: muted }}>{m.plan === "trial" ? "free trial" : ""}</span>
        )}
      </div>
    </div>
  );
}

export default function AdminMembersPanel({ wallet, getAuthParams }) {
  const authRef = useRef(getAuthParams);
  authRef.current = getAuthParams;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("active");

  const load = useCallback(async () => {
    if (!wallet?.account) return;
    setLoading(true);
    setError(null);
    try {
      const { signature, timestamp } = await authRef.current(AUTH_PURPOSE);
      const qs = new URLSearchParams({ wallet: wallet.account, signature, timestamp: String(timestamp) });
      const res = await fetch(`${base}?${qs}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      setData(body);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [wallet?.account]);

  useEffect(() => {
    load();
  }, [load]);

  const members = data?.members || [];
  const { resolve } = useDisplayNames(members.map((m) => m.wallet));
  const shown = members.filter((m) => (filter === "all" ? true : filter === "active" ? m.active : !m.active));
  const s = data?.summary;

  return (
    <DashboardPanel accent={orange} style={{ borderColor: orange }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: monoFont, fontSize: 12, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: orange }}>
          <Users size={15} /> Members (admin)
        </div>
        <button type="button" onClick={load} disabled={loading} style={btn}>
          <RefreshCw size={12} /> {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <div style={{ color: errorColor, fontSize: 13, marginTop: 10 }}>{error}</div>}

      {s && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <Stat label="Active" value={s.active} color={green} />
          <Stat label="Paid" value={s.paid} />
          <Stat label="Annual / Monthly" value={`${s.annual} / ${s.monthly}`} />
          <Stat label="Trials" value={s.trials} color={blue} />
          <Stat label={`Ending ≤ ${SOON_DAYS}d`} value={s.expiringSoon} color={s.expiringSoon ? orange : "#fff"} />
          <Stat label="Lapsed" value={s.expired} color={mutedLight} />
        </div>
      )}

      {data && (
        <>
          <div style={{ display: "flex", gap: 6, margin: "14px 0 4px" }} role="tablist" aria-label="Filter members">
            {[
              ["active", "Active"],
              ["expired", "Lapsed"],
              ["all", "All"],
            ].map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)} style={{ ...btn, color: filter === id ? "#000" : mutedLight, background: filter === id ? orange : "transparent", borderColor: filter === id ? orange : border }}>
                {label}
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <div style={{ color: muted, fontSize: 13, padding: "12px 0" }}>No {filter === "expired" ? "lapsed" : filter === "active" ? "active" : ""} members.</div>
          ) : (
            shown.map((m) => <MemberRow key={m.wallet} m={m} name={resolve(m.wallet)} />)
          )}
          <div style={{ fontSize: 11, color: muted, marginTop: 10 }}>
            From the PremiumSubscription contract's purchase events. Trials are granted with scripts/grantCoreTrial.js. Active members are sorted by soonest end date.
          </div>
        </>
      )}
    </DashboardPanel>
  );
}
