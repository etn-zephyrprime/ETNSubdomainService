// backend/utils/tapBot.js
//
// Telegram "tap" bot. Each Tap press sends a 0-value self-transfer from TAP_WALLET_PRIVATE_KEY, so
// the gas is the only cost and every tap burns a little ETN. Donate sends the wallet address and a
// QR code so people can top the wallet up. When the wallet can't cover gas, taps are refused and
// the donate prompt is shown instead.
//
// Uses long-polling (getUpdates) so it needs no public webhook URL. It needs its own bot token: a
// token that already has a webhook set elsewhere will make getUpdates fail with a 409 conflict.
import { ethers } from "ethers";
import QRCode from "qrcode";
import { createRpcProvider } from "./rpcProvider.js";

const TELEGRAM_API = "https://api.telegram.org";
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || "https://blockexplorer.electroneum.com";
const TAP_GAS_LIMIT = 21000n;
const POLL_TIMEOUT_SECONDS = 30;

const MENU_KEYBOARD = {
  inline_keyboard: [
    [{ text: "🔥 Tap (burn gas)", callback_data: "tap" }],
    [{ text: "💰 Donate ETN", callback_data: "donate" }],
  ],
};

// Taps share one wallet, so sends are serialized to keep nonces from colliding.
let sendQueue = Promise.resolve();
function enqueue(fn) {
  const run = sendQueue.then(fn);
  sendQueue = run.catch(() => {});
  return run;
}

async function callApi(token, method, body) {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((POLL_TIMEOUT_SECONDS + 10) * 1000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} failed: ${data.description}`);
  return data.result;
}

function sendText(token, chatId, text, replyMarkup = MENU_KEYBOARD) {
  return callApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
  });
}

async function sendDonation(ctx, chatId) {
  const png = await QRCode.toBuffer(ctx.wallet.address, { type: "png", margin: 2, width: 512 });
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("parse_mode", "HTML");
  form.append(
    "caption",
    `💰 <b>Donate ETN to keep the taps going</b>\n\n<code>${ctx.wallet.address}</code>\n\n` +
      `Scan the QR code or send ETN on Electroneum to the address above.`,
  );
  form.append("reply_markup", JSON.stringify(MENU_KEYBOARD));
  form.append("photo", new Blob([png], { type: "image/png" }), "donate.png");
  const res = await fetch(`${TELEGRAM_API}/bot${ctx.token}/sendPhoto`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`sendPhoto failed: ${data.description}`);
}

// Runs inside the send queue. Returns the tx hash, or null if the wallet can't cover gas.
async function sendTapTx(ctx) {
  const feeData = await ctx.provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
  const balance = await ctx.provider.getBalance(ctx.wallet.address);
  if (balance < TAP_GAS_LIMIT * gasPrice) return { hash: null, balance };

  const tx = await ctx.wallet.sendTransaction({
    to: ctx.wallet.address,
    value: 0n,
    gasLimit: TAP_GAS_LIMIT,
  });
  return { hash: tx.hash, balance };
}

async function handleTap(ctx, chatId) {
  const result = await enqueue(() => sendTapTx(ctx));
  if (!result.hash) {
    await sendText(
      ctx.token,
      chatId,
      `🪫 <b>Out of gas!</b> The tap wallet has ${ethers.formatEther(result.balance)} ETN left, not enough for the next tap.\n\n` +
        `Donate ETN to keep it running.`,
    );
    return;
  }
  await sendText(
    ctx.token,
    chatId,
    `🔥 <b>Tapped!</b> <a href="${EXPLORER_BASE_URL}/tx/${result.hash}">View transaction</a>`,
  );
}

async function handleUpdate(ctx, update) {
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    await callApi(ctx.token, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
    if (cb.data === "tap") return handleTap(ctx, chatId);
    if (cb.data === "donate") return sendDonation(ctx, chatId);
    return;
  }

  const text = update.message?.text;
  if (text && /^\/(start|menu)(@\w+)?(\s|$)/.test(text)) {
    await sendText(ctx.token, update.message.chat.id, "Tap to burn a little ETN, or donate to keep the taps going.");
  }
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
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

export async function startTapBot() {
  if (!process.env.TAP_BOT_TOKEN || !process.env.TAP_WALLET_PRIVATE_KEY) {
    console.log("ℹ️  TAP_BOT_TOKEN / TAP_WALLET_PRIVATE_KEY not set — tap bot disabled");
    return;
  }

  const provider = createRpcProvider();
  const wallet = new ethers.Wallet(process.env.TAP_WALLET_PRIVATE_KEY, provider);
  const token = process.env.TAP_BOT_TOKEN;
  const me = await callApi(token, "getMe", {});

  console.log(`🔥 Tap bot @${me.username} started — wallet ${wallet.address}`);
  pollLoop({ token, provider, wallet });
}
