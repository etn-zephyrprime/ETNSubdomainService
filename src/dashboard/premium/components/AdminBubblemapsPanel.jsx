import React, { useCallback, useEffect, useRef, useState } from "react";
import { Network, RefreshCw, Trash2 } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import { PNL_BACKEND_URL } from "../../../config.js";
import { orange, green, muted, mutedLight, border, panel, panel2, monoFont, error as errorColor } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";
const BASE = `${PNL_BACKEND_URL}/api/admin/bubblemaps`;
const inputStyle = { background: "#0b0b0b", border: `1px solid ${border}`, borderRadius: 6, color: "#fff", padding: "8px 10px", fontSize: 12, minWidth: 0, boxSizing: "border-box" };
const buttonStyle = (color = mutedLight) => ({ display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${border}`, borderRadius: 6, background: panel2, color, padding: "6px 9px", fontFamily: monoFont, fontSize: 10, fontWeight: 800, cursor: "pointer" });

export default function AdminBubblemapsPanel({ wallet, getAuthParams }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [overrides, setOverrides] = useState(null);
  const [report, setReport] = useState(null);
  const [progress, setProgress] = useState(null);
  const [address, setAddress] = useState("");
  const [type, setType] = useState("hub");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const authRef = useRef(getAuthParams);
  authRef.current = getAuthParams;

  useEffect(() => {
    if (!wallet?.account) {
      setIsAdmin(false);
      setOverrides(null);
      return;
    }
    let active = true;
    fetch(`${BASE}/access?wallet=${encodeURIComponent(wallet.account)}`)
      .then((response) => response.json())
      .then((data) => active && setIsAdmin(Boolean(data.admin)))
      .catch(() => active && setIsAdmin(false));
    return () => {
      active = false;
    };
  }, [wallet?.account]);

  const signed = useCallback(async () => {
    const auth = await authRef.current("Premium Dashboard");
    return { wallet: wallet.account, signature: auth.signature, timestamp: String(auth.timestamp) };
  }, [wallet?.account]);

  const call = useCallback(async (method, path = "", body = {}) => {
    const auth = await signed();
    const url = `${BASE}${path}`;
    const response = method === "GET"
      ? await fetch(`${url}?${new URLSearchParams(auth)}`)
      : await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...auth, ...body }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }, [signed]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [overridesData, calibrationData] = await Promise.all([
        call("GET", "/overrides"),
        call("GET", "/calibration"),
      ]);
      setOverrides(overridesData.overrides || []);
      setReport(calibrationData.report);
      setProgress(calibrationData.progress);
    } catch (err) {
      setError(err.message || "Couldn't load Bubblemaps administration");
    }
  }, [call]);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("POST", "/overrides", { address, type, label });
      setAddress("");
      setLabel("");
      setNotice("Override saved. Cached maps are queued for recalculation.");
      await load();
    } catch (err) {
      setError(err.message || "Couldn't save the override");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target) => {
    setBusy(true);
    setError(null);
    try {
      await call("DELETE", `/overrides/${encodeURIComponent(target)}`);
      setNotice("Override removed. Cached maps are queued for recalculation.");
      await load();
    } catch (err) {
      setError(err.message || "Couldn't remove the override");
    } finally {
      setBusy(false);
    }
  };

  if (!isAdmin) return null;

  return (
    <DashboardPanel accent={orange} style={{ borderColor: orange, marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: orange, fontFamily: monoFont, fontWeight: 800, fontSize: 12, textTransform: "uppercase" }}>
          <Network size={15} /> Bubblemaps overrides & calibration
        </div>
        <button type="button" onClick={load} disabled={busy} style={buttonStyle()}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      <div style={{ color: muted, fontSize: 11, lineHeight: 1.5, margin: "7px 0 10px" }}>
        Label hubs, entities, ignored addresses, or explicitly included contracts. Changes apply without a redeploy.
      </div>
      {!overrides && (
        <button type="button" onClick={load} style={buttonStyle(orange)}>Load administration data</button>
      )}
      {error && <div role="alert" style={{ color: errorColor, fontSize: 12, marginTop: 8 }}>{error}</div>}
      {notice && <div style={{ color: green, fontSize: 11, marginTop: 8 }}>{notice}</div>}

      {overrides && (
        <>
          <form onSubmit={save} style={{ display: "grid", gridTemplateColumns: "minmax(190px,2fr) minmax(125px,1fr) minmax(120px,1fr) auto", gap: 7, margin: "12px 0" }}>
            <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="0x address" aria-label="Address" style={{ ...inputStyle, fontFamily: monoFont }} />
            <select value={type} onChange={(event) => setType(event.target.value)} aria-label="Override type" style={inputStyle}>
              <option value="hub">Hub</option>
              <option value="not_hub">Not a hub</option>
              <option value="entity">Entity</option>
              <option value="ignore">Ignore</option>
              <option value="include">Include contract</option>
            </select>
            <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={type === "entity" ? "Entity label" : "Optional label"} aria-label="Override label" maxLength={80} style={inputStyle} />
            <button type="submit" disabled={busy} style={buttonStyle(orange)}>{busy ? "Saving…" : "Save"}</button>
          </form>

          <div style={sectionTitle}>Address overrides ({overrides.length})</div>
          {overrides.length === 0 ? (
            <div style={{ color: muted, fontSize: 11 }}>No overrides have been added.</div>
          ) : (
            <div style={{ display: "grid", gap: 5, marginBottom: 14 }}>
              {overrides.map((entry) => (
                <div key={entry.address} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", padding: "7px 8px", border: `1px solid ${border}`, borderRadius: 6, background: panel }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: "#fff", fontSize: 11, fontFamily: monoFont, overflowWrap: "anywhere" }}>{entry.address}</div>
                    <div style={{ color: muted, fontSize: 10 }}>{entry.type}{entry.label ? ` · ${entry.label}` : ""}</div>
                  </div>
                  <button type="button" disabled={busy} onClick={() => remove(entry.address)} style={buttonStyle(errorColor)} aria-label={`Remove override for ${entry.address}`}>
                    <Trash2 size={12} /> Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={sectionTitle}>Backfill progress</div>
          <div style={{ color: mutedLight, fontSize: 11, marginBottom: 8 }}>
            {progress
              ? `${progress.maps_ready || 0}/${progress.total_tokens || 0} maps ready · ${progress.holders_ready || 0} holder sets · ${progress.transfers_ready || 0} transfer histories · ${progress.maps_dirty || 0} maps queued`
              : "Worker progress is not available yet."}
          </div>
          {report?.top_hubs?.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={sectionTitle}>Top observed hubs</div>
              {report.top_hubs.map((hub) => (
                <div key={hub.address} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10, color: muted, padding: "3px 0" }}>
                  <span>{hub.label || hub.address}</span><span>{hub.degree} counterparties</span>
                </div>
              ))}
            </div>
          )}
          {report?.tokens?.length > 0 && (
            <div style={{ overflowX: "auto", maxHeight: 320, border: `1px solid ${border}`, borderRadius: 6 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, minWidth: 760 }}>
                <thead>
                  <tr>{["Token", "Score", "Holders", "Clusters", "Largest cluster", "Edges by type"].map((item) => <th key={item} style={tableCell}>{item}</th>)}</tr>
                </thead>
                <tbody>
                  {report.tokens.map((token) => (
                    <tr key={token.token}>
                      <td style={tableCell}>{token.symbol || token.name || token.token}</td>
                      <td style={tableCell}>{token.score ?? "—"}</td>
                      <td style={tableCell}>{token.holders_considered}</td>
                      <td style={tableCell}>{token.cluster_count}</td>
                      <td style={tableCell}>{token.largest_cluster_holder_share_pct}% holders · {token.largest_cluster_supply_pct}% supply</td>
                      <td style={{ ...tableCell, whiteSpace: "normal", minWidth: 150 }}>
                        {Object.entries(token.edge_counts || {}).map(([type, count]) => `${type}: ${count}`).join(" · ") || "None"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </DashboardPanel>
  );
}

const sectionTitle = { color: muted, fontFamily: monoFont, fontSize: 10, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", margin: "10px 0 6px" };
const tableCell = { textAlign: "left", padding: "6px 8px", color: mutedLight, borderBottom: `1px solid ${border}`, whiteSpace: "nowrap" };
