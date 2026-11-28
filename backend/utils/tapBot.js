// backend/utils/tapBot.js
//
// Telegram "tap" bot. Each Tap press sends a 0-value self-transfer from TAP_WALLET_PRIVATE_KEY, so
// the gas is the only cost and every tap burns a little ETN. Donate sends the wallet address and a
// QR code so people can top the wallet up. When the wallet can't cover gas, taps are refused and
// the donate prompt is shown instead.
//
// Taps, gas burned, and the leaderboard are stored in Postgres (migration 039_tap_bot_taps.sql).
// Without DATABASE_URL the bot still taps; it just omits the counters and leaderboard.
//
// Uses long-polling (getUpdates) so it needs no public webhook URL. It needs its own bot token: a
// token that already has a webhook set elsewhere will make getUpdates fail with a 409 conflict.
import { ethers } from "ethers";
import QRCode from "qrcode";
import { recordTap, getTapStats, getLeaderboard } from "../db/tapBotTaps.js";
import { buildBurnGif } from "./tapBurnGif.js";
import { rollHuntDrop } from "./tapHunt.js";
import {
  EXPLORER_BASE_URL,
  MILESTONE_EVERY,
  MENU_TEXT,
  enqueue,
  fuelGauge,
  getTapContext,
  maybeFlair,
  sendTapTx,
  trackReceipt,
} from "./tapCore.js";

const TELEGRAM_API = "https://api.telegram.org";
const POLL_TIMEOUT_SECONDS = 30;
// Topic link t.me/c/2905908099/6550 → supergroup chat id -100<2905908099>, forum topic 6550.
const TAP_CHAT_ID = String(process.env.TAP_BOT_CHAT_ID || "-1002905908099");
const TAP_TOPIC_ID = Number(process.env.TAP_BOT_TOPIC_ID || 6550);
const AUTO_DELETE_MS = 5 * 60 * 1000;
const MENU_CHECK_MS = 60 * 1000;

const MENU_KEYBOARD = {
  inline_keyboard: [
    [{ text: "🔥 Tap (burn gas)", callback_data: "tap" }],
    [{ text: "💰 Donate ETN", callback_data: "donate" }],
  ],
};

// The menu is the one bot message that is never auto-deleted, so the topic always has a button
// to tap. Only one menu exists at a time: posting a new one removes the previous one.
let menuAnchor = null;
let burnGif = null;

async function postMenu(token, chatId) {
  const message = await callApi(token, "sendMessage", {
    chat_id: chatId,
    message_thread_id: TAP_TOPIC_ID,
    text: MENU_TEXT,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: MENU_KEYBOARD,
  });
  const previous = menuAnchor;
  menuAnchor = { chatId, messageId: message.message_id };
  if (previous) {
    callApi(token, "deleteMessage", { chat_id: previous.chatId, message_id: previous.messageId }).catch(() => {});
  }
  return message;
}

// Re-posts the menu if it has been deleted. An unchanged edit is a no-op that proves it still exists.
async function ensureMenu(token) {
  if (!menuAnchor) return postMenu(token, TAP_CHAT_ID);
  try {
    await editText(token, menuAnchor.chatId, menuAnchor.messageId, MENU_TEXT);
  } catch {
    await postMenu(token, menuAnchor.chatId);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isAllowedChat = (message) =>
  message?.chat?.type === "private" ||
  (String(message?.chat?.id) === TAP_CHAT_ID && message?.message_thread_id === TAP_TOPIC_ID);
// Private chats have no topic; group messages must go to the tap topic.
const topicParams = (chatId) => (String(chatId) === TAP_CHAT_ID ? { message_thread_id: TAP_TOPIC_ID } : {});

// Telegram allows roughly 20 messages a minute per group. Sends are spaced to stay under that, and a
// 429 response is retried after the wait Telegram asks for.
const SEND_GAP_MS = 3100;
const SENDING_METHODS = new Set(["sendMessage", "sendPhoto"]);
let nextSendAt = 0;
async function throttleSend() {
  const now = Date.now();
  const at = Math.max(now, nextSendAt);
  nextSendAt = at + SEND_GAP_MS;
  if (at > now) await sleep(at - now);
}

async function callApi(token, method, body, attempt = 0) {
  if (SENDING_METHODS.has(method)) await throttleSend();
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((POLL_TIMEOUT_SECONDS + 10) * 1000),
  });
  const data = await res.json();
  if (!data.ok) {
    if (data.error_code === 429 && attempt < 3) {
      await sleep((data.parameters?.retry_after ?? 5) * 1000);
      return callApi(token, method, body, attempt + 1);
    }
    throw new Error(`${method} failed: ${data.description}`);
  }
  return data.result;
}

function scheduleDelete(token, chatId, messageId) {
  setTimeout(() => {
    callApi(token, "deleteMessage", { chat_id: chatId, message_id: messageId }).catch((err) =>
      console.error("⚠️  Tap bot could not auto-delete message:", err.message),
    );
  }, AUTO_DELETE_MS);
}

