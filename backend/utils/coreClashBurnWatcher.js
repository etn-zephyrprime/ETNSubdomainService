// backend/utils/coreClashBurnWatcher.js
//
// Ported from CoreClashGame/backend/burnListener.js. Watches CORE token Transfer events to the
// zero address (i.e. burns) and posts a Telegram alert for each — same poll-with-persisted-
// cursor shape as marketplaceWatcher.js, see coreClashConfig.js's file comment for why this
// moved here.
//
// Note: unlike the original, this doesn't maintain a running "total burned" figure in local
// state — CoreClashGame/backend/store/burnStore.js (fed by a *different*, still-running listener,
// eventListener.js) already owns that for the /burn-total endpoint the frontend reads. This
// watcher only ever needed totalSupply() for the message text, which it still reads live here.
import { ethers } from "ethers";
import { getState, setState } from "../state/coreClashState.js";
import { sendZephyrosAnimation, escapeHtml, zephyrosBotConfigured } from "./coreClashTelegram.js";
import { RPC_URL, EXPLORER_BASE_URL, CORE_TOKEN_ADDRESS, REVERSE_REGISTRAR_ADDRESS, POLL_INTERVAL_MS, LOOKBACK_BLOCKS } from "./coreClashConfig.js";
import { createPrimaryNameResolver } from "./primaryNameResolver.js";

const STATE_KEY = "burn-watcher";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const MAX_BLOCK_RANGE = 500;
const INITIAL_SUPPLY = 1_000_000;

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
];

function topicAddress(address) {
  return ethers.zeroPadValue(address, 32).toLowerCase();
}

// Inverse of topicAddress — pulls the address back out of an indexed topic's 32-byte padding.
// Transfer's `from` (the donor here) is topics[1]; topics[0] is the event signature.
function addressFromTopic(topic) {
  return ethers.getAddress(ethers.dataSlice(topic, 12));
}

async function queryLogsChunked(provider, filter, fromBlock, toBlock, chunkSize = MAX_BLOCK_RANGE, minChunkSize = 50) {
  const logs = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    try {
      const chunk = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
      logs.push(...chunk);
      start = end + 1;
    } catch (err) {
      const message = err?.info?.error?.message || err?.error?.message || err?.shortMessage || err?.message || "";
      const isRangeError = /block range/i.test(message) || /range is too large/i.test(message);
      if (isRangeError && chunkSize > minChunkSize) {
        chunkSize = Math.max(minChunkSize, Math.floor(chunkSize / 2));
        continue;
      }
      throw err;
    }
  }
  return logs;
}

let isPolling = false;

async function poll(token, symbol, decimals, resolveDisplayName) {
  if (isPolling) return;
  isPolling = true;

  try {
    const provider = token.runner;
    const latestBlock = await provider.getBlockNumber();

    const saved = await getState(STATE_KEY);
    let fromBlock = saved?.lastBlock ?? null;

    if (fromBlock == null) {
      fromBlock = Math.max(0, latestBlock - LOOKBACK_BLOCKS) - 1;
      console.log(`🔥 Burn watcher initialized — no saved state, looking back to block ${fromBlock + 1}`);
    }

    if (latestBlock <= fromBlock) return;

    const logs = await queryLogsChunked(
      provider,
      { address: CORE_TOKEN_ADDRESS, topics: [TRANSFER_TOPIC, null, topicAddress(ZERO_ADDRESS)] },
      fromBlock + 1,
      latestBlock
    );

    for (const log of logs) {
      try {
        const value = BigInt(log.data);
        const formatted = Number(ethers.formatUnits(value, decimals));
        const prettyAmount = formatted.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        const donor = addressFromTopic(log.topics[1]);
        const donorDisplay = await resolveDisplayName(donor);

        const totalSupplyRaw = await token.totalSupply({ blockTag: log.blockNumber });
        const totalSupplyFormatted = Number(ethers.formatUnits(totalSupplyRaw, decimals));
        const totalBurnedRaw = INITIAL_SUPPLY - totalSupplyFormatted;
        const totalBurned = totalBurnedRaw.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const burnPercent = ((totalBurnedRaw / INITIAL_SUPPLY) * 100).toFixed(2);

        const txUrl = `${EXPLORER_BASE_URL}/tx/${log.transactionHash}`;
        const donorUrl = `${EXPLORER_BASE_URL}/address/${donor}`;
        const caption =
          `🔥🔥 <b>${escapeHtml(symbol)} Burned!</b> 🔥🔥\n\n` +
          `<b>${escapeHtml(prettyAmount)} ${escapeHtml(symbol)}</b> is gone forever!\n\n` +
          `Donor: <a href="${escapeHtml(donorUrl)}">${escapeHtml(donorDisplay)}</a>\n\n` +
          `Total Burned: <b>${escapeHtml(totalBurned)} ${escapeHtml(symbol)}</b> (${escapeHtml(burnPercent)}%)\n\n` +
          `<a href="${escapeHtml(txUrl)}">View Transaction</a>`;

        // Same GIF file_id CoreClashGame's telegramBot.js used — file_ids are bot-scoped, not
        // chat-scoped, so it's still valid as long as this posts via the same Zephyros bot token.
        await sendZephyrosAnimation(
          "CgACAgQAAxkBAAMDaeiG7E_J1y18lV9NePlhqQRIv5cAAjgiAAJ5zkBT47yvPwTBxsA7BA",
          caption
        );

        console.log(`🔥 Burn alert sent for ${prettyAmount} ${symbol} (tx ${log.transactionHash})`);
      } catch (err) {
        console.error("⚠️  Failed to process burn log:", err.message);
      }
    }

    await setState(STATE_KEY, { lastBlock: latestBlock });
  } catch (err) {
    console.error("⚠️  Burn watcher poll failed:", err.message);
  } finally {
    isPolling = false;
  }
}

export async function startCoreClashBurnWatcher() {
  if (!CORE_TOKEN_ADDRESS) {
    console.log("ℹ️  CORE_TOKEN_ADDRESS not set — Core Clash burn watcher disabled");
    return;
  }
  if (!zephyrosBotConfigured()) {
    console.log("ℹ️  Zephyros bot not configured — Core Clash burn watcher disabled");
    return;
  }

  // batchMaxCount: 1 — same fix as marketplaceWatcher.js; this provider now also resolves the
  // donor's primary name via primaryNameResolver.js.
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const token = new ethers.Contract(CORE_TOKEN_ADDRESS, ERC20_ABI, provider);
  const resolveDisplayName = createPrimaryNameResolver(provider, REVERSE_REGISTRAR_ADDRESS);

  let symbol = "CORE";
  let decimals = 18;
  try {
    [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  } catch (err) {
    console.warn("⚠️  Failed to read CORE token metadata, using defaults:", err.message);
  }

  console.log(`🔥 Core Clash burn watcher started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  poll(token, symbol, decimals, resolveDisplayName);
  setInterval(() => poll(token, symbol, decimals, resolveDisplayName), POLL_INTERVAL_MS);
}
