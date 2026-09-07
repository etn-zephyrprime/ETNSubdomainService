import { useCallback } from "react";
import { signNotisLinkRequest } from "../../utils/notisLinkAuth.js";
import { PNL_BACKEND_URL } from "../../config.js";

// Talks to backend/utils/notisLinkRouter.js — the Planet Zephyros Notis bot, used ONLY by Core
// tier alerts (CoreTierAlerts.jsx). Deliberately separate from src/hooks/useTelegramLink.js, which
// talks to the ETN Subdomain Service bot for marketplace sale-alerts — see notisLinkRouter.js's own
// header comment for why the two must not be conflated.
export function useNotisTelegramLink() {
  const getStatus = useCallback(async (address) => {
    if (!address) return false;
    try {
      const res = await fetch(`${PNL_BACKEND_URL}/api/notis/status?address=${address}`);
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean(data?.linked);
    } catch (err) {
      console.warn("Notis link status check failed:", err.message);
      return false;
    }
  }, []);

  // Returns { code, deepLink, expiresInMs } — deepLink opens Telegram straight to the Notis bot
  // with the code pre-filled as its /start payload.
  const requestLinkCode = useCallback(async (address, signer) => {
    const { timestamp, signature } = await signNotisLinkRequest(signer, address);
    const res = await fetch(`${PNL_BACKEND_URL}/api/notis/request-link-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, timestamp, signature }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || "Couldn't request a link code");
    return data;
  }, []);

  const unlink = useCallback(async (address, signer) => {
    const { timestamp, signature } = await signNotisLinkRequest(signer, address);
    const res = await fetch(`${PNL_BACKEND_URL}/api/notis/unlink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, timestamp, signature }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || "Couldn't unlink");
    return data;
  }, []);

  return { getStatus, requestLinkCode, unlink };
}
