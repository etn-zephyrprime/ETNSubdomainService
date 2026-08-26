// backend/utils/telegramLinkRouter.js
//
// Lets a wallet owner opt in to a personal Telegram DM whenever one of their names/subnames
// sells, on top of (not instead of) the public "Subdomain Name Service" channel post
// marketplaceWatcher.js already makes for every sale. That channel post is anonymous-ish (a
// primary name or short address, easy to miss in a busy group); this is "hey, YOUR shop.alice.etn
// just sold for 50 ETN, you got 40" sent straight to the owner.
//
// Linking flow (standard Telegram deep-link pattern — a bot can't message a user until that user
// has started a conversation with it, so the frontend can't just "know" a chat id on its own):
//   1. Wallet signs a short-lived request (same pattern as backendAuth.js/verifyOwnership.js,
//      just proving control of the address rather than ownership of a specific name) ->
//      POST /request-link-code -> backend mints a random code, stores it as pending, returns a
//      https://t.me/<bot>?start=<code> deep link.
//   2. User taps the link, Telegram opens a chat with the bot and sends "/start <code>"
//      automatically as the first message.
//   3. Telegram POSTs that update to our webhook -> we match <code> to the pending wallet address
//      and record { address -> chatId }. From then on that chat can be DMed.
// POST /unlink (same signature scheme) removes the mapping. GET /status is a plain read (no
// signature — it only reveals whether an address is linked, never the chatId itself).
import express from "express";
import { ethers } from "ethers";
import crypto from "crypto";
import { getTelegramLinkState, setTelegramLinkState } from "../state/telegramLinkState.js";
import { sendTelegramDirectMessage } from "./telegramNotifier.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Optional — verified against Telegram's X-Telegram-Bot-Api-Secret-Token header on every webhook
// call (set via setWebhook's own secret_token param in registerTelegramWebhook below) so a
// request to this endpoint that didn't actually come from Telegram can't fabricate a "linked"
// update for an arbitrary address. Webhook still works without it, just without that check.
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;
// This service's own public URL, needed only to register the webhook (Telegram must be able to
// reach it over HTTPS) — same idea as marketplaceWatcher.js's SITE_URL, but for this backend
// itself rather than the frontend.
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || null;

// How long a requested link code stays valid before a /start with it is rejected — generous
// enough to cover "copy the link, switch to the Telegram app, tap it" without leaving stale codes
// guessable for long. Expired codes are pruned lazily (on the next read-modify-write) rather than
// on a timer — this endpoint sees too little traffic to justify a background sweep.
const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;

// Must stay byte-for-byte in sync with buildTelegramLinkMessage() in
// src/utils/telegramLinkAuth.js (frontend) — changing either side alone breaks every request.
function buildMessage(address, timestamp) {
  return `Link Telegram alerts for wallet ${address.toLowerCase()} at ${timestamp}`;
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

let cachedBotUsername = process.env.TELEGRAM_BOT_USERNAME || null;
async function getBotUsername() {
  if (cachedBotUsername) return cachedBotUsername;
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (data?.ok && data.result?.username) {
      cachedBotUsername = data.result.username;
    }
  } catch (err) {
    console.warn("⚠️  Failed to fetch Telegram bot username:", err.message);
  }
  return cachedBotUsername;
}

export function telegramLinkConfigured() {
  return Boolean(TELEGRAM_BOT_TOKEN && process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME);
}

const router = express.Router();

router.post("/telegram/request-link-code", async (req, res) => {
  if (!telegramLinkConfigured()) {
    return res.status(503).json({ error: "Telegram alerts aren't configured on this deployment" });
  }

  const { address, timestamp, signature } = req.body;
  const verified = verifyWalletSignature(address, timestamp, signature);
  if (!verified) {
    return res.status(401).json({ error: "Invalid or expired signature" });
  }

  const botUsername = await getBotUsername();
  if (!botUsername) {
    return res.status(503).json({ error: "Couldn't reach Telegram — try again shortly" });
  }

  const code = crypto.randomBytes(6).toString("hex");
  const state = await getTelegramLinkState();
  state.pendingLinks = pruneExpiredCodes(state.pendingLinks);
  state.pendingLinks[code] = { address: verified, createdAt: Date.now() };
  await setTelegramLinkState(state);

  res.json({
    code,
    deepLink: `https://t.me/${botUsername}?start=${code}`,
    expiresInMs: LINK_CODE_TTL_MS,
  });
});

