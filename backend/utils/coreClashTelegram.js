// backend/utils/coreClashTelegram.js
//
// Sends the CoreClashGame notifications (burn/swap/NFT mint/NFT sale/drip alerts and the advert
// rotation) ported from that repo's telegramBot.js. Deliberately separate from
// telegramNotifier.js: this repo's own name-service notifications use ONE bot/chat
// (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID), but CoreClashGame's messages are split across TWO
// distinct bots posting into the same group —
//   - the "Zephyros" bot: burn, swap, NFT mint/sale, and drip alerts
//   - the "Core Clash" bot: the advert rotation only
// — each with its own optional topic thread. Reusing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID for
// either would collide with this repo's own already-configured bot, hence the COREBOT_ prefix on
// every env var below.
const COREBOT_TELEGRAM_CHAT_ID = process.env.COREBOT_TELEGRAM_CHAT_ID;
const COREBOT_TELEGRAM_BOT_TOKEN = process.env.COREBOT_TELEGRAM_BOT_TOKEN; // "Core Clash" bot — adverts only
const COREBOT_ZEPHYROS_BOT_TOKEN = process.env.COREBOT_ZEPHYROS_BOT_TOKEN; // "Zephyros" bot — everything else
const COREBOT_ZEPHYROS_GENERAL_THREAD_ID = process.env.COREBOT_ZEPHYROS_GENERAL_THREAD_ID
  ? Number(process.env.COREBOT_ZEPHYROS_GENERAL_THREAD_ID)
  : null;
// Same hardcoded topic CoreClashGame's telegramBot.js used (ZEPHYROS_NFT_MESSAGE_THREAD_ID) —
// it's a thread id in the one shared chat, not something that varies per deployment, but
// overridable in case that ever changes.
const COREBOT_ZEPHYROS_NFT_THREAD_ID = process.env.COREBOT_ZEPHYROS_NFT_THREAD_ID
  ? Number(process.env.COREBOT_ZEPHYROS_NFT_THREAD_ID)
  : 782;

export function zephyrosBotConfigured() {
  return Boolean(COREBOT_ZEPHYROS_BOT_TOKEN && COREBOT_TELEGRAM_CHAT_ID);
}

export function coreClashBotConfigured() {
  return Boolean(COREBOT_TELEGRAM_BOT_TOKEN && COREBOT_TELEGRAM_CHAT_ID);
}

export const NFT_THREAD_ID = COREBOT_ZEPHYROS_NFT_THREAD_ID;
export const GENERAL_THREAD_ID = COREBOT_ZEPHYROS_GENERAL_THREAD_ID;

async function callTelegramApi(botToken, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data?.description || `Telegram ${method} failed with status ${res.status}`);
  }
  return data.result;
}

function buildFooter() {
  return (
    `\n\n━━━━━━━━━━━━━━\n` +
    `🎮 <a href="https://coreclash.planetzephyros.xyz">Play Core Clash</a>\n` +
    `🌍 <a href="https://planetetn.org/zephyros">PlanetETN: Planet Zephyros</a>`
  );
}

/**
 * Sends an HTML-formatted text message via the Zephyros bot. `threadId` is optional — omit for
 * the chat's General topic.
 */
export async function sendZephyrosMessage(text, { threadId, footer = true } = {}) {
  if (!zephyrosBotConfigured()) {
    console.warn("ℹ️  [CoreClash] Zephyros bot not configured (COREBOT_ZEPHYROS_BOT_TOKEN / COREBOT_TELEGRAM_CHAT_ID) — skipping:", text.slice(0, 80));
    return null;
  }

  return callTelegramApi(COREBOT_ZEPHYROS_BOT_TOKEN, "sendMessage", {
    chat_id: COREBOT_TELEGRAM_CHAT_ID,
    text: footer ? text + buildFooter() : text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(threadId != null ? { message_thread_id: threadId } : {}),
  });
}

/**
 * Sends an animation (GIF) via the Zephyros bot — `animation` may be a Telegram file_id (as
 * CoreClashGame's swap/burn alerts use) or a URL; Telegram accepts either.
 */
export async function sendZephyrosAnimation(animation, caption, { threadId, footer = true } = {}) {
  if (!zephyrosBotConfigured()) {
    console.warn("ℹ️  [CoreClash] Zephyros bot not configured — skipping animation:", caption.slice(0, 80));
    return null;
  }

  return callTelegramApi(COREBOT_ZEPHYROS_BOT_TOKEN, "sendAnimation", {
    chat_id: COREBOT_TELEGRAM_CHAT_ID,
    animation,
    caption: footer ? caption + buildFooter() : caption,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(threadId != null ? { message_thread_id: threadId } : {}),
  });
}

/** Sends an HTML-formatted text message via the Core Clash bot (adverts only), General topic. */
export async function sendCoreClashMessage(text, { footer = true } = {}) {
  if (!coreClashBotConfigured()) {
    console.warn("ℹ️  [CoreClash] Core Clash bot not configured (COREBOT_TELEGRAM_BOT_TOKEN / COREBOT_TELEGRAM_CHAT_ID) — skipping:", text.slice(0, 80));
    return null;
  }

  return callTelegramApi(COREBOT_TELEGRAM_BOT_TOKEN, "sendMessage", {
    chat_id: COREBOT_TELEGRAM_CHAT_ID,
    text: footer ? text + buildFooter() : text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// ---- shared formatting helpers (same as CoreClashGame's telegramBot.js) ----

export function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function shortAddr(address) {
  if (!address) return "Unknown";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
