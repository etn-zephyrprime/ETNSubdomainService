import { ethers } from "ethers";
import { sendTelegramMessage, telegramConfigured } from "./telegramNotifier.js";
import { getSubnamePriceAlertState, setSubnamePriceAlertState } from "../state/subnamePriceAlertState.js";
import { createRpcProvider } from "./rpcProvider.js";

// Watches the Marketplace contract's SubnamePricePerYearSet event and posts ONE batched Telegram
// notification per domain, instead of one per event — an owner adjusting a domain's pricing
// commonly fires this event several times in a row (once per currency touched, or just several
// quick edits while dialing in a price), and without batching that would spam the public channel
// with up to one message per edit for what's really a single pricing update from the owner's own
// perspective.
//
// Batching is a SLIDING debounce, not a fixed window from the first edit: every new price change
// to a domain resets that domain's own 10-minute clock, and the summary only sends once 10 minutes
// have passed with no further changes to that domain. This deliberately means a domain the owner
// keeps actively tweaking never sends mid-edit — the notification only fires once they're actually
// done, which is what "wait 10 minutes and batch it together" means in practice for someone
// dialing in prices, rather than a fixed window that could fire while they're still mid-edit.
//
// Same chain/contract defaults as subnameDomainsCache.js/marketplaceWatcher.js, overridable via
// env for a different deployment.
const MARKETPLACE_ADDRESS = process.env.MARKETPLACE_ADDRESS || "0xFD8944132Cf464Fb756F98D1d203Edf74A2B7aD5";
const MARKETPLACE_DEPLOY_BLOCK = process.env.MARKETPLACE_DEPLOY_BLOCK
  ? parseInt(process.env.MARKETPLACE_DEPLOY_BLOCK, 10)
  : 15906639;
const NAME_WRAPPER_ADDRESS = process.env.NAME_WRAPPER_ADDRESS || "0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64";
const SITE_URL = process.env.SITE_URL || "https://nameservice.planetzephyros.xyz";

// How often to check for new price-set events AND for domains whose debounce window has elapsed.
// Deliberately tighter than marketplaceWatcher.js's 5-minute interval — this only queries one
// event type on one contract, so the RPC cost per tick is much smaller — and needs to stay
// meaningfully shorter than BATCH_WINDOW_MS below for "10 minutes after their last edit" to
// actually hold within a couple minutes of accuracy, rather than only being checked once every
// several minutes.
const POLL_INTERVAL_MS = process.env.SUBNAME_PRICE_ALERT_POLL_INTERVAL_MS
  ? parseInt(process.env.SUBNAME_PRICE_ALERT_POLL_INTERVAL_MS, 10)
  : 120000;
// The sliding debounce window itself — see header comment above.
const BATCH_WINDOW_MS = process.env.SUBNAME_PRICE_ALERT_BATCH_WINDOW_MS
  ? parseInt(process.env.SUBNAME_PRICE_ALERT_BATCH_WINDOW_MS, 10)
  : 10 * 60 * 1000;
// Same cold-start reasoning as marketplaceWatcher.js's WATCHER_LOOKBACK_BLOCKS — covers both a
// genuine first run and a restart on a host that wipes local disk (Render's free tier).
const WATCHER_LOOKBACK_BLOCKS = process.env.WATCHER_LOOKBACK_BLOCKS
  ? parseInt(process.env.WATCHER_LOOKBACK_BLOCKS, 10)
  : 50000;

const MARKETPLACE_ABI = [
  "event SubnamePricePerYearSet(bytes32 indexed parentNode, address indexed paymentToken, uint256 pricePerYear)",
];
// Same minimal signature as subnameDomainsCache.js's own copy.
const NAME_WRAPPER_ABI = ["function names(bytes32 node) view returns (bytes)"];

// Same decoder as marketplaceWatcher.js's own copy (full dotted name, not just the top label).
function decodeDnsName(hex) {
  const bytes = ethers.getBytes(hex);
  const labels = [];
  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i];
    if (len === 0) break;
    if (i + 1 + len > bytes.length) break;
    labels.push(ethers.toUtf8String(bytes.slice(i + 1, i + 1 + len)));
    i += 1 + len;
  }
  return labels.join(".");
}

