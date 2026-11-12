import React, { useState } from "react";
import { Globe, Loader2 } from "lucide-react";
import AppCheckResult, { RegistryRequestLink } from "./AppCheckResult.jsx";
import { useAppCheck } from "../hooks/useAppCheck.js";
import { green, gold, muted, mutedLight, border, panel2, monoFont, error as errorColor } from "../theme.js";

// The free App Check: "is this site pretending to be a known app?" — the lookalike check only, no wallet.
// Core Tier adds the domain facts, the contracts the site uses, scanning and watching (CoreTierAppCheck.jsx).

const btn = { background: green, color: "#000", border: "none", borderRadius: 6, padding: "0 16px", fontFamily: monoFont, fontWeight: 800, fontSize: 12, textTransform: "uppercase", cursor: "pointer", minHeight: 44 };

export default function AppCheckFree() {
  const { check } = useAppCheck();
  const [q, setQ] = useState("");
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async (input = q) => {
    if (!input.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setR(await check(null, input.trim()));
    } catch (e) {
      setError(e.message);
      setR(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={{ background: panel2, border: `1px solid ${border}`, borderRadius: 6, padding: 14, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: monoFont, fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: green, marginBottom: 6 }}>
        <Globe size={14} /> Check a website before you connect
      </div>
      <div style={{ fontSize: 13, color: mutedLight, marginBottom: 10, lineHeight: 1.5 }}>Paste a link someone sent you. Argus tells you if it's pretending to be a known Electroneum app.</div>
      <RegistryRequestLink style={{ marginBottom: 10 }} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="https://… or app name"
          aria-label="Website address or app name"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          style={{ flex: 1, minWidth: 0, background: "#0b0b0b", border: `1px solid ${border}`, borderRadius: 6, color: "#fff", padding: "0 12px", fontSize: 14, minHeight: 44 }}
        />
        <button type="submit" disabled={busy} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>
          {busy ? <Loader2 size={16} /> : "Check"}
        </button>
      </form>
      {error && <div style={{ color: errorColor, fontSize: 13, marginTop: 10 }}>{error}</div>}
      {r?.status === "name" && (
        <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
          <div style={{ fontSize: 13, color: mutedLight }}>{r.overallReason}</div>
          {r.apps.map((a) => (
            <button key={a.slug} type="button" onClick={() => (setQ(a.primaryHost), run(a.primaryHost))} style={{ background: "transparent", border: `1px solid ${border}`, borderRadius: 6, color: "#fff", padding: "8px 12px", textAlign: "left", cursor: "pointer" }}>
              {a.name} <span style={{ fontFamily: monoFont, fontSize: 11, color: muted }}>{a.primaryHost}</span>
            </button>
          ))}
        </div>
      )}
      {r && r.status !== "name" && (
        <div style={{ marginTop: 14 }}>
          <AppCheckResult
            r={r}
            freeNote={
              r.status !== "lookalike" ? (
                <div style={{ fontSize: 12, color: gold, marginTop: 12 }}>
                  Core Tier checks this site's domain and the contracts it uses, and can scan and watch it. <a href="/premium" style={{ color: gold }}>See Core Tier</a>
                </div>
              ) : null
            }
          />
        </div>
      )}
    </section>
  );
}
