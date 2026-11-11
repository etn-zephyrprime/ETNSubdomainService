// backend/scripts/measureLedgerRebuild.js
//
// Times one full PnL ledger rebuild per wallet, phase by phase — exactly what getLedgerState
// (pnlSnapshotService.js) does on a cache miss (after a restart, or once ingestion lands new data):
// read the whole history (transfers, swaps, DeFi activity), build events, replay FIFO, total gas.
// Read-only: no ingestion, no writes. Used to decide whether persisting a lot checkpoint is worth it.
//
// Runs each wallet twice:
//   run 1 — a fresh process, like the first rebuild after a deploy/restart (price and farm-metadata
//           memos empty);
//   run 2 — the same process 21s later (past the 20s transfers memo), like a rebuild after new
//           ingestion on a long-running server: database reads again, in-memory price memos warm.
//
// Usage (from backend/):
//   node scripts/measureLedgerRebuild.js <wallet> [<wallet> ...]
// Wallets given together are treated as one member's group (each is self-owned for the others),
// the same as the PnL page.
//
// Also reports each rebuild's PEAK heap (sampled every 20ms, not just at the end) against the heap limit —
// how much one rebuild needs at once, i.e. how many can safely run together (utils/heavyWork.js's
// HEAVY_WORK_CONCURRENCY; the 2026-11-11 heap OOM came from several running at once).
import dotenv from "dotenv";
import { getPool } from "../db/pool.js";
import { getAllTransfersBefore } from "../db/ingestedTransfers.js";
import { getAllSwapTradesBefore } from "../db/swapTrades.js";
import { getAllDefiActivityBefore } from "../db/defiActivity.js";
import { buildNftEvents, buildDefiFarmEvents, assembleLedgerEvents, computeGasFeesUsd } from "../services/pnlEventBuilder.js";
import { replayFifo } from "../services/fifoLotEngine.js";
import v8 from "v8";

dotenv.config();

const wallets = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((a) => a.toLowerCase());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (b) => (b / 1048576).toFixed(1);

async function timed(fn) {
  const t = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t };
}

function approxBytes(rows) {
  try {
    return JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).length;
  } catch {
    return 0;
  }
}

/** Highest heapUsed seen while `fn` runs (sampled every 20ms). */
async function withPeakHeap(fn) {
  let peak = process.memoryUsage().heapUsed;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed)), 20);
  try {
    const value = await fn();
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    return { value, peak };
  } finally {
    clearInterval(timer);
  }
}

async function measureOnce(wallet) {
  global.gc?.(); // with --expose-gc, start each run from a clean heap
  const heapBefore = process.memoryUsage().heapUsed;
  const { value, peak } = await withPeakHeap(() => measureBuild(wallet));
  return { ...value, heapDeltaMb: mb(process.memoryUsage().heapUsed - heapBefore), heapPeakMb: mb(peak - heapBefore) };
}

async function measureBuild(wallet) {
  const now = new Date();
  const total = performance.now();

  const [t, s, d] = await Promise.all([
    timed(() => getAllTransfersBefore(wallet, now)),
    timed(() => getAllSwapTradesBefore(wallet, now)),
    timed(() => getAllDefiActivityBefore(wallet, now)),
  ]);
  const transfers = t.value;
  const nft = await timed(() => buildNftEvents(transfers));
  const defi = await timed(() => buildDefiFarmEvents(d.value, null));
  const assemble = await timed(() =>
    assembleLedgerEvents({ transfers, swaps: s.value, nftEvents: nft.value.events, nftConsumedRowIds: nft.value.consumedRowIds, defiEvents: defi.value.events, defiActivity: d.value })
  );
  const replay = await timed(() => replayFifo(assemble.value, now, now));
  const gas = await timed(() => computeGasFeesUsd(transfers));
  const totalMs = performance.now() - total;

  const closing = replay.value.closing;
  return {
    rows: { transfers: transfers.length, swaps: s.value.length, defi: d.value.length, events: assemble.value.length },
    bytes: approxBytes(transfers) + approxBytes(s.value) + approxBytes(d.value),
    result: { openLots: closing.lots.length, lockedLots: (closing.lockedLots || []).length, realized: closing.realizedEvents.length },
    ms: {
      readTransfers: t.ms,
      readSwaps: s.ms,
      readDefi: d.ms,
      nftEvents: nft.ms,
      defiEvents: defi.ms,
      assemble: assemble.ms,
      replay: replay.ms,
      gas: gas.ms,
      total: totalMs,
    },
  };
}

function report(label, wallet, m) {
  const f = (n) => `${Math.round(n).toLocaleString()}ms`;
  console.log(`\n${label} — ${wallet}`);
  console.log(`  rows: ${m.rows.transfers.toLocaleString()} transfers, ${m.rows.swaps.toLocaleString()} swaps, ${m.rows.defi.toLocaleString()} DeFi → ${m.rows.events.toLocaleString()} ledger events (~${mb(m.bytes)} MB read)`);
  console.log(`  result: ${m.result.openLots} open lots, ${m.result.lockedLots} locked, ${m.result.realized} realized disposals; heap peak +${m.heapPeakMb} MB (+${m.heapDeltaMb} MB after)`);
  console.log(`  read: transfers ${f(m.ms.readTransfers)} | swaps ${f(m.ms.readSwaps)} | defi ${f(m.ms.readDefi)}   (in parallel)`);
  console.log(`  build: nft ${f(m.ms.nftEvents)} | defi events ${f(m.ms.defiEvents)} | assemble ${f(m.ms.assemble)} | FIFO replay ${f(m.ms.replay)} | gas ${f(m.ms.gas)}`);
  console.log(`  TOTAL ${f(m.ms.total)}`);
}

async function main() {
  if (wallets.length === 0) throw new Error("Usage: node scripts/measureLedgerRebuild.js <wallet> [<wallet> ...]");
  if (!getPool()) throw new Error("DATABASE_URL not set.");

  const results = [];
  for (const w of wallets) {
    const m = await measureOnce(w);
    report("Run 1 (fresh process)", w, m);
    results.push({ w, run1: m });
  }
  console.log("\nWaiting 21s so run 2 re-reads the database (past the 20s transfers memo)...");
  await sleep(21000);
  for (const r of results) {
    r.run2 = await measureOnce(r.w);
    report("Run 2 (warm process)", r.w, r.run2);
  }

  const limitMb = v8.getHeapStatistics().heap_size_limit / 1048576;
  const worst = Math.max(...results.map((r) => Number(r.run1.heapPeakMb)));
  console.log(`
Heap limit ${limitMb.toFixed(0)} MB; the biggest rebuild here peaked at +${worst.toFixed(1)} MB (${((worst / limitMb) * 100).toFixed(0)}% of the limit) — HEAVY_WORK_CONCURRENCY rebuilds that size need about ${(worst * 2).toFixed(0)} MB free at once.`);
  const sum = (k) => results.reduce((a, r) => a + r[k].ms.total, 0);
  console.log(`\nWhole group: run 1 ${Math.round(sum("run1")).toLocaleString()}ms, run 2 ${Math.round(sum("run2")).toLocaleString()}ms (sequential, one wallet after another)`);
  await getPool().end();
}

main().catch((err) => {
  console.error("❌ Measurement failed:", err.message);
  process.exitCode = 1;
});
