// backend/utils/notisLinkRouter.js
//
// The Planet Zephyros Notis bot (@PlanetZephyrosNotisBot) — personal Telegram DMs for Core tier's
// wallet balance/tx-activity alerts and token price alerts (see migrations/009_alerts.sql,
// walletAlertScheduler.js, tokenPriceAlertScheduler.js). A DELIBERATELY SEPARATE bot identity from
// telegramLinkRouter.js's ETN Subdomain Service bot — see that file's own header comment for why
// (Core tier alerts must never go out under the Subdomain Service bot's branding). Same
// signed-deep-link-plus-webhook mechanics as that router though, factored into
// createTelegramLinkRouter.js so both bots share one implementation of the security-sensitive
// signature-verification/webhook code rather than keeping two hand-copied versions in sync.
//
// This IS the same bot/token as COREBOT_ZEPHYROS_BOT_TOKEN (coreClashTelegram.js's "Zephyros"
// bot) — confirmed by the user, not a coincidence of naming. That file only ever SENDS to one
// fixed group chat via sendMessage/sendAnimation; it has never registered a webhook, so this
// router's own webhook registration (below, via createTelegramLinkRouter's registerWebhook) is the
// first thing on this bot that receives updates at all — the two uses don't conflict (setWebhook
// only affects inbound updates, never outbound sendMessage). One bot, two independent integrations
// in this codebase; see coreClashTelegram.js's own comment pointing back here.
//
// Mounted at /api in backend/index.js, alongside (not replacing) telegramLinkRouter.js — a wallet
// can be linked to neither, either, or both bots independently.
import { createTelegramLinkRouter } from "./createTelegramLinkRouter.js";
import { getNotisLinkState, setNotisLinkState } from "../state/notisLinkState.js";

const instance = createTelegramLinkRouter({
  botToken: process.env.COREBOT_ZEPHYROS_BOT_TOKEN,
  webhookSecret: process.env.COREBOT_ZEPHYROS_WEBHOOK_SECRET || null,
  backendPublicUrl: process.env.BACKEND_PUBLIC_URL || null,
  botUsername: process.env.COREBOT_ZEPHYROS_BOT_USERNAME || "PlanetZephyrosNotisBot",
  getState: getNotisLinkState,
  setState: setNotisLinkState,
  // Must stay byte-for-byte in sync with buildNotisLinkMessage() in src/utils/notisLinkAuth.js
  // (frontend) — this literal is what createTelegramLinkRouter.js's buildMessage() resolves to.
  purpose: "Planet Zephyros alerts",
  routeBase: "notis",
  // No R2-credentials gate the way telegramLinkRouter.js's extraConfigured has: R2 being
  // unconfigured already makes getNotisLinkState/setNotisLinkState no-ops on their own (see
  // notisLinkState.js), same as every other R2-backed feature in this backend — nothing extra to
  // check here beyond the bot token itself being set.
  onLinked: async (address, chatId, sendDirectMessage) => {
    await sendDirectMessage(
      chatId,
      `✅ *Linked!*\n\nYou'll get Core tier alerts here — wallet balance/activity and token price moves you've configured on the dashboard.\n\nSend /unlink any time, or use the toggle on the site, to stop.`
    );
  },
});

export const notisConfigured = instance.isConfigured;
export const registerNotisWebhook = instance.registerWebhook;

/** Looks up a wallet's linked Notis chat id, or null if it isn't linked. Used by
 * walletAlertScheduler.js/tokenPriceAlertScheduler.js to deliver Core tier alerts. */
export const getNotisLinkedChatId = instance.getLinkedChatId;

/** Sends `text` (Markdown) to an arbitrary Notis chat id — same non-throwing convention as
 * telegramNotifier.js's sendTelegramDirectMessage (a failed DM shouldn't crash a poll tick). */
export const sendNotisDirectMessage = instance.sendDirectMessage;

export default instance.router;
