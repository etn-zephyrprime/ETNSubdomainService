import React, { useCallback, useEffect, useRef, useState } from "react";
import { Database, Plus, Trash2, Pencil, X, RefreshCw } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import { PNL_BACKEND_URL } from "../../../config.js";
import { green, orange, muted, mutedLight, border, panel, monoFont, error as errorColor } from "../../theme.js";

// Registry admins only: the App Check registry, edited live — add, change or remove an app (its websites and
// its listed contracts) without running a script. Who's an admin lives in the backend
// (utils/appRegistryAdminRouter.js REGISTRY_ADMINS), which checks the wallet's signature on every request;
// this panel just asks it whether to show itself.
const AUTH_PURPOSE = "Premium Dashboard";
const base = `${PNL_BACKEND_URL}/api/admin/app-registry`;

const input = { background: "#0b0b0b", border: `1px solid ${border}`, borderRadius: 6, color: "#fff", padding: "8px 10px", fontSize: 13, minWidth: 0, boxSizing: "border-box" };
const smallBtn = (color = mutedLight) => ({ display: "inline-flex", alignItems: "center", gap: 4, background: "transparent", border: `1px solid ${border}`, color, borderRadius: 6, padding: "6px 10px", fontFamily: monoFont, fontWeight: 800, fontSize: 11, textTransform: "uppercase", cursor: "pointer" });
const label = { fontFamily: monoFont, fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: mutedLight, margin: "12px 0 6px" };
const emptyApp = () => ({ name: "", category: "dapp", verifiedByUs: false, autoRescan: true, notes: "", hosts: [{ host: "", registrableDomain: true, primary: true }], contracts: [] });

