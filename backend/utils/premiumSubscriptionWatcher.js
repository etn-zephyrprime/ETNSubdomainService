// backend/utils/premiumSubscriptionWatcher.js
//
// Polls the PremiumSubscription contract (see PlanetZephyros repo) for MembershipPurchased,
// AnnualMembershipPurchased, and PnlPeriodPurchased events and writes them into Postgres — this is
// the ONLY thing that creates statement_requests rows, and it only ever does so from a confirmed
// on-chain event, never from a client-submitted "I paid" claim (see PremiumSubscription.sol's own
// header comment on this same trust boundary). Same polling-with-cursor shape as
// marketplaceWatcher.js/coreClashSwapWatcher.js — duplicated rather than shared, same "fine to
// drift independently" reasoning those files give.
import { ethers } from "ethers";
import { createRpcProvider } from "./rpcProvider.js";
import { getPremiumSubscriptionWatcherState, setPremiumSubscriptionWatcherState } from "../state/premiumSubscriptionWatcherState.js";
import { upsertMembership, getMembership } from "../db/premiumMemberships.js";
import { createFromPurchase } from "../db/statementRequests.js";
import { getPool } from "../db/pool.js";
import { sendTelegramMessage, telegramConfigured } from "./telegramNotifier.js";
import { createPrimaryNameResolver } from "./primaryNameResolver.js";
import { EXPLORER_BASE_URL } from "../services/pnlIngestion.js";

// Same value as src/config.js's REVERSE_REGISTRAR_ADDRESS / marketplaceWatcher.js's own constant —
// needed to resolve a subscriber to a primary name for the group notification below.
const REVERSE_REGISTRAR_ADDRESS = process.env.REVERSE_REGISTRAR_ADDRESS || "0xFBB14eDBD8D3f6E7BB240bFA388f6582df0d8E7A";

// No default — unlike MARKETPLACE_ADDRESS, this contract isn't deployed yet as of this file's
// introduction, and a scanner silently doing nothing against a wrong/placeholder address would be
// far worse than an explicit "disabled, no address configured" no-op at startup.
const PREMIUM_SUBSCRIPTION_ADDRESS = process.env.PREMIUM_SUBSCRIPTION_ADDRESS;
const PREMIUM_SUBSCRIPTION_DEPLOY_BLOCK = process.env.PREMIUM_SUBSCRIPTION_DEPLOY_BLOCK
  ? parseInt(process.env.PREMIUM_SUBSCRIPTION_DEPLOY_BLOCK, 10)
  : 0;
const POLL_INTERVAL_MS = process.env.PREMIUM_SUBSCRIPTION_POLL_INTERVAL_MS
  ? parseInt(process.env.PREMIUM_SUBSCRIPTION_POLL_INTERVAL_MS, 10)
  : 60000; // real money changing hands here, unlike the 5-minute-is-fine Telegram notifications elsewhere — poll faster
// Same reasoning as marketplaceWatcher.js's WATCHER_LOOKBACK_BLOCKS — covers both a genuine first
// run and a cold start on ephemeral storage (Render's free tier wipes local disk on spin-down).
const WATCHER_LOOKBACK_BLOCKS = process.env.PREMIUM_SUBSCRIPTION_LOOKBACK_BLOCKS
  ? parseInt(process.env.PREMIUM_SUBSCRIPTION_LOOKBACK_BLOCKS, 10)
  : 50000;

const PREMIUM_SUBSCRIPTION_ABI = [
  "event MembershipPurchased(address indexed subscriber, uint256 numMonths, uint256 paid, uint256 newExpiry)",
  "event AnnualMembershipPurchased(address indexed subscriber, uint256 numYears, uint256 paid, uint256 newExpiry)",
  "event PnlPeriodPurchased(address indexed payer, address indexed trackedWallet, uint8 periodType, uint16 year, uint64 periodEnd, uint256 amountPaid)",
];

// Same RPC block-range-flakiness handling as marketplaceWatcher.js's identical helper.
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

function formatEtn(wei) {
  return parseFloat(ethers.formatEther(wei)).toFixed(2);
}

// Posted to the same fixed group channel every other public Telegram notification in this backend
// uses (sendTelegramMessage's TELEGRAM_CHAT_ID) — best-effort: a failed post here must never undo
// the membership write above (already committed by the time this runs) or stop the rest of this
// poll's events from processing, see handleMembershipPurchased's own try/catch around this call.
async function notifyMembershipGroup({ subscriber, tier, paid, duration, expiryTimestamp, txHash, isRenewal, resolveDisplayName }) {
  if (!telegramConfigured()) return;

  const display = await resolveDisplayName(subscriber);
  const tierLabel = tier === "annual" ? "Annual" : "Monthly";
  const durationNum = Number(duration);
  const durationLabel = `${durationNum} ${tier === "annual" ? "year" : "month"}${durationNum === 1 ? "" : "s"}`;
  const txUrl = `${EXPLORER_BASE_URL}/tx/${txHash}`;

  await sendTelegramMessage(
    `${isRenewal ? "🔁 *Core Tier Renewal*" : "💳 *New Core Tier Subscriber*"}\n` +
    `Member: \`${display}\`\n` +
    `Tier: \`${tierLabel} (${durationLabel})\`\n` +
    `Paid: \`${formatEtn(paid)} ETN\`\n` +
    `Now expires: \`${expiryTimestamp.toISOString().slice(0, 10)}\`\n` +
    `[View Transaction](${txUrl})`
  );
}

