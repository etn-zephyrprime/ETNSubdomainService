import React, { useCallback, useEffect, useState } from "react";
import DashboardButton from "./DashboardButton.jsx";
import { usePositionAlerts } from "../../hooks/usePositionAlerts.js";
import { muted, mutedLight, error as errorColor, border, green, panel2, monoFont } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard";
const DEFAULT_IL_THRESHOLD = 5;

const sectionHeaderStyle = { fontFamily: monoFont, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 };
// Same look as CoreTierAlerts.jsx's own inputStyle, compacted to sit inline in a row.
const inputStyle = { padding: "6px 8px", borderRadius: 6, border: `1px solid ${border}`, background: panel2, color: "#fff", fontFamily: monoFont, fontSize: 12, fontWeight: 600, boxSizing: "border-box", outline: "none", width: 70 };

const TYPES = [
  { type: "il_threshold", title: "Impermanent loss", describe: (a, rearm) => `When any LP or farm position's impermanent loss reaches −${a.thresholdPct}% (fires again after it recovers to −${a.thresholdPct - rearm}%)` },
  { type: "v3_out_of_range", title: "V3 out of range", describe: () => "When a V3 position leaves its price range (and when it's back)" },
  { type: "farm_multiplier", title: "Farm multiplier milestones", describe: () => "When a farm position's duration multiplier passes 1.25×, 1.5×, 1.75×, 2×, 2.25× or the 2.5× maximum" },
];

/** Core tier's position health alerts (backend/utils/positionAlertScheduler.js) — one switch per
 * alert type, covering every position across the member's tracked wallets. Rendered inside
 * CoreTierAlerts.jsx, which owns the access check and the Telegram link status. */
export default function PositionAlertsSection({ wallet, getAuthParams, hasAccess, active, linked }) {
  const { getPositionAlerts, savePositionAlert, removePositionAlert } = usePositionAlerts();
  const [alerts, setAlerts] = useState(null);
  const [limits, setLimits] = useState({ ilRearmPoints: 2, minIlThresholdPct: 2.5, maxIlThresholdPct: 90 });
  const [ilInput, setIlInput] = useState(String(DEFAULT_IL_THRESHOLD));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const res = await getPositionAlerts(wallet.account, signature, timestamp);
      setAlerts(res.alerts || []);
      setLimits({ ilRearmPoints: res.ilRearmPoints ?? 2, minIlThresholdPct: res.minIlThresholdPct ?? 2.5, maxIlThresholdPct: res.maxIlThresholdPct ?? 90 });
      const il = (res.alerts || []).find((a) => a.alertType === "il_threshold");
      if (il) setIlInput(String(il.thresholdPct));
    } catch (err) {
      setError(err.message || "Couldn't load position alerts");
    }
  }, [getAuthParams, getPositionAlerts, wallet.account]);

  useEffect(() => {
    if (!hasAccess) {
      setAlerts(null);
      return;
    }
    setError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, active]);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      await fn(signature, timestamp);
      await load();
    } catch (err) {
      setError(err.message || "Couldn't save that alert");
    } finally {
      setBusy(false);
    }
  };

  const enable = (type) => {
    if (type === "il_threshold") {
      const pct = Number(ilInput);
      if (!Number.isFinite(pct) || pct < limits.minIlThresholdPct || pct > limits.maxIlThresholdPct) {
        setError(`Enter a loss between ${limits.minIlThresholdPct}% and ${limits.maxIlThresholdPct}%`);
        return;
      }
      return run((s, t) => savePositionAlert(wallet.account, s, t, { alertType: type, thresholdPct: pct }));
    }
    return run((s, t) => savePositionAlert(wallet.account, s, t, { alertType: type }));
  };
  const disable = (alert) => run((s, t) => removePositionAlert(wallet.account, s, t, alert.id));

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={sectionHeaderStyle}>Position Alerts</div>
      {active.length === 0 ? (
        <div style={{ fontSize: 12, color: mutedLight, marginBottom: 12 }}>Track a wallet under Core Tier — Portfolio above to alert on its liquidity and farm positions.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {error && <div style={{ fontSize: 12, color: errorColor }}>{error}</div>}
          {TYPES.map(({ type, title, describe }) => {
            const alert = (alerts || []).find((a) => a.alertType === type) || null;
            const isIl = type === "il_threshold";
            const ilChanged = isIl && alert && Number(ilInput) !== alert.thresholdPct;
            return (
              <div key={type} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", padding: "8px 12px", borderRadius: 4, background: "rgba(255,255,255,0.03)", border: `1px solid ${alert ? green : border}` }}>
                <div style={{ fontSize: 12, color: mutedLight, minWidth: 0, flex: "1 1 240px" }}>
                  <div style={{ color: "#fff", fontWeight: 700, marginBottom: 2 }}>
                    {title} {alert && <span style={{ color: green, fontSize: 10, fontWeight: 700, marginLeft: 4 }}>ON</span>}
                  </div>
                  {alert ? describe(alert, limits.ilRearmPoints) : describe({ thresholdPct: Number(ilInput) || DEFAULT_IL_THRESHOLD }, limits.ilRearmPoints)}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {isIl && (
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: muted }}>
                      −<input type="number" min={limits.minIlThresholdPct} max={limits.maxIlThresholdPct} step="0.5" value={ilInput} onChange={(e) => setIlInput(e.target.value)} style={inputStyle} />%
                    </label>
                  )}
                  {ilChanged && (
                    <DashboardButton onClick={() => enable(type)} disabled={busy || !linked} style={{ padding: "6px 12px", fontSize: 11 }}>
                      Update
                    </DashboardButton>
                  )}
                  <DashboardButton onClick={() => (alert ? disable(alert) : enable(type))} disabled={busy || (!alert && !linked)} style={{ padding: "6px 12px", fontSize: 11 }}>
                    {alert ? "Turn off" : !linked ? "Connect Notis bot first" : "Turn on"}
                  </DashboardButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