router.post("/telegram/unlink", async (req, res) => {
  const { address, timestamp, signature } = req.body;
  const verified = verifyWalletSignature(address, timestamp, signature);
  if (!verified) {
    return res.status(401).json({ error: "Invalid or expired signature" });
  }

  const state = await getTelegramLinkState();
  delete state.subscriptions[verified];
  await setTelegramLinkState(state);

  res.json({ linked: false });
});

router.get("/telegram/status", async (req, res) => {
  const address = String(req.query.address || "").toLowerCase();
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: "Invalid address" });
  }

  const state = await getTelegramLinkState();
  // Only ever reveals whether a link exists — never the chatId itself.
  res.json({ linked: Boolean(state.subscriptions[address]) });
});

router.post("/telegram/webhook", async (req, res) => {
  // Telegram expects a fast 2xx regardless of what the update turns out to be — failing to
  // respond quickly gets the webhook temporarily suspended, so every path below returns 200
  // even when the update itself didn't lead to anything happening.
  if (TELEGRAM_WEBHOOK_SECRET) {
    const header = req.get("X-Telegram-Bot-Api-Secret-Token");
    if (header !== TELEGRAM_WEBHOOK_SECRET) {
      console.warn("⚠️  Telegram webhook: secret token mismatch, ignoring");
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
      const state = await getTelegramLinkState();
      state.pendingLinks = pruneExpiredCodes(state.pendingLinks);
      const pending = state.pendingLinks[code];

      if (pending) {
        delete state.pendingLinks[code];
        state.subscriptions[pending.address] = { chatId, linkedAt: Date.now() };
        await setTelegramLinkState(state);
        await sendTelegramDirectMessage(
          chatId,
          `✅ *Linked!*\n\nYou'll get a message here whenever a name or subname owned by \`${pending.address}\` sells.\n\nSend /unlink any time, or use the toggle on the site, to stop.`
        );
      } else {
        await sendTelegramDirectMessage(
          chatId,
          `That link has expired or was already used — go back to the site and tap "Enable Telegram Alerts" again to get a fresh one.`
        );
      }
    } else if (typeof text === "string" && /^\/unlink\b/i.test(text) && chatId != null) {
      // Convenience unlink directly from the chat — doesn't need a wallet signature since it can
      // only ever remove whichever address is currently linked to *this* chat, not any other.
      const state = await getTelegramLinkState();
      const addressForChat = Object.entries(state.subscriptions).find(([, v]) => v.chatId === chatId)?.[0];
      if (addressForChat) {
        delete state.subscriptions[addressForChat];
        await setTelegramLinkState(state);
        await sendTelegramDirectMessage(chatId, "Unlinked — you won't get any more sale alerts here.");
      }
    }
  } catch (err) {
    console.error("⚠️  Telegram webhook handling failed:", err.message);
  }

  res.sendStatus(200);
});

/**
 * Registers this backend's webhook URL with Telegram so incoming messages (specifically
 * "/start <code>" from the deep link above) reach POST /telegram/webhook. No-op if Telegram
 * alerts aren't configured or BACKEND_PUBLIC_URL isn't set — safe to call unconditionally at
 * boot every time, since setWebhook is idempotent (re-registering the same URL is a no-op on
 * Telegram's side).
 */
export async function registerTelegramWebhook() {
  if (!telegramLinkConfigured()) {
    console.log("ℹ️  Telegram alerts not configured — webhook not registered");
    return;
  }
  if (!BACKEND_PUBLIC_URL) {
    console.log("ℹ️  BACKEND_PUBLIC_URL not set — Telegram webhook not registered (personal DM alerts disabled, public channel alerts unaffected)");
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `${BACKEND_PUBLIC_URL.replace(/\/$/, "")}/api/telegram/webhook`,
        ...(TELEGRAM_WEBHOOK_SECRET ? { secret_token: TELEGRAM_WEBHOOK_SECRET } : {}),
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || "setWebhook failed");
    console.log("📡 Telegram webhook registered — personal DM alerts enabled");
  } catch (err) {
    console.error("⚠️  Failed to register Telegram webhook:", err.message);
  }
}

/**
 * Looks up a wallet's linked chat id, or null if it isn't linked. Used by marketplaceWatcher.js
 * to DM a domain/subname owner directly alongside the public channel post it already makes.
 */
export async function getLinkedChatId(address) {
  if (!address) return null;
  const state = await getTelegramLinkState();
  return state.subscriptions[address.toLowerCase()]?.chatId ?? null;
}

export default router;