async function handleMembershipPurchased(event, tier, resolveDisplayName) {
  const { subscriber, paid, newExpiry } = event.args;
  const duration = tier === "annual" ? event.args.numYears : event.args.numMonths;
  const expiryTimestamp = new Date(Number(newExpiry) * 1000);

  // Fetched BEFORE the upsert below — whether this tier's column already had a value is exactly
  // what distinguishes a brand-new subscriber from a renewal for the group notification. A wallet
  // that already held this tier before (active or lapsed) counts as a renewal; one that never did
  // is a new subscriber — see this file's own header comment on the two tiers being tracked
  // independently.
  const existing = await getMembership(subscriber);
  const priorExpiry = tier === "annual" ? existing?.annual_expiry : existing?.monthly_expiry;
  const isRenewal = priorExpiry != null;

  await upsertMembership(subscriber, tier, expiryTimestamp, event.transactionHash);
  console.log(`💳 ${tier === "annual" ? "Annual" : "Monthly"} membership purchased: ${subscriber} — now expires ${expiryTimestamp.toISOString()} (tx ${event.transactionHash})`);

  try {
    await notifyMembershipGroup({
      subscriber,
      tier,
      paid,
      duration,
      expiryTimestamp,
      txHash: event.transactionHash,
      isRenewal,
      resolveDisplayName,
    });
  } catch (err) {
    console.warn(`⚠️  Membership group notification failed for ${subscriber}:`, err.message);
  }
}

async function handlePnlPeriodPurchased(event) {
  const { payer, trackedWallet, periodType, year, amountPaid } = event.args;

  const created = await createFromPurchase({
    txHash: event.transactionHash,
    logIndex: event.index,
    periodType: Number(periodType),
    year: Number(year),
    trackedWallet,
    payerWallet: payer,
    amountPaidWei: amountPaid,
  });
  if (created) {
    console.log(`📄 Statement request created: ${created.id} (wallet ${trackedWallet}, periodType ${periodType}, year ${year}, tx ${event.transactionHash})`);
  }
  // created === null means this exact (tx_hash, log_index) was already recorded — expected on a
  // re-scanned/overlapping block range, not an error.
}

let isPolling = false;

async function poll(contract, resolveDisplayName) {
  if (isPolling) return;
  isPolling = true;
  try {
    const latestBlock = await contract.runner.getBlockNumber();
    const saved = await getPremiumSubscriptionWatcherState();
    let fromBlock = saved?.lastProcessedBlock ?? null;

    if (fromBlock === null) {
      fromBlock = Math.max(PREMIUM_SUBSCRIPTION_DEPLOY_BLOCK, latestBlock - WATCHER_LOOKBACK_BLOCKS) - 1;
      console.log(`💳 Premium subscription watcher initialized — no saved state, looking back to block ${fromBlock + 1}`);
    }

    if (latestBlock <= fromBlock) return;

    const [monthlyMemberships, annualMemberships, pnlPurchases] = await Promise.all([
      queryLogsChunked(contract, contract.filters.MembershipPurchased(), fromBlock + 1, latestBlock),
      queryLogsChunked(contract, contract.filters.AnnualMembershipPurchased(), fromBlock + 1, latestBlock),
      queryLogsChunked(contract, contract.filters.PnlPeriodPurchased(), fromBlock + 1, latestBlock),
    ]);

    const events = [...monthlyMemberships, ...annualMemberships, ...pnlPurchases].sort(
      (a, b) => a.blockNumber - b.blockNumber || a.index - b.index
    );

    for (const event of events) {
      try {
        if (event.eventName === "MembershipPurchased") {
          await handleMembershipPurchased(event, "monthly", resolveDisplayName);
        } else if (event.eventName === "AnnualMembershipPurchased") {
          await handleMembershipPurchased(event, "annual", resolveDisplayName);
        } else if (event.eventName === "PnlPeriodPurchased") {
          await handlePnlPeriodPurchased(event);
        }
      } catch (err) {
        // One bad event must not stop lastProcessedBlock from advancing or block the rest —
        // matches marketplaceWatcher.js's identical reasoning. Unlike that file's Telegram
        // notifications, though, a failure HERE means a payment silently didn't get its
        // statement_requests row — logged loudly (not just a console.error one-liner) since this
        // is a stronger correctness gap than a missed notification.
        console.error(`❌ Failed to process ${event.eventName} for tx ${event.transactionHash} — this payment may need manual reconciliation:`, err.message);
      }
    }

    await setPremiumSubscriptionWatcherState({ lastProcessedBlock: latestBlock });
  } catch (err) {
    console.error("⚠️  Premium subscription watcher poll failed:", err.message);
  } finally {
    isPolling = false;
  }
}

/**
 * Starts the background poller. No-op if PREMIUM_SUBSCRIPTION_ADDRESS or DATABASE_URL isn't
 * configured — same reasoning as this repo's other optional features (see startMarketplaceWatcher).
 */
export function startPremiumSubscriptionWatcher() {
  if (!PREMIUM_SUBSCRIPTION_ADDRESS) {
    console.log("ℹ️  PREMIUM_SUBSCRIPTION_ADDRESS not set — premium subscription watcher disabled");
    return;
  }
  if (!getPool()) {
    console.log("ℹ️  DATABASE_URL not set — premium subscription watcher disabled");
    return;
  }

  const provider = createRpcProvider({ batchMaxCount: 1 });
  const contract = new ethers.Contract(PREMIUM_SUBSCRIPTION_ADDRESS, PREMIUM_SUBSCRIPTION_ABI, provider);
  // Resolves a subscriber to a primary name for the group notification — same helper/contract
  // address every other Telegram-posting watcher in this backend uses (see marketplaceWatcher.js).
  const resolveDisplayName = createPrimaryNameResolver(provider, REVERSE_REGISTRAR_ADDRESS);

  console.log(`💳 Premium subscription watcher started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  poll(contract, resolveDisplayName);
  setInterval(() => poll(contract, resolveDisplayName), POLL_INTERVAL_MS);
}