// Same 9 tokens marketplaceWatcher.js's own TOKEN_DECIMALS_BY_ADDRESS tracks — duplicated per
// this file's own "fine to drift independently" convention rather than shared.
const TOKEN_DECIMALS_BY_ADDRESS = {
  "0x043fAa1b5C5FC9a7dc35171f290c29ECDE0cCff1": { symbol: "BOLT", decimals: 18 },
  "0x309B916b3A90cb3E071697Ea9680e9217A30066f": { symbol: "CORE", decimals: 18 },
  "0xEe432C220273e4F949007B4c1946562826Efa055": { symbol: "DYNO", decimals: 18 },
  "0xc20d02538368D8F7deBeAeB99D9a8b4d4D1DDC1C": { symbol: "PDY", decimals: 18 },
  "0x075533AB8EeC6A6999F07C8bc2f1900eB8312e25": { symbol: "FUGAZI", decimals: 18 },
  "0x3187deAd7A2Bd6770F5Fe81495D1B715926AAe6e": { symbol: "USDC", decimals: 6 },
  "0x48E722f1458b253c2FB0E573F939318D7Dbd54e7": { symbol: "USDT", decimals: 6 },
  "0xC9FC4AB00911793D99b5c7Bd01f01203C21D4131": { symbol: "CLUB", decimals: 18 },
  "0xE74e4E7A064310466f3bdBd3F3Ce4e8c8F7CF1d5": { symbol: "DCNT", decimals: 18 },
};

function resolveCurrency(paymentToken) {
  if (paymentToken === ethers.ZeroAddress) return { symbol: "ETN", decimals: 18 };
  const known = TOKEN_DECIMALS_BY_ADDRESS[paymentToken];
  if (!known) {
    console.warn(`⚠️  Unrecognized payment token ${paymentToken} — notification will show "?" instead of a real symbol`);
    return { symbol: "?", decimals: 18 };
  }
  return known;
}

// pricePerYear is a decimal-string (see how it's stored in poll() below) — `0` is
// setSubnamePricePerYear's own "turned off for this currency" convention, same as
// subnameDomainsCache.js's identical check.
function formatPriceLine(paymentToken, pricePerYear) {
  const currency = resolveCurrency(paymentToken);
  if (pricePerYear === "0") return `❌ ${currency.symbol} pricing turned off`;
  const amount = parseFloat(ethers.formatUnits(pricePerYear, currency.decimals)).toFixed(2);
  return `${amount} ${currency.symbol}/year`;
}

