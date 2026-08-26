import React, { useCallback, useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { green, muted, mutedLight, error, panel2, border } from "../styles/theme.js";
import { useTelegramLink } from "../hooks/useTelegramLink.js";
import NeonButton from "./NeonButton.jsx";

// How often to re-check /telegram/status once a link code has been requested — the user is
// expected to switch to the Telegram app, tap the deep link, and send /start there, all outside
// this page, so there's no event to react to directly; polling is the only option.
const STATUS_POLL_MS = 3000;
const STATUS_POLL_TIMEOUT_MS = 5 * 60 * 1000; // matches the backend's own link-code TTL

// Account-wide opt-in (not tied to any one name) for a personal Telegram DM whenever a name or
// subname owned by the connected wallet sells — on top of, not instead of, the public
// "Subdomain Name Service" channel post every sale already gets. Shown at the top of the owned-
// names screens (both "Manage & Resell" and "Register Subdomain") since that's precisely where a
// wallet is already looking at "my names".
export default function TelegramAlertsCard({ wallet }) {
  const { getStatus, requestLinkCode, unlink } = useTelegramLink();

  const [linked, setLinked] = useState(null); // null = not yet checked
  const [pendingLink, setPendingLink] = useState(null); // { deepLink } while waiting for /start
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const refreshStatus = useCallback(async () => {
    if (!wallet.account) return;
    setLinked(await getStatus(wallet.account));
  }, [wallet.account, getStatus]);

  useEffect(() => {
    setLinked(null);
    setPendingLink(null);
    if (wallet.isConnected && wallet.account) refreshStatus();
  }, [wallet.isConnected, wallet.account, refreshStatus]);

  // While a link code is pending, poll for it having been confirmed (the user completing the
  // /start on Telegram) rather than making them manually refresh once they're done.
  useEffect(() => {
    if (!pendingLink) return;
    const startedAt = Date.now();
    const interval = setInterval(async () => {
      if (Date.now() - startedAt > STATUS_POLL_TIMEOUT_MS) {
        clearInterval(interval);
        return;
      }
      const isLinked = await getStatus(wallet.account);
      if (isLinked) {
        setLinked(true);
        setPendingLink(null);
        clearInterval(interval);
      }
    }, STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [pendingLink, wallet.account, getStatus]);

  const handleEnable = async () => {
    setActionError(null);
    setBusy(true);
    try {
      if (!wallet.isConnected) {
        await wallet.connectWallet();
        return;
      }
      const signer = await wallet.getSigner();
      const { deepLink } = await requestLinkCode(wallet.account, signer);
      setPendingLink({ deepLink });
      window.open(deepLink, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error("Telegram link request failed:", err);
      setActionError(err?.message || "Couldn't start linking — try again");
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setActionError(null);
    setBusy(true);
    try {
      const signer = await wallet.getSigner();
      await unlink(wallet.account, signer);
      setLinked(false);
    } catch (err) {
      console.error("Telegram unlink failed:", err);
      setActionError(err?.message || "Couldn't disable alerts — try again");
    } finally {
      setBusy(false);
    }
  };

  if (!wallet.isConnected) return null;

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      flexWrap: "wrap",
      gap: 12,
      padding: "14px 16px",
      borderRadius: 12,
      background: panel2,
      border: `1px solid ${linked ? green : border}`,
      marginBottom: 20,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        {linked ? <Bell size={18} color={green} /> : <BellOff size={18} color={muted} />}
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>
            {linked ? "Telegram alerts enabled" : "Get notified on Telegram"}
          </div>
          <div style={{ fontSize: 11, color: mutedLight, marginTop: 2 }}>
            {linked
              ? "We'll DM you whenever one of your names or subnames sells."
              : "Get a personal DM the moment one of your names or subnames sells."}
          </div>
          {actionError && (
            <div style={{ fontSize: 11, color: error, marginTop: 4 }}>{actionError}</div>
          )}
        </div>
      </div>

      {pendingLink ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 11, color: mutedLight, textAlign: "right" }}>
            Waiting for confirmation in Telegram...
          </div>
          <a
            href={pendingLink.deepLink}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 12, color: green, textDecoration: "none", borderBottom: `1px solid ${green}`, whiteSpace: "nowrap" }}
          >
            Reopen Telegram
          </a>
        </div>
      ) : linked === null ? (
        <div style={{ fontSize: 11, color: mutedLight }}>Checking...</div>
      ) : linked ? (
        <NeonButton variant="dark" onClick={handleDisable} disabled={busy} style={{ padding: "8px 14px", fontSize: 12, flexShrink: 0 }}>
          {busy ? "Disabling..." : "Disable"}
        </NeonButton>
      ) : (
        <NeonButton variant="green" onClick={handleEnable} disabled={busy} style={{ padding: "8px 14px", fontSize: 12, flexShrink: 0 }}>
          {busy ? "Starting..." : "Enable Telegram Alerts"}
        </NeonButton>
      )}
    </div>
  );
}
