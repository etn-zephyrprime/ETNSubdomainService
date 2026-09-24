// backend/services/tokenBurnService.js
//
// Backs TokenDetail.jsx's Tokens tab — a cumulative "how much of this token has been burned over
// time" chart, for whichever token a visitor happens to click into. Two different definitions of
// "burned", chosen per token:
//
//   - CORE has a genuine burn() function (see PlanetZephyros's own CORE.sol) that actually reduces
//     totalSupply() — every real burn, whether triggered by this app's own buyBackAndBurn(Token)
//     (see useBurnPool.js) or anything else, shows up as a Transfer to the TRUE zero address
//     (0x000...000). This is the exact same event coreClashBurnWatcher.js already watches for its
//     Telegram alerts — see that file's own header comment for the "why zero address, not just any
//     Transfer" reasoning (CORE's own fee-on-transfer tax also burns a cut on every ordinary
//     transfer, which is real and correctly counted here too, not just explicit burn() calls).
//   - Every other token on this chain has no burn() function at all (a plain ERC20 has no way to
//     reduce its own totalSupply from outside the contract) — sending to the conventional
//     0x000...dEaD address is simply a WIDELY-UNDERSTOOD CONVENTION for "I intend this gone
//     forever", not a real supply reduction. This chart shows that convention faithfully (real,
//     verifiable on-chain transfers to that address) without ever claiming it reduced totalSupply
//     the way CORE's does — see the frontend's own copy for how this distinction is presented.
//
// Per-token, resumable, dual-cursor scan — same "catch up to tip, backfill older history in the
// background" shape as nftSalesCache.js, just persisted per-token in Postgres (token_burn_cursor)
// rather than one shared R2 blob, since burns can happen on an arbitrary, unbounded number of
// different token contracts rather than one shared contract like Seaport. Each call to
// getTokenBurnHistory does a BOUNDED amount of scanning work (never a full unbounded history walk
// inline), so viewing a token's page stays fast even for an old, active token — same reasoning
// pnlIngestion.js's own MAX_BLOCK_RANGE-per-cycle scans use throughout this backend.
import { ethers } from "ethers";
import { createRpcProvider } from "../utils/rpcProvider.js";
import { fetchBlockscoutJson } from "../utils/blockscoutClient.js";
import { CORE_TOKEN_ADDRESS } from "../utils/coreClashConfig.js";
import { getTokenBurnCursor, upsertTokenBurnCursor, insertTokenBurnEvents, getTokenBurnEvents } from "../db/tokenBurns.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// The universally-recognized "burn" vanity address — not a real contract, nothing special about it
// on-chain, just the address the wider crypto community has converged on as the conventional
// destination for "send this somewhere no one can ever move it again."
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

const TRANSFER_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"];

// How much scanning work one call does at most, per cursor half (forward catch-up, backward
// backfill) — bounds a single request's own latency. Smaller than nftSalesCache.js's own
// MAX_BLOCKS_PER_CYCLE since this runs synchronously inline with a page view (no background
// interval driving it independently), not from a standalone scheduler tick.
const MAX_BLOCKS_PER_CALL = process.env.TOKEN_BURN_MAX_BLOCKS_PER_CALL
  ? parseInt(process.env.TOKEN_BURN_MAX_BLOCKS_PER_CALL, 10)
  : 20000;
// Skips re-scanning entirely when the cursor was touched more recently than this — a token detail
// page can be viewed repeatedly in a short window (a visitor switching tabs, a slow connection
// retrying); there's no reason to re-pay a live RPC log scan every single time when the last one
// finished moments ago. Matches this app's own established "cache is for repeat-within-a-window
// calls, not staleness" reasoning (see pnlSnapshotService.js's own SNAPSHOT_CACHE_TTL_MS comment).
const SCAN_COOLDOWN_MS = process.env.TOKEN_BURN_SCAN_COOLDOWN_MS
  ? parseInt(process.env.TOKEN_BURN_SCAN_COOLDOWN_MS, 10)
  : 60000;
const MAX_RECENT_EVENTS = 20;

let sharedProvider = null;
function getProvider() {
  if (!sharedProvider) sharedProvider = createRpcProvider({ batchMaxCount: 1 });
  return sharedProvider;
}

