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
import { createRateLimiter } from "./rateLimit.js";

const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const chatFlood = createRateLimiter({ max: 10, windowMs: 60 * 1000 });
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
 *   - onCommand({ text, chatId, chatType, linkedAddress, sendDirectMessage, getState, setState }) — optional:
 *     any other message (e.g. the Notis bot's /check). `linkedAddress` is the wallet this chat is linked to,
 *     or null. Run in the background (the webhook answers Telegram at once); errors are logged.
 *   - onCallback({ data, chatId, linkedAddress, answer }) — optional: a tap on an inline button (e.g. "Was this
 *     right?"). `answer(text)` shows Telegram's small confirmation; also run in the background.
 */
export function createTelegramLinkRouter(config) {
  const { botToken, webhookSecret, backendPublicUrl, getState, setState, purpose, routeBase, onLinked, extraConfigured, onCommand, onCallback } = config;

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

  /** `extra`: more sendMessage fields, e.g. { reply_markup: { inline_keyboard: [...] } } for buttons. */
  async function sendDirectMessage(chatId, text, extra = {}) {
    if (!botToken) {
      console.warn(`ℹ️  Telegram (${routeBase}) not configured — skipping direct message`);
      return null;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true, ...extra }),
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

    // An inline-button tap: acknowledged to Telegram straight away, handled in the background.
    const cb = req.body?.callback_query;
    if (cb && onCallback) {
      const chatId = cb.message?.chat?.id ?? cb.from?.id;
      if (chatId != null && chatFlood(`${routeBase}:${chatId}`).ok) {
        const answer = (text) => answerCallback(cb.id, text);
        Promise.resolve()
          .then(async () => {
            const state = await getState();
            const linkedAddress = Object.entries(state.subscriptions).find(([, v]) => v.chatId === chatId)?.[0] || null;
            await onCallback({ data: String(cb.data || ""), chatId, linkedAddress, answer });
          })
          .catch((err) => console.error(`⚠️  Telegram button failed (${routeBase}):`, err.message));
      }
      return res.sendStatus(200);
    }

    try {
      const message = req.body?.message;
      const text = message?.text;
      const chatId = message?.chat?.id;
      // Flood guard for every bot on this router: past 10 messages a minute from one chat, the rest are
      // dropped silently (no reply, no R2 read) — e.g. /start with made-up codes, which would otherwise get
      // an "expired" reply each time. Per-command limits (e.g. the Notis bot's /check) sit on top.
      if (chatId != null && !chatFlood(`${routeBase}:${chatId}`).ok) return res.sendStatus(200);
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
      } else if (onCommand && typeof text === "string" && text.startsWith("/") && chatId != null) {
        // commands only: plain chatter (e.g. in a group the bot sits in) costs nothing — not even the R2 read below
        const state = await getState();
        const linkedAddress = Object.entries(state.subscriptions).find(([, v]) => v.chatId === chatId)?.[0] || null;
        // Not awaited: a command can take a while (e.g. analysing a contract), and Telegram re-sends any update
        // whose webhook doesn't answer quickly — that would run it twice.
        Promise.resolve()
          .then(() => onCommand({ text, chatId, chatType: message?.chat?.type || null, linkedAddress, sendDirectMessage, getState, setState }))
          .catch((err) => console.error(`⚠️  Telegram command failed (${routeBase}):`, err.message));
      }
    } catch (err) {
      console.error(`⚠️  Telegram webhook handling failed (${routeBase}):`, err.message);
    }

    res.sendStatus(200);
  });

  /** Telegram's small "toast" after a button tap; never throws. */
  async function answerCallback(callbackQueryId, text) {
    if (!botToken) return;
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: String(text || "").slice(0, 190) }),
    }).catch(() => {});
  }

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
