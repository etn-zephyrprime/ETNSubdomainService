// Thin wrapper around Telegram's Bot API — one function, one job: send a message to the
// configured chat. Used by marketplaceWatcher.js to post activation/subname notifications.

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// Optional — targets a specific topic in a Telegram forum-mode group (e.g. "Subdomain Name
// Service" rather than General). Find it via the topic's "Copy Link": the trailing number in
// https://t.me/c/<chat>/<thread_id> is this value. Omit for a non-forum chat, or to post to
// General.
const TELEGRAM_MESSAGE_THREAD_ID = process.env.TELEGRAM_MESSAGE_THREAD_ID;

export function telegramConfigured() {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

async function callTelegramApi(method, body) {
  if (!telegramConfigured()) {
    throw new Error("Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      ...(TELEGRAM_MESSAGE_THREAD_ID ? { message_thread_id: Number(TELEGRAM_MESSAGE_THREAD_ID) } : {}),
      ...body,
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new Error(`Telegram API error: ${data?.description || res.statusText}`);
  }
  return data;
}

/**
 * Sends `text` (Markdown-formatted) to the configured Telegram chat. Throws if not configured or
 * if the API call fails — callers that want this to be non-fatal (e.g. one failed notification
 * shouldn't crash the watcher loop) should catch it themselves.
 */
export async function sendTelegramMessage(text) {
  return callTelegramApi("sendMessage", {
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

/**
 * Sends `photoUrl` with a Markdown `caption` (Telegram fetches the URL server-side — no need to
 * download/re-upload it ourselves). Throws the same way sendTelegramMessage does; in particular
 * Telegram rejects this if photoUrl 404s or isn't a real image yet, which callers should expect
 * as a normal case (e.g. the NFT image hasn't finished generating/uploading yet) and fall back to
 * sendTelegramMessage rather than losing the notification entirely.
 */
export async function sendTelegramPhoto(photoUrl, caption) {
  return callTelegramApi("sendPhoto", {
    photo: photoUrl,
    caption,
    parse_mode: "Markdown",
  });
}