function Editor({ initial, categories, onSave, onCancel, busy }) {
  const [app, setApp] = useState(initial);
  const set = (patch) => setApp((a) => ({ ...a, ...patch }));
  const setHost = (i, patch) => set({ hosts: app.hosts.map((h, j) => (j === i ? { ...h, ...patch } : patch.primary ? { ...h, primary: false } : h)) });
  const setContract = (i, patch) => set({ contracts: app.contracts.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <div style={{ border: `1px solid ${orange}`, borderRadius: 6, padding: 12, marginTop: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input value={app.name} onChange={(e) => set({ name: e.target.value })} placeholder="App name" aria-label="App name" style={{ ...input, flex: "2 1 180px" }} />
        <select value={app.category} onChange={(e) => set({ category: e.target.value })} aria-label="Category" style={{ ...input, flex: "1 1 120px" }}>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: mutedLight, marginTop: 8 }}>
        <input type="checkbox" checked={app.verifiedByUs} onChange={(e) => set({ verifiedByUs: e.target.checked })} /> Our own app (verified by us)
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: mutedLight, marginTop: 4 }}>
        <input type="checkbox" checked={app.autoRescan !== false} onChange={(e) => set({ autoRescan: e.target.checked })} /> Rescan its site automatically (every 6h)
      </label>
      {app.source === "explorer" && <div style={{ fontSize: 11, color: muted, marginTop: 4 }}>Synced from the block explorer's Apps list. Saving here makes it yours — the daily sync won't change or remove it after that.</div>}

      <div style={label}>Websites</div>
      {app.hosts.map((h, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
          <input value={h.host} onChange={(e) => setHost(i, { host: e.target.value })} placeholder="example.com or app.example.com" aria-label="Website host" style={{ ...input, flex: "1 1 200px" }} />
          <label style={{ fontSize: 12, color: mutedLight, display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={h.registrableDomain} onChange={(e) => setHost(i, { registrableDomain: e.target.checked })} /> + subdomains
          </label>
          <label style={{ fontSize: 12, color: mutedLight, display: "flex", gap: 4, alignItems: "center" }}>
            <input type="radio" checked={h.primary} onChange={() => setHost(i, { primary: true })} /> main
          </label>
          <button type="button" onClick={() => set({ hosts: app.hosts.filter((_, j) => j !== i) })} style={smallBtn()} aria-label="Remove website">
            <X size={12} />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => set({ hosts: [...app.hosts, { host: "", registrableDomain: false, primary: false }] })} style={smallBtn()}>
        <Plus size={12} /> Website
      </button>
      <div style={{ fontSize: 11, color: muted, marginTop: 6 }}>"+ subdomains" only for a whole domain you trust (example.com). Free hosting (vercel.app, github.io…) must be the exact site.</div>

      <div style={label}>Contracts (optional)</div>
      {app.contracts.map((c, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
          <input value={c.address} onChange={(e) => setContract(i, { address: e.target.value })} placeholder="0x…" aria-label="Contract address" style={{ ...input, flex: "2 1 260px", fontFamily: monoFont }} />
          <input value={c.role || ""} onChange={(e) => setContract(i, { role: e.target.value })} placeholder="role (router, vault…)" aria-label="Contract role" style={{ ...input, flex: "1 1 120px" }} />
          <button type="button" onClick={() => set({ contracts: app.contracts.filter((_, j) => j !== i) })} style={smallBtn()} aria-label="Remove contract">
            <X size={12} />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => set({ contracts: [...app.contracts, { address: "", role: "" }] })} style={smallBtn()}>
        <Plus size={12} /> Contract
      </button>
      <div style={{ fontSize: 11, color: muted, marginTop: 6 }}>A listed app's badge comes from these contracts. With none listed it shows green (no contracts to check), so add them when you know them.</div>

      <div style={label}>Scanning (optional)</div>
      <input value={app.scanUrl || ""} onChange={(e) => set({ scanUrl: e.target.value })} placeholder="Page to scan, e.g. https://rarible.com/electroneum (default: the main site)" aria-label="Page to scan" style={{ ...input, width: "100%" }} />
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: mutedLight, marginTop: 6 }}>
        <input type="checkbox" checked={app.scanScripts !== false} onChange={(e) => set({ scanScripts: e.target.checked })} /> Also scan the script files the page loads
      </label>
      <div style={{ fontSize: 11, color: muted, marginTop: 4 }}>Untick for a multi-chain app whose code is the same on every chain: only the page itself is read. Only contracts deployed on Electroneum count either way.</div>

      <div style={label}>Notes</div>
      <input value={app.notes || ""} onChange={(e) => set({ notes: e.target.value })} placeholder="Where these facts came from" aria-label="Notes" style={{ ...input, width: "100%" }} />

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button type="button" disabled={busy} onClick={() => onSave(app)} style={{ ...smallBtn("#000"), background: green, border: "none" }}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} style={smallBtn()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function AdminAppRegistryPanel({ wallet, getAuthParams }) {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    if (!wallet?.account) return setIsAdmin(false);
    let live = true;
    fetch(`${base}/access?wallet=${wallet.account}`)
      .then((r) => r.json())
      .then((d) => live && setIsAdmin(!!d.admin))
      .catch(() => live && setIsAdmin(false));
    return () => {
      live = false;
    };
  }, [wallet?.account]);
  const authRef = useRef(getAuthParams);
  authRef.current = getAuthParams;
  const [apps, setApps] = useState(null);
  const [categories, setCategories] = useState(["dapp"]);
  const [editing, setEditing] = useState(null); // slug being edited, "new", or null
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const signed = async () => {
    const { signature, timestamp } = await authRef.current(AUTH_PURPOSE);
    return { wallet: wallet.account, signature, timestamp };
  };
  const call = async (method, path, body) => {
    const auth = await signed();
    const res = method === "GET" ? await fetch(`${base}?${new URLSearchParams({ ...auth, timestamp: String(auth.timestamp) })}`) : await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...auth, ...body }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await call("GET");
      setApps(data.apps);
      setCategories(data.categories || ["dapp"]);
    } catch (e) {
      setError(e.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.account]);

  if (!isAdmin) return null;

  const save = async (app, originalSlug) => {
    setBusy(true);
    setError(null);
    try {
      const data = await call("POST", "", { app: { ...app, slug: originalSlug || undefined } });
      setApps(data.apps);
      setEditing(null);
      setNotice(`${app.name} saved. App Check uses it straight away.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const syncExplorer = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await call("POST", "/sync-explorer", {});
      setApps(data.apps);
      const parts = [data.added.length && `added ${data.added.join(", ")}`, data.updated.length && `updated ${data.updated.join(", ")}`, data.removed.length && `removed ${data.removed.join(", ")}`].filter(Boolean);
      setNotice(parts.length ? `Explorer sync: ${parts.join("; ")}.` : "Explorer sync: nothing new.");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (slug) => {
    setBusy(true);
    setError(null);
    try {
      const data = await call("DELETE", `/${encodeURIComponent(slug)}`, {});
      setApps(data.apps);
      setConfirmDelete(null);
      setNotice("Removed.");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DashboardPanel accent={orange} style={{ borderColor: orange, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: monoFont, fontSize: 12, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: orange }}>
        <Database size={15} /> App registry (admin)
      </div>
      <div style={{ fontSize: 12, color: mutedLight, margin: "6px 0 10px", lineHeight: 1.5 }}>
        The apps App Check knows: a listed site gets "Listed site for …", and sites that imitate it are flagged as lookalikes. Changes apply immediately. Apps on the Electroneum block explorer's Apps page are added automatically every day ("from explorer").
      </div>
      {!apps && (
        <button type="button" onClick={load} style={smallBtn(orange)}>
          Load registry
        </button>
      )}
      {error && <div style={{ color: errorColor, fontSize: 12, marginTop: 8 }}>{error}</div>}
      {notice && <div style={{ color: green, fontSize: 12, marginTop: 8 }}>{notice}</div>}
      {apps && (
        <>
          <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
            {apps.map((a) =>
              editing === a.slug ? (
                <Editor key={a.slug} initial={{ ...a, contracts: a.contracts.map((c) => ({ ...c })), hosts: a.hosts.map((h) => ({ ...h })) }} categories={categories} busy={busy} onSave={(app) => save(app, a.slug)} onCancel={() => setEditing(null)} />
              ) : (
                <div key={a.slug} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: panel, border: `1px solid ${border}`, borderRadius: 6, padding: "8px 10px" }}>
                  <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      {a.name} <span style={{ fontFamily: monoFont, fontSize: 10, color: muted }}>{a.category}</span>
                      {a.source === "explorer" && <span style={{ fontFamily: monoFont, fontSize: 10, color: orange, marginLeft: 6 }}>from explorer</span>}
                      {a.autoRescan === false && <span style={{ fontFamily: monoFont, fontSize: 10, color: muted, marginLeft: 6 }}>scanned on demand</span>}
                      {a.scanUrl && <span style={{ fontFamily: monoFont, fontSize: 10, color: muted, marginLeft: 6 }}>scans {a.scanUrl.replace(/^https?:\/\//, "")}{a.scanScripts === false ? " (page only)" : ""}</span>}
                    </div>
                    <div style={{ fontFamily: monoFont, fontSize: 11, color: muted, overflowWrap: "anywhere" }}>
                      {a.hosts.map((h) => `${h.host}${h.registrableDomain ? " (+subdomains)" : ""}`).join(" · ")} · {a.contracts.length} listed contract{a.contracts.length === 1 ? "" : "s"}
                      {a.scannedContracts ? ` · ${a.scannedContracts} found by scans` : ""}
                    </div>
                  </div>
                  <button type="button" onClick={() => (setEditing(a.slug), setNotice(null))} style={smallBtn()} aria-label={`Edit ${a.name}`}>
                    <Pencil size={12} /> Edit
                  </button>
                  {confirmDelete === a.slug ? (
                    <>
                      <button type="button" disabled={busy} onClick={() => remove(a.slug)} style={smallBtn(errorColor)}>
                        Remove {a.name}?
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(null)} style={smallBtn()}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirmDelete(a.slug)} style={smallBtn()} aria-label={`Remove ${a.name}`}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              )
            )}
          </div>
          {editing === "new" ? (
            <Editor initial={emptyApp()} categories={categories} busy={busy} onSave={(app) => save(app, null)} onCancel={() => setEditing(null)} />
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              <button type="button" onClick={() => (setEditing("new"), setNotice(null))} style={smallBtn(orange)}>
                <Plus size={12} /> Add an app
              </button>
              <button type="button" disabled={busy} onClick={syncExplorer} style={smallBtn()} title="Pull the Electroneum block explorer's Apps list now (it also syncs daily)">
                <RefreshCw size={12} /> {busy ? "Syncing…" : "Sync from explorer"}
              </button>
            </div>
          )}
        </>
      )}
    </DashboardPanel>
  );
}
