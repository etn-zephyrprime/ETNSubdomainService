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
const MAX_TOP_BURNERS = 20; // TokenBurnChart.jsx shows 5, then "Show more" up to this many

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
async function queryLogsChunked(contract, filter, fromBlock, toBlock, chunkSize = 2000, minChunkSize = 50, onProgress) {
  const events = [];
  let start = fromBlock;
  while (start <= toBlock) {
    let end = Math.min(start + chunkSize - 1, toBlock);
    try {
      const chunk = await contract.queryFilter(filter, start, end);
      events.push(...chunk);
      start = end + 1;
      onProgress?.({ phase: "logs", scannedTo: end, rangeStart: fromBlock, rangeEnd: toBlock, foundSoFar: events.length });
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

async function scanRange(contract, provider, targetAddress, fromBlock, toBlock, onProgress) {
  if (fromBlock > toBlock) return [];
  const logs = await queryLogsChunked(contract, contract.filters.Transfer(null, targetAddress), fromBlock, toBlock, 2000, 50, onProgress);
  if (logs.length === 0) return [];

  const uniqueBlocks = [...new Set(logs.map((e) => e.blockNumber))];
  const timestamps = new Map();
  let timestampsDone = 0;
  await Promise.all(
    uniqueBlocks.map(async (blockNumber) => {
      try {
        const block = await provider.getBlock(blockNumber);
        timestamps.set(blockNumber, block ? block.timestamp * 1000 : null);
      } catch (err) {
        console.warn(`⚠️  Token burns: couldn't fetch timestamp for block ${blockNumber}:`, err.message);
        timestamps.set(blockNumber, null);
      } finally {
        timestampsDone += 1;
        onProgress?.({ phase: "timestamps", done: timestampsDone, total: uniqueBlocks.length });
      }
    })
  );

  // The Transfer log's own `from` is frequently just whichever contract happened to be forwarding
  // tokens at that moment — most commonly the ElectroSwap LP pool itself, mid-swap, paying out a
  // fee-on-transfer tax straight to the burn address — not the actual trader who caused the burn.
  // Confirmed live on the Tokens tab's Top Burners table: an LP pool address sitting at #1. Same
  // root cause, and same fix, as coreClashBurnWatcher.js's own "Donor" field once had (see that
  // file's git history) — prefer the transaction's own `from` (the EOA that actually signed and
  // submitted it), falling back to the log's `from` only if the transaction fetch fails.
  const uniqueTxHashes = [...new Set(logs.map((e) => e.transactionHash))];
  const txSenders = new Map();
  let sendersDone = 0;
  await Promise.all(
    uniqueTxHashes.map(async (txHash) => {
      try {
        const tx = await provider.getTransaction(txHash);
        if (tx?.from) txSenders.set(txHash, tx.from);
      } catch (err) {
        console.warn(`⚠️  Token burns: couldn't resolve sender for tx ${txHash} (falling back to the Transfer log's own "from"):`, err.message);
      } finally {
        sendersDone += 1;
        onProgress?.({ phase: "senders", done: sendersDone, total: uniqueTxHashes.length });
      }
    })
  );

  return logs
    .filter((log) => timestamps.get(log.blockNumber) != null) // no honest timestamp -> skip rather than fake one
    .map((log) => ({
      txHash: log.transactionHash,
      logIndex: log.index,
      fromAddress: txSenders.get(log.transactionHash) || log.args.from,
      amount: log.args.value.toString(),
      blockNumber: log.blockNumber,
      timestampMs: timestamps.get(log.blockNumber),
    }));
}

const inFlightScans = new Map(); // tokenAddress (lowercase) -> Promise, dedupes concurrent viewers/callers of the same token

/** Does ONE bounded step of incremental scanning for `tokenAddress` — forward catch-up to the
 * chain tip if it's behind, else one backward step toward its deploy block (same
 * MAX_BLOCKS_PER_CALL-sized step either way) — persisting any newly-found burn events and
 * advancing its cursor. Shared by ensureTokenBurnsScanned (one step per page view, cooldown-gated)
 * and backfillTokenFully (many steps back-to-back, for the standalone backfill script) — this is
 * the part that actually talks to the chain; the two callers differ only in how many times, how
 * often, and whether cooldown applies. Not wrapped in try/catch here — both callers handle that
 * themselves, since they react to a failure differently (silently give up vs. stop and report). */
async function scanOneStep(tokenAddress, cursor, onProgress) {
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
    newEvents.push(...(await scanRange(contract, provider, targetAddress, fromBlock, latestBlock, onProgress)));
    highScannedBlock = latestBlock;
    lowScannedBlock = fromBlock;
  } else {
    if (latestBlock > highScannedBlock) {
      newEvents.push(...(await scanRange(contract, provider, targetAddress, highScannedBlock + 1, latestBlock, onProgress)));
      highScannedBlock = latestBlock;
    }
    if (lowScannedBlock > deployBlock) {
      const toBlock = lowScannedBlock - 1;
      const fromBlock = Math.max(deployBlock, toBlock - MAX_BLOCKS_PER_CALL + 1);
      newEvents.push(...(await scanRange(contract, provider, targetAddress, fromBlock, toBlock, onProgress)));
      lowScannedBlock = fromBlock;
    }
  }

  await insertTokenBurnEvents(tokenAddress, newEvents);
  await upsertTokenBurnCursor(tokenAddress, { deployBlock, lowScannedBlock, highScannedBlock });

  return { newEventsCount: newEvents.length, deployBlock, lowScannedBlock, highScannedBlock, fullyBackfilled: lowScannedBlock <= deployBlock };
}

/** Kicks off a BOUNDED amount of incremental scanning for `tokenAddress` in the background (NOT
 * awaited by the caller — see getTokenBurnHistory below). Safe to call on every page view: a
 * fresh-enough cursor (see SCAN_COOLDOWN_MS) makes this a no-op past the initial cursor read, and
 * inFlightScans dedupes concurrent callers onto the same in-progress scan rather than starting a
 * second one.
 *
 * Deliberately fire-and-forget from the caller's perspective — this used to be awaited inline,
 * which meant a single slow/hanging RPC call (or a chain of range-too-large retries) blocked the
 * whole page load on it, and looked to a viewer exactly like a "stuck"/stale chart. Now the request
 * always returns immediately with whatever's already in Postgres (see getTokenBurnHistory), and
 * this runs after the response, same "return cached, refresh behind it" shape as
 * pnlSnapshotService.js's own getSnapshotFast/computeLivePnlSnapshot split.
 *
 * Best-effort — never throws; a scan failure just means this call's history is whatever was already
 * known, same "never let a nice-to-have background refresh take down the actual page" posture as
 * this app's other ingestion-adjacent features. */
function ensureTokenBurnsScanned(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  if (inFlightScans.has(key)) return inFlightScans.get(key);

  const promise = (async () => {
    try {
      const cursor = await getTokenBurnCursor(tokenAddress);
      if (cursor && Date.now() - new Date(cursor.updatedAt).getTime() < SCAN_COOLDOWN_MS) return;
      await scanOneStep(tokenAddress, cursor);
    } catch (err) {
      console.warn(`⚠️  Token burns: scan failed for ${tokenAddress} (serving whatever's already known):`, err.message);
    }
  })();

  inFlightScans.set(key, promise);
  promise.finally(() => inFlightScans.delete(key));
  return promise;
}

// A backfill run takes hundreds of steps back-to-back with zero pacing between them, each one
// itself several chunked queryFilter calls plus a getBlock per unique block — confirmed live to be
// enough burst volume to get BOTH rpcProvider.js endpoints 403'ing in the same run (the primary
// failing over to the secondary under this exact load, then the secondary's own burst-403 kicking
// in too — see rpcProvider.js's own comments on each). A page-view-triggered step never hits this
// (one step per request, naturally paced by real traffic), so this delay/retry only applies here.
const BACKFILL_STEP_DELAY_MS = process.env.TOKEN_BURN_BACKFILL_STEP_DELAY_MS
  ? parseInt(process.env.TOKEN_BURN_BACKFILL_STEP_DELAY_MS, 10)
  : 300;
const BACKFILL_STEP_RETRIES = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Repeatedly steps `tokenAddress` all the way back to its own deploy block, ignoring
 * SCAN_COOLDOWN_MS (a script run, not a page view — the whole point is to push through in one go
 * rather than wait for organic page views to each contribute one step). For
 * scripts/backfillTokenBurns.js only; every interactive request still goes through
 * ensureTokenBurnsScanned above. Shares inFlightScans with that function so a token being
 * backfilled here is never ALSO scanned by a concurrent page view (and vice versa) — one active
 * step per token at a time, same guarantee either caller gets on its own.
 *
 * Two things exist here specifically to survive a long run against rpcProvider.js's two shared,
 * public-node endpoints (see BACKFILL_STEP_DELAY_MS's own comment): a small pause between every
 * step, and a short retry-with-backoff (1s/3s/9s) on a step that fails, before giving up on this
 * token — a lone transient 403 no longer takes the whole token (and, since the script moves on
 * immediately otherwise, potentially the rest of the run) down with it.
 *
 * `onStep(stepResult)` fires after every step (for progress logging). `onProgress(progressEvent)`
 * fires MID-step — a single step can itself take a long time (a wide block range with a lot of
 * chunked log-querying, then a per-unique-block timestamp lookup and a per-unique-tx sender lookup
 * for whatever it found), and without this a caller hears nothing at all until the whole step
 * finishes. Three shapes: `{ phase: "logs", scannedTo, rangeStart, rangeEnd, foundSoFar }` per chunk
 * of the log query, `{ phase: "timestamps", done, total }` per resolved block timestamp, and
 * `{ phase: "senders", done, total }` per resolved transaction sender. Still throws once retries are
 * exhausted, since a script wants to know something went wrong, unlike the silent-best-effort
 * request path — the caller decides whether to keep going with the next token. */
export async function backfillTokenFully(tokenAddress, { onStep, onProgress, onRetry, maxSteps = 500 } = {}) {
  const key = tokenAddress.toLowerCase();
  while (inFlightScans.has(key)) await inFlightScans.get(key); // wait out any request-driven scan already in progress

  const promise = (async () => {
    let cursor = await getTokenBurnCursor(tokenAddress);
    for (let step = 0; step < maxSteps; step++) {
      let result;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await scanOneStep(tokenAddress, cursor, onProgress);
          break;
        } catch (err) {
          if (attempt >= BACKFILL_STEP_RETRIES) throw err;
          const delayMs = 1000 * 3 ** attempt;
          onRetry?.({ attempt: attempt + 1, maxAttempts: BACKFILL_STEP_RETRIES, delayMs, error: err });
          await sleep(delayMs);
        }
      }
      onStep?.(result);
      if (result.fullyBackfilled) return result;
      cursor = { deployBlock: result.deployBlock, lowScannedBlock: result.lowScannedBlock, highScannedBlock: result.highScannedBlock };
      if (BACKFILL_STEP_DELAY_MS > 0) await sleep(BACKFILL_STEP_DELAY_MS);
    }
    return { fullyBackfilled: false, hitMaxSteps: true };
  })();

  inFlightScans.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightScans.delete(key);
  }
}

