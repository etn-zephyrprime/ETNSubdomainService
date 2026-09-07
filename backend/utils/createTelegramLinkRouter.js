// backend/utils/createTelegramLinkRouter.js
//
// Factory behind BOTH telegramLinkRouter.js (the ETN Subdomain Service bot — marketplace sale
// alerts) and notisLinkRouter.js (the Planet Zephyros Notis bot — Core tier wallet/token price
// alerts, see migrations/009_alerts.sql). Same signed-deep-link-plus-webhook flow, genuinely
// SHARED here rather than copy-pasted per bot: this is security-sensitive signature-verification
// code, and this codebase already has one documented incident (primaryNameResolver.js's own header
// comment) of two hand-copied files silently drifting apart under a "keep these in sync" comment
// alone — worth avoiding by construction this time, unlike coreClashTelegram.js's deliberately
// separate group-posting bots (that file only ever sends, it has no per-user signature/webhook
// logic to keep in sync in the first place).
//
// Each instantiation gets its own bot token, R2 state store, and route prefix — see
// telegramLinkRouter.js/notisLinkRouter.js for the two current instances. `purpose` is folded into
// the signed message (same reasoning as walletAuth.js's own `purpose` param) so a signature for one
// bot's link is legibly distinct from the other's, even though nothing currently depends on that
// distinction being enforced (either signature only ever proves "I own this address").
import express from "express";
import { ethers } from "ethers";
import crypto from "crypto";

const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;

/**
 * `config`:
 *   - botToken, webhookSecret (optional), backendPublicUrl, botUsername (optional pre-set)
 *   - getState()/setState(state) — R2-backed { pendingLinks, subscriptions } store, own key per bot
 *   - purpose — folded into the signed message; must match the frontend's own message-builder
 *     byte-for-byte (see telegramLinkAuth.js / notisLinkAuth.js)
 *   - routeBase — mounted paths become `/<routeBase>/request-link-code`, `/<routeBase>/unlink`,
 *     `/<routeBase>/status`, `/<routeBase>/webhook`
 *   - onLinked(address, chatId, sendDirectMessage) — sends the confirmation DM once a link
 *     completes; each bot's own wording, since what they're confirming differs
 *   - extraConfigured() — optional additional "is this deployment fully configured" check (e.g. R2
 *     credentials), ANDed with `botToken` being set
 */
