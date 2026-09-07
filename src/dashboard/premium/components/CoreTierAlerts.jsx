import React, { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { Bell, BellOff, Trash2 } from "lucide-react";
import DashboardPanel from "./DashboardPanel.jsx";
import DashboardButton from "./DashboardButton.jsx";
import CoreTierGate from "./CoreTierGate.jsx";
import { useCoreTierAccess } from "../../hooks/useCoreTierAccess.js";
import { useWalletAuthSignature } from "../../../hooks/useWalletAuthSignature.js";
import { useNotisTelegramLink } from "../../hooks/useNotisTelegramLink.js";
import { useWalletAlerts } from "../../hooks/useWalletAlerts.js";
import { useTokenPriceAlerts } from "../../hooks/useTokenPriceAlerts.js";
import { green, muted, mutedLight, error as errorColor, border, panel2 } from "../../theme.js";

const AUTH_PURPOSE = "Premium Dashboard"; // same literal every Core tier endpoint signs — one cached signature covers all of them
const STATUS_POLL_MS = 3000;
const STATUS_POLL_TIMEOUT_MS = 5 * 60 * 1000;

const inputStyle = {
  padding: "10px 12px",
  borderRadius: 10,
  border: `1px solid ${border}`,
  background: panel2,
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  boxSizing: "border-box",
  outline: "none",
};
const labelStyle = { fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: muted, marginBottom: 4, display: "block" };
const sectionHeaderStyle = { fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: muted, marginBottom: 10 };

function shortAddr(a) {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

// Core Tier's third feature: Telegram alerts, split into two independent kinds sharing one
// delivery mechanism — the Planet Zephyros Notis bot (notisLinkRouter.js), a DELIBERATELY
// SEPARATE bot identity from the ETN Subdomain Service bot the main site's marketplace sale-alerts
// use (telegramLinkRouter.js/useTelegramLink.js). Don't reuse that hook here even though the
// linking mechanics are identical — see notisLinkRouter.js's own header comment for why an earlier
// version of this feature did exactly that and shipped every alert branded as the wrong bot.
export default function CoreTierAlerts({ wallet, membershipVersion = 0 }) {
  const { hasAccess, accessError, awaitingActivation, manualCheckLoading, active, checkAccessOnce } =
    useCoreTierAccess(wallet, membershipVersion);
  const getAuthParams = useWalletAuthSignature(wallet);
  const { getStatus, requestLinkCode, unlink } = useNotisTelegramLink();
  const { getWalletAlerts, addWalletAlert, removeWalletAlert } = useWalletAlerts();
  const { getTokenPriceAlerts, addTokenPriceAlert, removeTokenPriceAlert } = useTokenPriceAlerts();

  // ---- Telegram link status ----
  const [linked, setLinked] = useState(null);
  const [pendingLink, setPendingLink] = useState(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState(null);

  const refreshLinkStatus = useCallback(async () => {
    if (!wallet.account) return;
    setLinked(await getStatus(wallet.account));
  }, [wallet.account, getStatus]);

  useEffect(() => {
    setLinked(null);
    setPendingLink(null);
    if (hasAccess && wallet.account) refreshLinkStatus();
  }, [hasAccess, wallet.account, refreshLinkStatus]);

  useEffect(() => {
    if (!pendingLink) return;
    const startedAt = Date.now();
    const interval = setInterval(async () => {
      if (Date.now() - startedAt > STATUS_POLL_TIMEOUT_MS) {
        clearInterval(interval);
        return;
      }
      if (await getStatus(wallet.account)) {
        setLinked(true);
        setPendingLink(null);
        clearInterval(interval);
      }
    }, STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [pendingLink, wallet.account, getStatus]);

  const handleLinkEnable = async () => {
    setLinkError(null);
    setLinkBusy(true);
    try {
      const signer = await wallet.getSigner();
      const { deepLink } = await requestLinkCode(wallet.account, signer);
      setPendingLink({ deepLink });
      window.open(deepLink, "_blank", "noopener,noreferrer");
    } catch (err) {
      setLinkError(err?.message || "Couldn't start linking — try again");
    } finally {
      setLinkBusy(false);
    }
  };
  const handleLinkDisable = async () => {
    setLinkError(null);
    setLinkBusy(true);
    try {
      const signer = await wallet.getSigner();
      await unlink(wallet.account, signer);
      setLinked(false);
    } catch (err) {
      setLinkError(err?.message || "Couldn't disable — try again");
    } finally {
      setLinkBusy(false);
    }
  };

  // ---- Wallet alerts ----
  const [walletAlerts, setWalletAlerts] = useState(null);
  const [walletAlertsError, setWalletAlertsError] = useState(null);
  const [waWallet, setWaWallet] = useState("");
  const [waType, setWaType] = useState("balance_threshold");
  const [waDirection, setWaDirection] = useState("above");
  const [waThreshold, setWaThreshold] = useState("");
  const [waDenom, setWaDenom] = useState("ETN");
  const [waBusy, setWaBusy] = useState(false);
  const [waFormError, setWaFormError] = useState(null);

  const loadWalletAlerts = useCallback(async () => {
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const res = await getWalletAlerts(wallet.account, signature, timestamp);
      setWalletAlerts(res.alerts || []);
    } catch (err) {
      setWalletAlertsError(err.message || "Couldn't load wallet alerts");
    }
  }, [getAuthParams, getWalletAlerts, wallet.account]);

  // ---- Token price alerts ----
  const [tokenAlerts, setTokenAlerts] = useState(null);
  const [tokenAlertsError, setTokenAlertsError] = useState(null);
  const [taToken, setTaToken] = useState("");
  const [taDirection, setTaDirection] = useState("up");
  const [taThreshold, setTaThreshold] = useState("");
  const [taDenom, setTaDenom] = useState("USD");
  const [taBusy, setTaBusy] = useState(false);
  const [taFormError, setTaFormError] = useState(null);

  const loadTokenAlerts = useCallback(async () => {
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      const res = await getTokenPriceAlerts(wallet.account, signature, timestamp);
      setTokenAlerts(res.alerts || []);
    } catch (err) {
      setTokenAlertsError(err.message || "Couldn't load token price alerts");
    }
  }, [getAuthParams, getTokenPriceAlerts, wallet.account]);

  useEffect(() => {
    if (!hasAccess) {
      setWalletAlerts(null);
      setTokenAlerts(null);
      return;
    }
    setWalletAlertsError(null);
    setTokenAlertsError(null);
    loadWalletAlerts();
    loadTokenAlerts();
    if (active.length > 0 && !waWallet) setWaWallet(active[0].address);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, active]);

  const submitWalletAlert = async () => {
    setWaFormError(null);
    if (!waWallet) {
      setWaFormError("Track a wallet first — see Core Tier — Portfolio above");
      return;
    }
    const payload = { walletAddress: waWallet, alertType: waType };
    if (waType === "balance_threshold") {
      const value = Number(waThreshold);
      if (!Number.isFinite(value) || value < 0) {
        setWaFormError("Enter a valid threshold amount");
        return;
      }
      if (waDenom !== "ETN" && !ethers.isAddress(waDenom)) {
        setWaFormError("Denomination must be ETN or a valid token address");
        return;
      }
      Object.assign(payload, { direction: waDirection, thresholdValue: value, denomination: waDenom });
    } else if (waThreshold) {
      const value = Number(waThreshold);
      if (!Number.isFinite(value) || value < 0) {
        setWaFormError("Minimum amount must be a valid non-negative number");
        return;
      }
      payload.thresholdValue = value;
    }

    setWaBusy(true);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      await addWalletAlert(wallet.account, signature, timestamp, payload);
      setWaThreshold("");
      await loadWalletAlerts();
    } catch (err) {
      setWaFormError(err.message || "Couldn't create that alert");
    } finally {
      setWaBusy(false);
    }
  };

  const deleteWalletAlert = async (alertId) => {
    setWaBusy(true);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      await removeWalletAlert(wallet.account, signature, timestamp, alertId);
      await loadWalletAlerts();
    } catch (err) {
      setWalletAlertsError(err.message || "Couldn't remove that alert");
    } finally {
      setWaBusy(false);
    }
  };

  const submitTokenAlert = async () => {
    setTaFormError(null);
    if (!ethers.isAddress(taToken)) {
      setTaFormError("Enter a valid token address");
      return;
    }
    const pct = Number(taThreshold);
    if (!Number.isFinite(pct) || pct <= 0) {
      setTaFormError("Enter a valid percentage");
      return;
    }

    setTaBusy(true);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      await addTokenPriceAlert(wallet.account, signature, timestamp, {
        tokenAddress: taToken,
        direction: taDirection,
        thresholdPct: pct,
        denomination: taDenom,
      });
      setTaToken("");
      setTaThreshold("");
      await loadTokenAlerts();
    } catch (err) {
      setTaFormError(err.message || "Couldn't create that alert");
    } finally {
      setTaBusy(false);
    }
  };

  const deleteTokenAlert = async (alertId) => {
    setTaBusy(true);
    try {
      const { signature, timestamp } = await getAuthParams(AUTH_PURPOSE);
      await removeTokenPriceAlert(wallet.account, signature, timestamp, alertId);
      await loadTokenAlerts();
    } catch (err) {
      setTokenAlertsError(err.message || "Couldn't remove that alert");
    } finally {
      setTaBusy(false);
    }
  };

  return (
    <DashboardPanel>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <Bell size={18} color={green} />
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: "#fff" }}>
          Core Tier — Alerts
        </div>
      </div>

      <CoreTierGate
        wallet={wallet}
        hasAccess={hasAccess}
        accessError={accessError}
        awaitingActivation={awaitingActivation}
        manualCheckLoading={manualCheckLoading}
        checkAccessOnce={checkAccessOnce}
        featureDescription="get Telegram alerts for your tracked wallets and any token price move"
      >
        {/* Telegram link */}
        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12,
            padding: "14px 16px", borderRadius: 12, background: panel2, border: `1px solid ${linked ? green : border}`,
            marginBottom: 20,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            {linked ? <Bell size={18} color={green} /> : <BellOff size={18} color={muted} />}
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>
                {linked ? "Planet Zephyros Notis bot connected" : "Connect the Planet Zephyros Notis bot"}
              </div>
              <div style={{ fontSize: 11, color: mutedLight, marginTop: 2 }}>
                {linked
                  ? "Alerts below will DM this chat via @PlanetZephyrosNotisBot — a separate bot from the one used for subname sale alerts."
                  : "Required before any alert below can notify you. This is a separate connection from subname sale alerts."}
              </div>
              {linkError && <div style={{ fontSize: 11, color: errorColor, marginTop: 4 }}>{linkError}</div>}
            </div>
          </div>

          {pendingLink ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 11, color: mutedLight, textAlign: "right" }}>Waiting for confirmation...</div>
              <a href={pendingLink.deepLink} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: green, textDecoration: "none", borderBottom: `1px solid ${green}`, whiteSpace: "nowrap" }}>
                Reopen Telegram
              </a>
            </div>
          ) : linked === null ? (
            <div style={{ fontSize: 11, color: mutedLight }}>Checking...</div>
          ) : linked ? (
            <DashboardButton onClick={handleLinkDisable} disabled={linkBusy} style={{ background: "transparent", border: `1px solid ${border}`, color: mutedLight, boxShadow: "none", padding: "8px 14px", fontSize: 12 }}>
              Disconnect
            </DashboardButton>
          ) : (
            <DashboardButton onClick={handleLinkEnable} disabled={linkBusy} style={{ padding: "8px 14px", fontSize: 12 }}>
              Connect Notis bot
            </DashboardButton>
          )}
        </div>

        {/* Wallet alerts */}
        <div style={{ marginBottom: 24 }}>
          <div style={sectionHeaderStyle}>Wallet Alerts</div>
          {active.length === 0 ? (
            <div style={{ fontSize: 12, color: mutedLight, marginBottom: 12 }}>
              Track a wallet under Core Tier — Portfolio above to set alerts on it.
            </div>
          ) : (
            <>
              {walletAlertsError && <div style={{ fontSize: 12, color: errorColor, marginBottom: 8 }}>{walletAlertsError}</div>}
              {walletAlerts && walletAlerts.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                  {walletAlerts.map((a) => (
                    <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 12px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: `1px solid ${border}` }}>
                      <div style={{ fontSize: 12, color: mutedLight, minWidth: 0 }}>
                        <span style={{ color: "#fff", fontWeight: 700 }}>{shortAddr(a.walletAddress)}</span>
                        {" — "}
                        {a.alertType === "balance_threshold"
                          ? `notify when balance goes ${a.direction} ${a.thresholdValue} ${a.denomination === "ETN" ? "ETN" : shortAddr(a.denomination)}`
                          : `notify on any activity${a.thresholdValue != null ? ` ≥ ${a.thresholdValue} ETN` : ""}`}
                      </div>
                      <button type="button" onClick={() => deleteWalletAlert(a.id)} disabled={waBusy} style={{ background: "none", border: "none", cursor: waBusy ? "not-allowed" : "pointer", padding: 4, flexShrink: 0 }}>
                        <Trash2 size={14} color={mutedLight} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 10, border: `1px dashed ${border}` }}>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 160px" }}>
                    <label style={labelStyle}>Wallet</label>
                    <select value={waWallet} onChange={(e) => setWaWallet(e.target.value)} style={{ ...inputStyle, width: "100%" }}>
                      {active.map((w) => (
                        <option key={w.address} value={w.address}>{shortAddr(w.address)}</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ flex: "1 1 160px" }}>
                    <label style={labelStyle}>Alert type</label>
                    <select value={waType} onChange={(e) => setWaType(e.target.value)} style={{ ...inputStyle, width: "100%" }}>
                      <option value="balance_threshold">Balance threshold</option>
                      <option value="tx_activity">Transaction activity</option>
                    </select>
                  </div>
                </div>

                {waType === "balance_threshold" ? (
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ flex: "1 1 120px" }}>
                      <label style={labelStyle}>Direction</label>
                      <select value={waDirection} onChange={(e) => setWaDirection(e.target.value)} style={{ ...inputStyle, width: "100%" }}>
                        <option value="above">Goes above</option>
                        <option value="below">Goes below</option>
                      </select>
                    </div>
                    <div style={{ flex: "1 1 120px" }}>
                      <label style={labelStyle}>Amount</label>
                      <input type="number" min="0" value={waThreshold} onChange={(e) => setWaThreshold(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
                    </div>
                    <div style={{ flex: "1 1 160px" }}>
                      <label style={labelStyle}>Denomination</label>
                      <input type="text" placeholder="ETN or 0x... token" value={waDenom} onChange={(e) => setWaDenom(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
                    </div>
                  </div>
                ) : (
                  <div>
                    <label style={labelStyle}>Minimum amount (ETN, optional — leave blank for any activity)</label>
                    <input type="number" min="0" value={waThreshold} onChange={(e) => setWaThreshold(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
                  </div>
                )}

                {waFormError && <div style={{ fontSize: 12, color: errorColor }}>{waFormError}</div>}
                <DashboardButton onClick={submitWalletAlert} disabled={waBusy || !linked} style={{ alignSelf: "flex-start", padding: "8px 16px", fontSize: 12 }}>
                  {!linked ? "Connect Notis bot first" : "Add alert"}
                </DashboardButton>
              </div>
            </>
          )}
        </div>

        {/* Token price alerts */}
        <div>
          <div style={sectionHeaderStyle}>Token Price Alerts</div>
          {tokenAlertsError && <div style={{ fontSize: 12, color: errorColor, marginBottom: 8 }}>{tokenAlertsError}</div>}
          {tokenAlerts && tokenAlerts.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
              {tokenAlerts.map((a) => (
                <div key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 12px", borderRadius: 10, background: "rgba(255,255,255,0.03)", border: `1px solid ${border}` }}>
                  <div style={{ fontSize: 12, color: mutedLight, minWidth: 0 }}>
                    <span style={{ color: "#fff", fontWeight: 700 }}>{shortAddr(a.tokenAddress)}</span>
                    {` — notify when ${a.direction} ${a.thresholdPct}% (${a.denomination})`}
                  </div>
                  <button type="button" onClick={() => deleteTokenAlert(a.id)} disabled={taBusy} style={{ background: "none", border: "none", cursor: taBusy ? "not-allowed" : "pointer", padding: 4, flexShrink: 0 }}>
                    <Trash2 size={14} color={mutedLight} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 10, border: `1px dashed ${border}` }}>
            <div>
              <label style={labelStyle}>Token address</label>
              <input type="text" placeholder="0x..." value={taToken} onChange={(e) => setTaToken(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 120px" }}>
                <label style={labelStyle}>Direction</label>
                <select value={taDirection} onChange={(e) => setTaDirection(e.target.value)} style={{ ...inputStyle, width: "100%" }}>
                  <option value="up">Up</option>
                  <option value="down">Down</option>
                </select>
              </div>
              <div style={{ flex: "1 1 100px" }}>
                <label style={labelStyle}>Move (%)</label>
                <input type="number" min="0" step="0.1" value={taThreshold} onChange={(e) => setTaThreshold(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
              </div>
              <div style={{ flex: "1 1 120px" }}>
                <label style={labelStyle}>Denomination</label>
                <select value={taDenom} onChange={(e) => setTaDenom(e.target.value)} style={{ ...inputStyle, width: "100%" }}>
                  <option value="USD">USD</option>
                  <option value="ETN">ETN</option>
                </select>
              </div>
            </div>
            {taFormError && <div style={{ fontSize: 12, color: errorColor }}>{taFormError}</div>}
            <DashboardButton onClick={submitTokenAlert} disabled={taBusy || !linked} style={{ alignSelf: "flex-start", padding: "8px 16px", fontSize: 12 }}>
              {!linked ? "Connect Notis bot first" : "Add alert"}
            </DashboardButton>
          </div>
        </div>
      </CoreTierGate>
    </DashboardPanel>
  );
}
