// A gate for the memory-heavy work: anything that loads a wallet's FULL history (ingested_transfers, often
// tens of thousands of rows) and replays it — PnL ledgers, PnL / category / token / LP-composition
// history, the NFT PnL snapshot, Recent Activity, statement generation.
//
// Why: 2026-11-11 14:31 UTC the server died with "JavaScript heap out of memory". The heap had been flat at
// ~41% for an hour, then one Core Tier load rebuilt several wallets AT ONCE (each holding its full history
// plus the events derived from it) and went past the ~268 MB limit within a minute. Same-wallet requests were
// already merged (inFlight maps); nothing stopped DIFFERENT wallets — or different members — from building
// together. So:
//   - at most HEAVY_WORK_CONCURRENCY (default 2) of these run at once; the rest queue (FIFO);
//   - a queued job also waits while the heap is above HEAVY_WORK_HEAP_SOFT_PCT (default 70%) of its limit,
//     so a slot isn't handed out into a nearly-full heap — unless nothing heavy is running at all (the heap
//     can stay high from caches alone, and waiting on it then would never end);
//   - re-entrant: work started inside a gated job (an NFT snapshot building a ledger, a backfill re-using
//     buildEventsForWallet) runs in its parent's slot instead of waiting for a second one, which could
//     otherwise deadlock two parents each holding a slot.
import { AsyncLocalStorage } from "async_hooks";
import v8 from "v8";

const MAX = Math.max(1, Number(process.env.HEAVY_WORK_CONCURRENCY) || 2);
const HEAP_SOFT_PCT = Number(process.env.HEAVY_WORK_HEAP_SOFT_PCT) || 70;
const RECHECK_MS = 250;

const holding = new AsyncLocalStorage(); // true inside a gated job
let running = 0;
const queue = []; // [{ label, resolve, since }]
let ticker = null;
let lastQueuedLog = 0;
let peakQueued = 0;

/** Heap used as a % of its limit (the limit Node actually enforces). */
export function heapPct() {
  const s = v8.getHeapStatistics();
  return (s.used_heap_size / s.heap_size_limit) * 100;
}

function canStart() {
  if (running >= MAX) return false;
  return running === 0 || heapPct() < HEAP_SOFT_PCT;
}

function drain() {
  while (queue.length && canStart()) {
    const next = queue.shift();
    running++;
    next.resolve();
  }
  if (!queue.length && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function acquire(label) {
  if (!queue.length && canStart()) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    queue.push({ label, resolve, since: Date.now() });
    peakQueued = Math.max(peakQueued, queue.length);
    // re-check on a timer too: the heap can fall (GC) without any job finishing
    if (!ticker) {
      ticker = setInterval(drain, RECHECK_MS);
      ticker.unref?.();
    }
    if (Date.now() - lastQueuedLog > 60000) {
      lastQueuedLog = Date.now();
      console.log(`⏳ Heavy work queued: ${label} (${running} running, ${queue.length} waiting, heap ${heapPct().toFixed(0)}%)`);
    }
  });
}

function release() {
  running = Math.max(0, running - 1);
  drain();
}

/** Runs `fn` through the gate (or straight through when already inside a gated job). */
export async function runHeavy(label, fn) {
  if (holding.getStore()) return fn();
  await acquire(label);
  try {
    return await holding.run(true, fn);
  } finally {
    release();
  }
}

/** For the [mem] log line: { running, waiting, peakWaiting } (peak since the last call). */
export function heavyWorkStats() {
  const out = { running, waiting: queue.length, peakWaiting: peakQueued };
  peakQueued = queue.length;
  return out;
}

/** Tests only. */
export function _resetHeavyWork() {
  running = 0;
  queue.length = 0;
  if (ticker) clearInterval(ticker);
  ticker = null;
  peakQueued = 0;
}