// Same RPC block-range flakiness handled in marketplaceWatcher.js's own copy — duplicated rather
// than imported for the same "fine to drift independently" reasoning stated there.
async function queryLogsChunked(contract, filter, fromBlock, toBlock, chunkSize = 1000, minChunkSize = 50) {
  const events = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    try {
      const chunk = await contract.queryFilter(filter, start, end);
      events.push(...chunk);
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
  return events;
}

// One summary line per currency touched during the window, each showing only the LATEST price for
// that currency — several edits to the same currency within the window collapse to just its final
// value, not a list of every intermediate one. That's the point of batching: one clean "here's
// where it landed" message, not a log of every edit along the way.
async function sendBatchedNotification(entry) {
  const latestByCurrency = new Map();
  for (const change of entry.changes) {
    const existing = latestByCurrency.get(change.paymentToken);
    if (!existing || change.blockNumber > existing.blockNumber) {
      latestByCurrency.set(change.paymentToken, change);
    }
  }

  const lines = [...latestByCurrency.values()]
    .sort((a, b) => a.blockNumber - b.blockNumber)
    .map((c) => `• ${formatPriceLine(c.paymentToken, c.pricePerYear)}`);

  await sendTelegramMessage(
    `💲 *Subname Pricing Updated*\n` +
    `Domain: \`${entry.label}\`\n` +
    lines.join("\n") + "\n" +
    `[Get a Subname](${SITE_URL}/subnames/${entry.label})`
  );
}

let isRunning = false;

async function poll(provider, marketplace, nameWrapper) {
  if (isRunning) return; // previous tick still in flight — skip rather than overlap
  isRunning = true;
  try {
    const state = await getSubnamePriceAlertState();
    const pending = state.pending || {};
    const latestBlock = await provider.getBlockNumber();

    let fromBlock = state.lastProcessedBlock;
    if (fromBlock === null) {
      fromBlock = Math.max(MARKETPLACE_DEPLOY_BLOCK, latestBlock - WATCHER_LOOKBACK_BLOCKS) - 1;
      console.log(`📡 Subname price alert watcher initialized — no saved state, looking back to block ${fromBlock + 1}`);
    }

    if (latestBlock > fromBlock) {
      const events = await queryLogsChunked(
        marketplace,
        marketplace.filters.SubnamePricePerYearSet(),
        fromBlock + 1,
        latestBlock
      );
      // Ascending (block, logIndex) order so "last change wins" (both here and in
      // sendBatchedNotification's own per-currency fold) reflects real on-chain order.
      events.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

      const now = Date.now();
      for (const event of events) {
        try {
          const { parentNode, paymentToken, pricePerYear } = event.args;
          let entry = pending[parentNode];
          if (!entry) {
            let label;
            try {
              label = decodeDnsName(await nameWrapper.names(parentNode));
            } catch (err) {
              console.error(`⚠️  Failed to decode label for ${parentNode}:`, err.message);
              continue; // can't build a useful notification without a name to show
            }
            if (!label) continue;
            entry = { label, changes: [] };
            pending[parentNode] = entry;
          }
          entry.changes.push({
            paymentToken,
            pricePerYear: pricePerYear.toString(),
            blockNumber: event.blockNumber,
            txHash: event.transactionHash,
          });
          entry.lastChangedAt = now; // resets this domain's own debounce clock — see header comment
        } catch (err) {
          console.error(`⚠️  Failed to record price change for tx ${event.transactionHash}:`, err.message);
        }
      }

      state.lastProcessedBlock = latestBlock;
    }

    // Flush any domain that's been quiet for BATCH_WINDOW_MS since ITS OWN last change —
    // independent of whether this tick found any new events at all, since a domain can go quiet
    // on a tick that itself has nothing new to scan.
    const now = Date.now();
    for (const [parentNode, entry] of Object.entries(pending)) {
      if (now - entry.lastChangedAt < BATCH_WINDOW_MS) continue;

      try {
        await sendBatchedNotification(entry);
      } catch (err) {
        console.error(`⚠️  Failed to send subname price alert for ${entry.label}:`, err.message);
      }
      // Best-effort — a failed send isn't retried, same as every other notify* function in this
      // backend (see marketplaceWatcher.js's own comment on this).
      delete pending[parentNode];
    }

    state.pending = pending;
    await setSubnamePriceAlertState(state);
  } catch (err) {
    console.error("⚠️  Subname price alert watcher poll failed:", err.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the background poller. No-op if Telegram isn't configured (same guard as
 * marketplaceWatcher.js) or if R2 isn't configured. Unlike a plain scan cursor, LOSING the pending
 * batch state on every restart (Render's free tier wipes local disk) would mean an owner's
 * in-progress edit could get split across a restart and notified twice, or a completed edit could
 * get silently dropped if the restart happens to land inside its window. Since the entire point of
 * this feature is avoiding noisy/duplicate notifications, running it without durable state would
 * work against its own purpose — better to not run at all than to run unreliably, same reasoning
 * subnameDomainsCache.js already gives for its own R2-only requirement.
 */
export function startSubnamePriceChangeWatcher() {
  if (!telegramConfigured()) {
    console.log("ℹ️  Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — subname price alert watcher disabled");
    return;
  }
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET_NAME || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log("ℹ️  R2 not configured — subname price alert watcher disabled (batching state wouldn't survive a restart)");
    return;
  }

  const provider = createRpcProvider();
  const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MARKETPLACE_ABI, provider);
  const nameWrapper = new ethers.Contract(NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);

  console.log(`📡 Subname price alert watcher started (polling every ${POLL_INTERVAL_MS / 1000}s, ${BATCH_WINDOW_MS / 60000}min batch window)`);
  poll(provider, marketplace, nameWrapper); // run once immediately rather than waiting a full interval
  setInterval(() => poll(provider, marketplace, nameWrapper), POLL_INTERVAL_MS);
}