function sendText(token, chatId, text, replyMarkup = MENU_KEYBOARD, { persist = false } = {}) {
  return callApi(token, "sendMessage", {
    chat_id: chatId,
    ...topicParams(chatId),
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
  }).then((message) => {
    if (!persist) scheduleDelete(token, chatId, message.message_id);
    return message;
  });
}

function editText(token, chatId, messageId, text, replyMarkup = MENU_KEYBOARD) {
  return callApi(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
  }).catch((err) => {
    // Telegram rejects an edit that changes nothing; that's harmless here.
    if (!/not modified/.test(err.message)) throw err;
  });
}

function editCaption(token, chatId, messageId, caption, replyMarkup = MENU_KEYBOARD) {
  return callApi(token, "editMessageCaption", {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  }).catch((err) => {
    if (!/not modified/.test(err.message)) throw err;
  });
}

async function sendBurnAnimation(ctx, chatId, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  for (const [key, value] of Object.entries(topicParams(chatId))) form.append(key, String(value));
  form.append("parse_mode", "HTML");
  form.append("caption", caption);
  form.append("reply_markup", JSON.stringify(MENU_KEYBOARD));
  form.append("animation", new Blob([burnGif], { type: "image/gif" }), "burning.gif");
  await throttleSend();
  const res = await fetch(`${TELEGRAM_API}/bot${ctx.token}/sendAnimation`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`sendAnimation failed: ${data.description}`);
  scheduleDelete(ctx.token, chatId, data.result.message_id);
  return data.result;
}

async function sendDonation(ctx, chatId) {
  const png = await QRCode.toBuffer(ctx.wallet.address, { type: "png", margin: 2, width: 512 });
  const form = new FormData();
  form.append("chat_id", String(chatId));
  for (const [key, value] of Object.entries(topicParams(chatId))) form.append(key, String(value));
  form.append("parse_mode", "HTML");
  form.append(
    "caption",
    `💰 <b>Donate ETN to keep the taps going</b>\n\n<code>${ctx.wallet.address}</code>\n\n` +
      `Scan the QR code or send ETN on Electroneum to the address above.\n\n` +
      `⚠️ <b>Disclaimer:</b> this is a plain ETN transfer to a wallet, not a smart contract. ` +
      `Donations are not refundable or guaranteed. Send at your own risk.`,
  );
  form.append("reply_markup", JSON.stringify(MENU_KEYBOARD));
  form.append("photo", new Blob([png], { type: "image/png" }), "donate.png");
  await throttleSend();
  const res = await fetch(`${TELEGRAM_API}/bot${ctx.token}/sendPhoto`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`sendPhoto failed: ${data.description}`);
  scheduleDelete(ctx.token, chatId, data.result.message_id);
}