export function createTelegramLinkRouter(config) {
  const { botToken, webhookSecret, backendPublicUrl, getState, setState, purpose, routeBase, onLinked, extraConfigured } = config;

  function buildMessage(address, timestamp) {
    return `Link ${purpose} for wallet ${address.toLowerCase()} at ${timestamp}`;
  }

  function verifyWalletSignature(address, timestamp, signature) {
    if (!address || !ethers.isAddress(address)) return null;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
    if (!signature || typeof signature !== "string") return null;

    const now = Date.now();
    if (timestamp > now + MAX_CLOCK_SKEW_MS || now - timestamp > MAX_SIGNATURE_AGE_MS) return null;

    try {
      const recovered = ethers.verifyMessage(buildMessage(address, timestamp), signature);
      return recovered.toLowerCase() === address.toLowerCase() ? recovered.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  function pruneExpiredCodes(pendingLinks) {
    const now = Date.now();
    const pruned = {};
    for (const [code, entry] of Object.entries(pendingLinks)) {
      if (now - entry.createdAt < LINK_CODE_TTL_MS) pruned[code] = entry;
    }
    return pruned;
  }

  let cachedBotUsername = config.botUsername || null;
  async function getBotUsername() {
    if (cachedBotUsername) return cachedBotUsername;
    if (!botToken) return null;
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const data = await res.json();
      if (data?.ok && data.result?.username) cachedBotUsername = data.result.username;
    } catch (err) {
      console.warn(`⚠️  Failed to fetch Telegram bot username (${routeBase}):`, err.message);
    }
    return cachedBotUsername;
  }

  async function sendDirectMessage(chatId, text) {
    if (!botToken) {
      console.warn(`ℹ️  Telegram (${routeBase}) not configured — skipping direct message`);
      return null;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(`Telegram API error: ${data?.description || res.statusText}`);
      return data;
    } catch (err) {
      console.warn(`⚠️  Failed to DM Telegram chat ${chatId} (${routeBase}):`, err.message);
      return null; // non-fatal — same convention telegramNotifier.js's own sendTelegramDirectMessage uses
    }
  }

  function isConfigured() {
    return Boolean(botToken) && (extraConfigured ? extraConfigured() : true);
  }

  const router = express.Router();

  router.post(`/${routeBase}/request-link-code`, async (req, res) => {
    if (!isConfigured()) {
      return res.status(503).json({ error: "Telegram alerts aren't configured on this deployment" });
    }
    const { address, timestamp, signature } = req.body;
    const verified = verifyWalletSignature(address, timestamp, signature);
    if (!verified) return res.status(401).json({ error: "Invalid or expired signature" });

    const botUsername = await getBotUsername();
    if (!botUsername) return res.status(503).json({ error: "Couldn't reach Telegram — try again shortly" });

    const code = crypto.randomBytes(6).toString("hex");
    const state = await getState();
    state.pendingLinks = pruneExpiredCodes(state.pendingLinks);
    state.pendingLinks[code] = { address: verified, createdAt: Date.now() };
    await setState(state);

    res.json({ code, deepLink: `https://t.me/${botUsername}?start=${code}`, expiresInMs: LINK_CODE_TTL_MS });
  });

  router.post(`/${routeBase}/unlink`, async (req, res) => {
    const { address, timestamp, signature } = req.body;
    const verified = verifyWalletSignature(address, timestamp, signature);
    if (!verified) return res.status(401).json({ error: "Invalid or expired signature" });

    const state = await getState();
    delete state.subscriptions[verified];
    await setState(state);
    res.json({ linked: false });
  });

  router.get(`/${routeBase}/status`, async (req, res) => {
    const address = String(req.query.address || "").toLowerCase();
    if (!ethers.isAddress(address)) return res.status(400).json({ error: "Invalid address" });

    const state = await getState();
    res.json({ linked: Boolean(state.subscriptions[address]) });
  });

  router.post(`/${routeBase}/webhook`, async (req, res) => {
    // Same "always 200" reasoning as telegramLinkRouter.js's original — Telegram suspends a
    // webhook that doesn't respond fast with 2xx, regardless of what the update turns out to be.
    if (webhookSecret) {
      const header = req.get("X-Telegram-Bot-Api-Secret-Token");
      if (header !== webhookSecret) {
        console.warn(`⚠️  Telegram webhook (${routeBase}): secret token mismatch, ignoring`);
        return res.sendStatus(200);
      }
    }

    try {
      const message = req.body?.message;
      const text = message?.text;
      const chatId = message?.chat?.id;
      const match = typeof text === "string" ? text.match(/^\/start\s+([0-9a-f]{12})\b/i) : null;

      if (match && chatId != null) {
        const code = match[1].toLowerCase();
        const state = await getState();
        state.pendingLinks = pruneExpiredCodes(state.pendingLinks);
        const pending = state.pendingLinks[code];

        if (pending) {
          delete state.pendingLinks[code];
          state.subscriptions[pending.address] = { chatId, linkedAt: Date.now() };
          await setState(state);
          await onLinked(pending.address, chatId, sendDirectMessage);
        } else {
          await sendDirectMessage(chatId, `That link has expired or was already used — go back to the site and try again to get a fresh one.`);
        }
      } else if (typeof text === "string" && /^\/unlink\b/i.test(text) && chatId != null) {
        const state = await getState();
        const addressForChat = Object.entries(state.subscriptions).find(([, v]) => v.chatId === chatId)?.[0];
        if (addressForChat) {
          delete state.subscriptions[addressForChat];
          await setState(state);
          await sendDirectMessage(chatId, "Unlinked — you won't get any more alerts here.");
        }
      }
    } catch (err) {
      console.error(`⚠️  Telegram webhook handling failed (${routeBase}):`, err.message);
    }

    res.sendStatus(200);
  });

  /**
   * Registers this backend's webhook URL with Telegram — no-op if not configured or
   * BACKEND_PUBLIC_URL isn't set. Safe to call unconditionally at boot every time (setWebhook is
   * idempotent).
   */
  async function registerWebhook() {
    if (!isConfigured()) {
      console.log(`ℹ️  Telegram (${routeBase}) not configured — webhook not registered`);
      return;
    }
    if (!backendPublicUrl) {
      console.log(`ℹ️  BACKEND_PUBLIC_URL not set — Telegram (${routeBase}) webhook not registered`);
      return;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: `${backendPublicUrl.replace(/\/$/, "")}/api/${routeBase}/webhook`,
          ...(webhookSecret ? { secret_token: webhookSecret } : {}),
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.description || "setWebhook failed");
      console.log(`📡 Telegram (${routeBase}) webhook registered`);
    } catch (err) {
      console.error(`⚠️  Failed to register Telegram (${routeBase}) webhook:`, err.message);
    }
  }

  /** Looks up `address`'s linked chat id, or null if it isn't linked. */
  async function getLinkedChatId(address) {
    if (!address) return null;
    const state = await getState();
    return state.subscriptions[address.toLowerCase()]?.chatId ?? null;
  }

  return { router, registerWebhook, getLinkedChatId, isConfigured, sendDirectMessage };
}
