// backend/scripts/resendCoreClashSwapAlert.js
//
// One-off: resends the CORE SELL alert for tx 0x51cf0e...bf93c7 (2026-09-12), whose trader showed
// as a raw address instead of the "og2017.etn" name that wallet actually OWNS — the exact bug
// primaryNameResolver.js's new Blockscout fallback fixes (see that file's own header comment).
//
// Reuses the EXACT figures from the original alert rather than re-deriving them from the swap
// event live: price/amounts are a point-in-time snapshot of that specific trade, not something
// that should be recomputed against today's live CORE/WETN price just to resend a corrected
// display name. Only the trader's resolved display name (now fixed) and the footer branding (see
// coreClashTelegram.js's buildFooter()) differ from the original message.
//
// node backend/scripts/resendCoreClashSwapAlert.js
import dotenv from "dotenv";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { createPrimaryNameResolver } from "../utils/primaryNameResolver.js";
import { sendZephyrosMessage, escapeHtml, zephyrosBotConfigured, GENERAL_THREAD_ID } from "../utils/coreClashTelegram.js";
import { EXPLORER_BASE_URL, REVERSE_REGISTRAR_ADDRESS } from "../utils/coreClashConfig.js";

dotenv.config();

const TX_HASH = "0x51cf0efa67e26e91cad9c082bf5b1e6aeea2766ac16662090c5ae56b83bf93c7";
const TRADER = "0x3D6571e00A60BD983086321Cc48a23e141Dc304f";
const USD_VALUE = 54.51;
const WETN_RECEIVED = "49,203.034211";
const CORE_AMOUNT = "3,000.00";
const CORE_PRICE_USD = "0.019871";

async function main() {
  if (!zephyrosBotConfigured()) {
    throw new Error("Zephyros bot not configured (COREBOT_ZEPHYROS_BOT_TOKEN / COREBOT_TELEGRAM_CHAT_ID) — nothing to resend with.");
  }

  const provider = createRpcProvider({ batchMaxCount: 1 });
  const resolveDisplayName = createPrimaryNameResolver(provider, REVERSE_REGISTRAR_ADDRESS);
  const traderDisplay = await resolveDisplayName(TRADER);
  console.log(`Resolved trader display name: ${traderDisplay}`);
  if (traderDisplay.startsWith(TRADER.slice(0, 6))) {
    console.warn("⚠️  Still resolving to a short address — the fallback may not be picking this wallet up. Resending anyway.");
  }

  const txUrl = `${EXPLORER_BASE_URL}/tx/${TX_HASH}`;
  const traderUrl = `${EXPLORER_BASE_URL}/address/${TRADER}`;
  // Same emoji-line formula as coreClashSwapWatcher.js's own message builder — reproduced here
  // (not imported, it's not exported) so this resend renders identically to the original.
  const emojiSequence = ["🌎", "🌳"];
  const emojiCount = Math.min(Math.max(1, Math.floor(USD_VALUE / 5)), 50);
  const emojiLine = Array.from({ length: emojiCount }, (_, i) => emojiSequence[i % emojiSequence.length]).join("");

  const caption =
    `<b>CORE SELL</b> ($${USD_VALUE.toFixed(2)})\n` +
    `${emojiLine}\n\n` +
    `💰 <b>Received:</b> ${WETN_RECEIVED} WETN\n` +
    `🔢 <b>Amount:</b> ${CORE_AMOUNT} CORE\n` +
    `💵 <b>CORE Price:</b> $${CORE_PRICE_USD}\n` +
    `\n👤 <b>Buyer:</b> <a href="${traderUrl}">${escapeHtml(traderDisplay)}</a>\n` +
    `🔗 <a href="${txUrl}">View Transaction</a>`;

  await sendZephyrosMessage(caption, { threadId: GENERAL_THREAD_ID });
  console.log("✅ Resent.");
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exitCode = 1;
});