async function sendDirect(token, userId, text) {
  try {
    await callApi(token, "sendMessage", {
      chat_id: userId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    return true;
  } catch (err) {
    console.error("⚠️  Tap bot could not DM a hunt word:", err.message);
    return false;
  }
}

function huntMessage(hunt) {
  const word = escapeHtml(hunt.word);
  if (!hunt.isNew) return `🧩 You found <b>${word}</b> again. You already had it.`;
  const done = hunt.won ? "\n🏁 You now have all 24 words. Work out the order yourself." : "";
  return `🧩 You found a word: <b>${word}</b>${done}`;
}

async function handleTap(ctx, chatId, from) {
  let usingGif = Boolean(burnGif);
  let progress = usingGif ? await sendBurnAnimation(ctx, chatId, "🔥 Burning…").catch(() => null) : null;
  if (!progress) {
    usingGif = false;
    progress = await sendText(ctx.token, chatId, "🔥 Tapping…");
  }
  const messageId = progress.message_id;
  const setProgress = (text) =>
    usingGif ? editCaption(ctx.token, chatId, messageId, text) : editText(ctx.token, chatId, messageId, text);

  try {
    const result = await enqueue(() => sendTapTx(ctx));
    if (!result.hash) {
      await setProgress(
        `🪫 <b>Out of gas!</b> The tap wallet has ${ethers.formatEther(result.balance)} ETN left, not enough for the next tap.\n\n` +
          `Donate ETN to keep it running.`,
      );
      return;
    }

    await setProgress("💥 Burning gas…");
    await sleep(400);
    await setProgress("✨ Burned!");

    trackReceipt(result.tx);
    const name = from?.username ? `@${from.username}` : from?.first_name || "someone";
    let stats = null;
    try {
      await recordTap({
        txHash: result.hash,
        chatId,
        userId: from?.id,
        username: from?.username,
        firstName: from?.first_name,
      });
      stats = await getTapStats();
    } catch (err) {
      console.error("⚠️  Tap bot could not record tap:", err.message);
    }

    const taps = stats ? `Tap #${stats.taps} by ${escapeHtml(name)}` : `Tapped by ${escapeHtml(name)}`;
    const flair = maybeFlair();
    const hunt = await rollHuntDrop(from.id).catch((err) => {
      console.error("⚠️  Tap hunt roll failed:", err.message);
      return null;
    });
    let huntLine = "";
    if (hunt) {
      const delivered = await sendDirect(ctx.token, from.id, huntMessage(hunt));
      huntLine =
        `\n📜 ${escapeHtml(hunt.sentence)}` +
        (delivered ? "" : "\n📩 Start a private chat with me to receive your words.");
    }
    await setProgress(
      `🔥 <b>${taps}</b>\n<a href="${EXPLORER_BASE_URL}/tx/${result.hash}">View transaction</a>\n` +
        `⛽ ${fuelGauge(result.balance)}${flair}${huntLine}`,
    );

    if (hunt?.won) {
      await sendText(ctx.token, chatId, "🏁 <b>Someone has collected all 24 words!</b>");
    }

    if (stats && stats.taps % MILESTONE_EVERY === 0) {
      await sendText(ctx.token, chatId, `🎉 <b>Milestone!</b> ${stats.taps.toLocaleString()} taps burned so far.`);
    }
  } catch (err) {
    console.error("⚠️  Tap failed:", err.message);
    await setProgress("⚠️ Tap failed. Try again in a moment.").catch(() => {});
  }
}

async function sendStats(ctx, chatId) {
  const [stats, leaderboard, balance] = await Promise.all([
    getTapStats().catch(() => null),
    getLeaderboard(10).catch(() => null),
    ctx.provider.getBalance(ctx.wallet.address),
  ]);

  const lines = [];
  if (stats) {
    const burned = Number(ethers.formatEther(stats.burnedWei)).toFixed(6);
    lines.push(`📊 <b>Tap stats</b>`, `🔥 Taps: ${stats.taps.toLocaleString()}`, `🪙 Gas burned: ${burned} ETN`);
  } else {
    lines.push(`📊 <b>Tap stats</b> unavailable (no database configured)`);
  }
  lines.push(`⛽ ${fuelGauge(balance)}`);
  if (leaderboard && leaderboard.length > 0) {
    lines.push("", `🏆 <b>Leaderboard</b>`);
    leaderboard.forEach((row, i) => lines.push(`${i + 1}. ${escapeHtml(row.name)} — ${row.taps.toLocaleString()}`));
  }
  await sendText(ctx.token, chatId, lines.join("\n"));
}

async function handleUpdate(ctx, update) {
  if (update.callback_query) {
    const cb = update.callback_query;
    if (!isAllowedChat(cb.message)) return;
    const chatId = cb.message.chat.id;
    await callApi(ctx.token, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
    if (cb.data === "tap") return handleTap(ctx, chatId, cb.from);
    if (cb.data === "donate") return sendDonation(ctx, chatId);
    return;
  }

  const message = update.message;
  if (!message?.text || !isAllowedChat(message)) return;
  const chatId = message.chat.id;
  if (/^\/(tap|menu)(@\w+)?(\s|$)/.test(message.text)) {
    if (message.chat.type === "private") {
      await sendText(ctx.token, chatId, MENU_TEXT, MENU_KEYBOARD, { persist: true });
    } else {
      await postMenu(ctx.token, chatId);
    }
  } else if (/^\/statto(@\w+)?(\s|$)/.test(message.text)) {
    await sendStats(ctx, chatId);
  } else {
    return;
  }
  scheduleDelete(ctx.token, chatId, message.message_id);
}

async function pollLoop(ctx) {
  let offset = 0;
  for (;;) {
    try {
      const updates = await callApi(ctx.token, "getUpdates", {
        offset,
        timeout: POLL_TIMEOUT_SECONDS,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        handleUpdate(ctx, update).catch((err) => console.error("⚠️  Tap bot update failed:", err.message));
      }
    } catch (err) {
      console.error("⚠️  Tap bot poll failed:", err.message);
      await sleep(5000);
    }
  }
}

export async function startTapBot() {
  if (!process.env.TAP_BOT_TOKEN || !process.env.TAP_WALLET_PRIVATE_KEY) {
    console.log("ℹ️  TAP_BOT_TOKEN / TAP_WALLET_PRIVATE_KEY not set — tap bot disabled");
    return;
  }

  const { provider, wallet } = getTapContext();
  const token = process.env.TAP_BOT_TOKEN;
  const me = await callApi(token, "getMe", {});
  burnGif = await buildBurnGif().catch((err) => {
    console.error("⚠️  Tap bot could not build burn GIF, using text progress:", err.message);
    return null;
  });

  console.log(`🔥 Tap bot @${me.username} started — wallet ${wallet.address}`);
  await ensureMenu(token).catch((err) => console.error("⚠️  Tap bot could not post menu:", err.message));
  setInterval(() => {
    ensureMenu(token).catch((err) => console.error("⚠️  Tap bot menu check failed:", err.message));
  }, MENU_CHECK_MS);
  pollLoop({ token, provider, wallet });
}
