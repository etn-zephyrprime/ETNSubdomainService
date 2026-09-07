// backend/utils/telegramLinkRouter.js
//
// Lets a wallet owner opt in to a personal Telegram DM whenever one of their names/subnames
// sells, on top of (not instead of) the public "Subdomain Name Service" channel post
// marketplaceWatcher.js already makes for every sale. That channel post is anonymous-ish (a
// primary name or short address, easy to miss in a busy group); this is "hey, YOUR shop.alice.etn
// just sold for 50 ETN, you got 40" sent straight to the owner.
//
// This is the ETN Subdomain Service bot specifically (TELEGRAM_BOT_TOKEN) — a DIFFERENT bot
// identity from the Planet Zephyros Notis bot Core tier alerts use (see notisLinkRouter.js). The
// two must NOT be conflated: an early version of the Core tier alerts feature reused this router's
// link/send path directly, which meant every wallet/token price alert silently went out branded as
// the Subdomain Service bot instead of the Planet Zephyros one the premium dashboard is meant to
// speak through — confusing for anyone who has both linked, since a wallet alert appearing to come
// from "the ETN Subdomain Service" looks unrelated to Core tier at all. Fixed by giving Core tier
// its own bot end-to-end rather than trying to re-brand messages sent through this one.
//
// Linking flow (standard Telegram deep-link pattern — a bot can't message a user until that user
// has started a conversation with it, so the frontend can't just "know" a chat id on its own) is
// implemented once, shared with notisLinkRouter.js — see createTelegramLinkRouter.js.
import { createTelegramLinkRouter } from "./createTelegramLinkRouter.js";
import { getTelegramLinkState, setTelegramLinkState } from "../state/telegramLinkState.js";

const instance = createTelegramLinkRouter({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || null,
  backendPublicUrl: process.env.BACKEND_PUBLIC_URL || null,
  botUsername: process.env.TELEGRAM_BOT_USERNAME || null,
  getState: getTelegramLinkState,
  setState: setTelegramLinkState,
  // Must stay byte-for-byte in sync with buildTelegramLinkMessage() in
  // src/utils/telegramLinkAuth.js (frontend) — this literal is what "Telegram alerts" resolves to
  // in createTelegramLinkRouter.js's buildMessage(); changing it here without updating that file
  // (or vice versa) breaks every request.
  purpose: "Telegram alerts",
  routeBase: "telegram",
  extraConfigured: () => Boolean(process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME),
  onLinked: async (address, chatId, sendDirectMessage) => {
    await sendDirectMessage(
      chatId,
      `✅ *Linked!*\n\nYou'll get a message here whenever a name or subname owned by \`${address}\` sells.\n\nSend /unlink any time, or use the toggle on the site, to stop.`
    );
  },
});

export const telegramLinkConfigured = instance.isConfigured;
export const registerTelegramWebhook = instance.registerWebhook;

/**
 * Looks up a wallet's linked chat id, or null if it isn't linked. Used by marketplaceWatcher.js
 * to DM a domain/subname owner directly alongside the public channel post it already makes.
 */
export const getLinkedChatId = instance.getLinkedChatId;

export default instance.router;