/** True the moment a cursor is due for a rescan (never scanned yet, or SCAN_COOLDOWN_MS has
 * elapsed) — same test ensureTokenBurnsScanned itself uses to decide whether to skip, exposed here
 * so getTokenBurnHistory can report `refreshing` honestly instead of guessing from inFlightScans
 * alone (a scan that's due but hasn't been kicked off THIS call yet is still "about to happen"). */
function isScanDue(cursor) {
  return !cursor || Date.now() - new Date(cursor.updatedAt).getTime() >= SCAN_COOLDOWN_MS;
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
  // Read whatever's already persisted FIRST — this must never wait on on-chain scanning (see
  // ensureTokenBurnsScanned's own comment on why: a slow RPC call used to block this whole
  // response, which is what made the chart look stuck/stale rather than just "still catching up").
  const [events, cursor] = await Promise.all([getTokenBurnEvents(tokenAddress), getTokenBurnCursor(tokenAddress)]);
  const refreshing = inFlightScans.has(tokenAddress.toLowerCase()) || isScanDue(cursor);
  if (refreshing) ensureTokenBurnsScanned(tokenAddress); // not awaited — runs after this returns

  let cumulative = 0n;
  const byDay = new Map(); // "YYYY-MM-DD" -> cumulative raw BigInt as of end of that day
  for (const e of events) {
    cumulative += BigInt(e.amount);
    const day = new Date(e.timestampMs).toISOString().slice(0, 10);
    byDay.set(day, cumulative);
  }

  const series = [...byDay.entries()].map(([date, cumulativeRaw]) => ({ date, cumulativeRaw: cumulativeRaw.toString() }));
  const recentEvents = events.slice(-MAX_RECENT_EVENTS).reverse();

  // Which addresses have sent the most to the burn address, lifetime — computed from the same
  // event list already loaded above rather than a separate SQL aggregate: burns are rare enough
  // per token (same reasoning getTokenBurnEvents's own header comment gives for not paginating
  // them) that summing in JS here costs nothing extra, and it's one less query to keep in sync with
  // whatever this function already does to `events`. Ties (equal total burned) fall back to the
  // higher event count, then address, purely for a stable, deterministic order.
  const byAddress = new Map(); // lowercased from_address -> { totalRaw: BigInt, eventCount }
  for (const e of events) {
    const key = e.fromAddress.toLowerCase();
    const entry = byAddress.get(key) || { address: key, totalRaw: 0n, eventCount: 0 };
    entry.totalRaw += BigInt(e.amount);
    entry.eventCount += 1;
    byAddress.set(key, entry);
  }
  const topBurners = [...byAddress.values()]
    .sort((a, b) => (b.totalRaw > a.totalRaw ? 1 : b.totalRaw < a.totalRaw ? -1 : b.eventCount - a.eventCount || a.address.localeCompare(b.address)))
    .slice(0, MAX_TOP_BURNERS)
    .map((e) => ({ address: e.address, totalRaw: e.totalRaw.toString(), eventCount: e.eventCount }));

  return {
    isCore: burnTargetAddress(tokenAddress) === ZERO_ADDRESS,
    burnAddress: burnTargetAddress(tokenAddress),
    totalBurnedRaw: cumulative.toString(),
    totalEvents: events.length, // recentEvents is capped at MAX_RECENT_EVENTS — this is the real count
    series,
    recentEvents,
    topBurners,
    fullyBackfilled: cursor != null && cursor.deployBlock != null && cursor.lowScannedBlock <= cursor.deployBlock,
    refreshing,
  };
}
