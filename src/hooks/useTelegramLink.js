import { useCallback } from "react";
import { signTelegramLinkRequest } from "../utils/telegramLinkAuth.js";
import { BACKEND_IMAGE_URL } from "../config.js";

// Talks to backend/utils/telegramLinkRouter.js — lets a connected wallet opt in to a personal
// Telegram DM whenever one of its names/subnames sells, on top of the public channel post
// marketplaceWatcher.js always makes. See that router's own header comment for the full linking
// flow (request a code -> open a Telegram deep link -> the bot's webhook confirms it).
export function useTelegramLink() {
  const getStatus = useCallback(async (address) => {
    if (!address) return false;
    try {
      const res = await fetch(`${BACKEND_IMAGE_URL}/api/telegram/status?address=${address}`);
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean(data?.linked);
    } catch (err) {
      console.warn("Telegram link status check failed:", err.message);
      return false;
    }
  }, []);

  // Returns { code, deepLink, expiresInMs } — deepLink opens Telegram straight to the bot with
  // the code pre-filled as its /start payload.
  const requestLinkCode = useCallback(async (address, signer) => {
    const { timestamp, signature } = await signTelegramLinkRequest(signer, address);
    const res = await fetch(`${BACKEND_IMAGE_URL}/api/telegram/request-link-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, timestamp, signature }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || "Couldn't request a link code");
    return data;
  }, []);

  const unlink = useCallback(async (address, signer) => {
    const { timestamp, signature } = await signTelegramLinkRequest(signer, address);
    const res = await fetch(`${BACKEND_IMAGE_URL}/api/telegram/unlink`, {
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
