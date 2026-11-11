import React, { useCallback, useEffect, useRef, useState } from "react";
import { Globe, Loader2, RefreshCw, Eye, EyeOff, ScanSearch } from "lucide-react";
import AppCheckResult from "../../components/AppCheckResult.jsx";
import { useContractCard } from "./ContractCard.jsx";
import { useAppCheck } from "../../hooks/useAppCheck.js";
import { green, muted, mutedLight, border, panel2, monoFont, error as errorColor } from "../../theme.js";

// "Check an app" in the Core Tier Contract Check panel: the full App Check — status, overall badge, domain
// facts, the app's contracts (each opens the contract card), Scan this site / Rescan (10 scans a day),
// Watch this app (Telegram alerts when its contracts change), and its recent changes.
// A ?app=<origin> link (Telegram /checkapp cards and alerts) opens straight on that site.
const AUTH_PURPOSE = "Premium Dashboard";

const actionBtn = (primary) => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  background: primary ? green : "transparent",
  color: primary ? "#000" : mutedLight,
  border: primary ? "none" : `1px solid ${border}`,
  borderRadius: 6,
  padding: "8px 12px",
  fontFamily: monoFont,
  fontWeight: 800,
  fontSize: 11,
  textTransform: "uppercase",
  cursor: "pointer",
  minHeight: 36,
});

export default function CoreTierAppCheck({ getAuthParams, initialInput = null }) {
  const { check, scan, follow, getFollows } = useAppCheck();
  const card = useContractCard();
  const authRef = useRef(getAuthParams);
  authRef.current = getAuthParams;
  const [q, setQ] = useState(initialInput || "");
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(null); // "check" | "scan" | "watch"
  const [error, setError] = useState(null);
  const [follows, setFollows] = useState([]);
  const [scansLeft, setScansLeft] = useState(null);

  const auth = () => authRef.current(AUTH_PURPOSE);
  const run = useCallback(
    async (kind, input, rescan = false) => {
      const value = (input ?? "").trim();
      if (!value) return;
      setBusy(kind);
      setError(null);
      try {
        const a = await authRef.current(AUTH_PURPOSE);
        const res = kind === "scan" ? await scan(a, value, rescan) : await check(a, value);
        if (res.scansLeft != null) setScansLeft(res.scansLeft);
        setR(res);
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(null);
      }
    },
    [check, scan]
  );

  useEffect(() => {
    if (initialInput) run("check", initialInput);
    (async () => {
      try {
        setFollows(await getFollows(await authRef.current(AUTH_PURPOSE)));
      } catch {
        /* the watch button just starts unknown */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const origin = r?.normalised?.origin;
  const watching = origin && follows.some((f) => f.origin === origin);
  const toggleWatch = async () => {
    setBusy("watch");
    setError(null);
    try {
      const res = await follow(await auth(), origin, !watching);
      setFollows(res.follows || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const actions =
    r && r.status !== "invalid" && r.status !== "name" ? (
      <>
        {!r.scan ? (
          <button type="button" disabled={!!busy} onClick={() => run("scan", origin || q)} style={actionBtn(true)}>
            <ScanSearch size={14} /> Scan this site
          </button>
        ) : (
          <button type="button" disabled={!!busy} onClick={() => run("scan", origin || q, true)} style={actionBtn(false)}>
            <RefreshCw size={14} /> Rescan
          </button>
        )}
        {r.status !== "lookalike" && (
          <button type="button" disabled={!!busy} onClick={toggleWatch} style={actionBtn(false)}>
            {watching ? <EyeOff size={14} /> : <Eye size={14} />} {watching ? "Stop watching" : "Watch this app"}
          </button>
        )}
      </>
    ) : null;

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run("check", q);
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, background: panel2, border: `1px solid ${border}`, borderRadius: 6, padding: "0 12px" }}>
          <Globe size={16} color={muted} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Website address or app name"
            aria-label="Check an app"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "#fff", padding: "12px 0", fontSize: 14 }}
          />
          {busy === "check" && <Loader2 size={16} color={muted} />}
        </div>
        <button type="submit" disabled={!!busy} style={actionBtn(true)}>
          Check
        </button>
      </form>
      {error && <div style={{ color: errorColor, fontSize: 13, marginTop: 10 }}>{error}</div>}
      {busy === "scan" && <div style={{ fontSize: 13, color: mutedLight, marginTop: 10 }}>Scanning the site's code and checking each contract — this can take a minute or two the first time…</div>}
      {r?.status === "name" && (
        <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
          <div style={{ fontSize: 13, color: mutedLight }}>{r.overallReason}</div>
          {r.apps.map((a) => (
            <button key={a.slug} type="button" onClick={() => (setQ(a.primaryHost), run("check", a.primaryHost))} style={{ background: "transparent", border: `1px solid ${border}`, borderRadius: 6, color: "#fff", padding: "8px 12px", textAlign: "left", cursor: "pointer" }}>
              {a.name} <span style={{ fontFamily: monoFont, fontSize: 11, color: muted }}>{a.primaryHost}</span>
            </button>
          ))}
        </div>
      )}
      {r && r.status !== "name" && (
        <div style={{ marginTop: 14 }}>
          <AppCheckResult r={r} onOpenContract={(address, hint) => card.open(address, hint)} actions={actions} />
          {scansLeft != null && <div style={{ fontSize: 11, color: muted, marginTop: 6 }}>{scansLeft} site scan{scansLeft === 1 ? "" : "s"} left today</div>}
        </div>
      )}
    </div>
  );
}