/** Which address counts as "burned" for this specific token — see this file's own header comment
 * for the CORE-vs-everything-else distinction. */
export function burnTargetAddress(tokenAddress) {
  if (CORE_TOKEN_ADDRESS && tokenAddress.toLowerCase() === CORE_TOKEN_ADDRESS.toLowerCase()) return ZERO_ADDRESS;
  return DEAD_ADDRESS;
}

// Same range-adaptive chunked scan duplicated across this repo's own on-chain-history caches (see
// nftSalesCache.js's identical queryLogsChunked for the full reasoning) — kept as its own copy per
// this file's established "small per-file helpers are fine to drift independently" convention.
async function queryLogsChunked(contract, filter, fromBlock, toBlock, chunkSize = 2000, minChunkSize = 50) {
  const events = [];
  let start = fromBlock;
  while (start <= toBlock) {
    let end = Math.min(start + chunkSize - 1, toBlock);
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

/** The token contract's own creation block, via Blockscout — the real floor for backfilling, so a
 * scan never wastes RPC calls walking empty ranges before the token existed at all. Best-effort:
 * null (not thrown) on any failure, in which case the caller falls back to a bounded lookback
 * instead of a true genesis-to-now backfill — a token whose creation lookup fails still gets a
 * useful "recent history" chart, just not a guaranteed-complete lifetime one. */
async function resolveDeployBlock(tokenAddress) {
  try {
    const addr = await fetchBlockscoutJson(`/addresses/${tokenAddress}`);
    const txHash = addr?.creation_transaction_hash;
    if (!txHash) return null;
    const tx = await fetchBlockscoutJson(`/transactions/${txHash}`);
    return tx?.block_number != null ? Number(tx.block_number) : null;
  } catch (err) {
    console.warn(`⚠️  Token burns: couldn't resolve deploy block for ${tokenAddress}:`, err.message);
    return null;
  }
}

async function scanRange(contract, provider, targetAddress, fromBlock, toBlock) {
  if (fromBlock > toBlock) return [];
  const logs = await queryLogsChunked(contract, contract.filters.Transfer(null, targetAddress), fromBlock, toBlock);
  if (logs.length === 0) return [];

  const uniqueBlocks = [...new Set(logs.map((e) => e.blockNumber))];
  const timestamps = new Map();
  await Promise.all(
    uniqueBlocks.map(async (blockNumber) => {
      try {
        const block = await provider.getBlock(blockNumber);
        timestamps.set(blockNumber, block ? block.timestamp * 1000 : null);
      } catch (err) {
        console.warn(`⚠️  Token burns: couldn't fetch timestamp for block ${blockNumber}:`, err.message);
        timestamps.set(blockNumber, null);
      }
    })
  );

  return logs
    .filter((log) => timestamps.get(log.blockNumber) != null) // no honest timestamp -> skip rather than fake one
    .map((log) => ({
      txHash: log.transactionHash,
      logIndex: log.index,
      fromAddress: log.args.from,
      amount: log.args.value.toString(),
      blockNumber: log.blockNumber,
      timestampMs: timestamps.get(log.blockNumber),
    }));
}

const inFlightScans = new Map(); // tokenAddress (lowercase) -> Promise, dedupes concurrent viewers of the same token

/** Does a BOUNDED amount of incremental scanning for `tokenAddress`, persisting any newly-found
 * burn events and advancing its cursor — never a full unbounded walk. Safe to call on every page
 * view: a fresh-enough cursor (see SCAN_COOLDOWN_MS) makes this a no-op past the initial DB read.
 * Best-effort — never throws; a scan failure just means this call's history is whatever was already
 * known, same "never let a nice-to-have background refresh take down the actual page" posture as
 * this app's other ingestion-adjacent features. */
async function ensureTokenBurnsScanned(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  if (inFlightScans.has(key)) return inFlightScans.get(key);

  const promise = (async () => {
    try {
      const cursor = await getTokenBurnCursor(tokenAddress);
      if (cursor && Date.now() - new Date(cursor.updatedAt).getTime() < SCAN_COOLDOWN_MS) return;

      const provider = getProvider();
      const targetAddress = burnTargetAddress(tokenAddress);
      const contract = new ethers.Contract(tokenAddress, TRANSFER_ABI, provider);
      const latestBlock = await provider.getBlockNumber();

      const deployBlock = cursor?.deployBlock ?? (await resolveDeployBlock(tokenAddress)) ?? 0;
      const newEvents = [];
      let lowScannedBlock = cursor?.lowScannedBlock ?? null;
      let highScannedBlock = cursor?.highScannedBlock ?? null;

      if (highScannedBlock == null) {
        // First time this token's ever been scanned — same "start recent, backfill older in the
        // background" bootstrap as nftSalesCache.js, so there's something real to show immediately
        // rather than making the very first viewer wait out however much history there is.
        const fromBlock = Math.max(deployBlock, latestBlock - MAX_BLOCKS_PER_CALL + 1);
        newEvents.push(...(await scanRange(contract, provider, targetAddress, fromBlock, latestBlock)));
        highScannedBlock = latestBlock;
        lowScannedBlock = fromBlock;
      } else {
        if (latestBlock > highScannedBlock) {
          newEvents.push(...(await scanRange(contract, provider, targetAddress, highScannedBlock + 1, latestBlock)));
          highScannedBlock = latestBlock;
        }
        if (lowScannedBlock > deployBlock) {
          const toBlock = lowScannedBlock - 1;
          const fromBlock = Math.max(deployBlock, toBlock - MAX_BLOCKS_PER_CALL + 1);
          newEvents.push(...(await scanRange(contract, provider, targetAddress, fromBlock, toBlock)));
          lowScannedBlock = fromBlock;
        }
      }

      await insertTokenBurnEvents(tokenAddress, newEvents);
      await upsertTokenBurnCursor(tokenAddress, { deployBlock, lowScannedBlock, highScannedBlock });
    } catch (err) {
      console.warn(`⚠️  Token burns: scan failed for ${tokenAddress} (serving whatever's already known):`, err.message);
    }
  })();

  inFlightScans.set(key, promise);
  try {
    await promise;
  } finally {
    inFlightScans.delete(key);
  }
}

/**
 * `{ isCore, burnAddress, totalBurnedRaw, series, recentEvents, fullyBackfilled }` for
 * `tokenAddress` — `totalBurnedRaw`/`series[].cumulativeRaw`/`recentEvents[].amount` are all raw
 * integer strings in the token's own smallest unit; the caller already has this token's `decimals`
 * (it's part of the same Blockscout token response TokenDetail.jsx already loaded) so formatting
 * happens at the frontend, not here — same division of responsibility as this app's other
 * raw-amount-in/decimals-from-caller conventions (e.g. ingestedTransfers.js). `series` is one point
 * per UTC day that had at least one burn, cumulative as of the END of that day — a chart connects
 * the dots, so no need to emit a redundant flat point for every day nothing happened.
 * `fullyBackfilled: true` once the scan has reached this token's own deploy block, so the frontend
 * can caveat an incomplete history honestly (same "still backfilling" convention as
 * NftSalesChart.jsx) rather than silently presenting a partial total as if it were the whole story.
 */
export async function getTokenBurnHistory(tokenAddress) {
  await ensureTokenBurnsScanned(tokenAddress);

  const [events, cursor] = await Promise.all([getTokenBurnEvents(tokenAddress), getTokenBurnCursor(tokenAddress)]);

  let cumulative = 0n;
  const byDay = new Map(); // "YYYY-MM-DD" -> cumulative raw BigInt as of end of that day
  for (const e of events) {
    cumulative += BigInt(e.amount);
    const day = new Date(e.timestampMs).toISOString().slice(0, 10);
    byDay.set(day, cumulative);
  }

  const series = [...byDay.entries()].map(([date, cumulativeRaw]) => ({ date, cumulativeRaw: cumulativeRaw.toString() }));
  const recentEvents = events.slice(-MAX_RECENT_EVENTS).reverse();

  return {
    isCore: burnTargetAddress(tokenAddress) === ZERO_ADDRESS,
    burnAddress: burnTargetAddress(tokenAddress),
    totalBurnedRaw: cumulative.toString(),
    totalEvents: events.length, // recentEvents is capped at MAX_RECENT_EVENTS — this is the real count
    series,
    recentEvents,
    fullyBackfilled: cursor != null && cursor.deployBlock != null && cursor.lowScannedBlock <= cursor.deployBlock,
  };
}
