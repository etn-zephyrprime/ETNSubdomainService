// FIFO cost-basis engine — pure, in-memory, no database calls. Statement generation (see
// pnlStatementGenerator.js) replays a wallet's full ingested history up to a specific point in
// time and gets back exactly that snapshot; see backend/db/migrations/001_init.sql's note on why
// this is deliberately NOT a persistent, continuously-mutated ledger table.
//
// Uses decimal.js rather than plain JS numbers for every quantity/price/cost-basis calculation —
// this is the one place in this codebase doing arithmetic that ends up on a document someone may
// use for tax filing, so IEEE-754 double rounding drift (fine for e.g. a dashboard's "~1,234 ETN"
// display) isn't acceptable here.
import Decimal from "decimal.js";

/**
 * Pure FIFO consumption: given `openLots` (oldest-first, each { id, quantityRemaining, unitCostUsd })
 * and a `quantityNeeded`, consumes from the front of the queue. Returns:
 *   - consumptions: [{ lotId, quantityConsumed: Decimal, costBasisUsd: Decimal, newRemaining: Decimal }]
 *   - totalCostBasisUsd: Decimal
 *   - remainingShort: Decimal (> 0 if openLots didn't have enough to cover quantityNeeded)
 * Never mutates openLots — callers apply the returned newRemaining values themselves.
 */
export function consumeFifo(openLots, quantityNeeded) {
  let remaining = new Decimal(quantityNeeded);
  const consumptions = [];
  let totalCostBasisUsd = new Decimal(0);

  for (const lot of openLots) {
    if (remaining.lte(0)) break;
    const lotRemaining = new Decimal(lot.quantityRemaining);
    if (lotRemaining.lte(0)) continue;

    const take = Decimal.min(lotRemaining, remaining);
    const unitCostUsd = new Decimal(lot.unitCostUsd);
    const costBasis = take.times(unitCostUsd);

    consumptions.push({ lotId: lot.id, quantityConsumed: take, costBasisUsd: costBasis, newRemaining: lotRemaining.minus(take) });
    totalCostBasisUsd = totalCostBasisUsd.plus(costBasis);
    remaining = remaining.minus(take);
  }

  return { consumptions, totalCostBasisUsd, remainingShort: remaining.gt(0) ? remaining : new Decimal(0) };
}

/** Pure mark-to-market: sum(quantityRemaining * currentPriceUsd) over a set of open lots for one
 * token, given the token's price at the mark date. */
export function markToMarket(openLots, currentPriceUsd) {
  const price = new Decimal(currentPriceUsd);
  return openLots.reduce((sum, lot) => sum.plus(new Decimal(lot.quantityRemaining).times(price)), new Decimal(0));
}

let nextLotId = 1;

/** In-memory FIFO ledger for one wallet across all tokens, built by feeding chronologically
 * ordered events (acquisitions, disposals, self-transfers, swaps) through it one at a time via
 * apply(). Call snapshot() at any point to capture that moment's open-lot state without
 * disturbing further processing — this is what lets replayFifo() below report a period's opening
 * inventory (snapshot at periodStart) and closing inventory (snapshot at periodEnd) from one
 * single pass. */
class FifoLedger {
  constructor() {
    this.lotsByToken = new Map(); // tokenAddress -> array of open lots, oldest-first
    this.lockedLotsByToken = new Map(); // tokenAddress -> array of locked lots, oldest-first (see lock/unlock below)
    this.realizedEvents = [];
    // Running total, kept in lockstep with realizedEvents (same additions, same order) — lets
    // replayFifoCheckpoints below report cumulative realized P&L at each checkpoint without
    // needing its own copy of the (potentially very long, ever-growing) realizedEvents array; see
    // that function's own comment for why that copy used to be a real memory problem.
    this.realizedPnlUsdTotal = new Decimal(0);
  }

  _lotsFor(tokenAddress) {
    if (!this.lotsByToken.has(tokenAddress)) this.lotsByToken.set(tokenAddress, []);
    return this.lotsByToken.get(tokenAddress);
  }

  _lockedLotsFor(tokenAddress) {
    if (!this.lockedLotsByToken.has(tokenAddress)) this.lockedLotsByToken.set(tokenAddress, []);
    return this.lockedLotsByToken.get(tokenAddress);
  }

  acquire({ tokenAddress, txHash, timestamp, quantity, unitCostUsd }) {
    this._lotsFor(tokenAddress).push({
      id: nextLotId++,
      tokenAddress,
      openedTxHash: txHash,
      openedTimestamp: timestamp,
      quantityRemaining: new Decimal(quantity),
      unitCostUsd: new Decimal(unitCostUsd),
    });
  }

  /** Disposes `quantity` of `tokenAddress` FIFO, recording a realized PnL event. A shortfall
   * (more disposed than the wallet's known open lots cover — most likely an incomplete/
   * un-ingested acquisition history) is recorded as zero-cost-basis and logged loudly rather than
   * thrown, so one data gap doesn't crash an entire statement generation. */
  dispose({ tokenAddress, txHash, timestamp, quantity, proceedsUsd }) {
    const lots = this._lotsFor(tokenAddress);
    const qty = new Decimal(quantity);
    const { consumptions, remainingShort } = consumeFifo(lots, qty);

    for (const c of consumptions) {
      const lot = lots.find((l) => l.id === c.lotId);
      if (lot) lot.quantityRemaining = c.newRemaining;
    }
    // Drop fully-closed lots so later FIFO consumption skips them without re-checking each time.
    this.lotsByToken.set(tokenAddress, lots.filter((l) => l.quantityRemaining.gt(0)));

    if (remainingShort.gt(0)) {
      console.warn(
        `⚠️  FIFO shortfall: disposing ${qty.toString()} of ${tokenAddress} but only ` +
          `${qty.minus(remainingShort).toString()} was covered by open lots (tx ${txHash}) — treating the shortfall as zero-cost-basis.`
      );
      consumptions.push({ lotId: null, quantityConsumed: remainingShort, costBasisUsd: new Decimal(0) });
    }

    const proceedsPerUnit = qty.gt(0) ? new Decimal(proceedsUsd).dividedBy(qty) : new Decimal(0);
    for (const c of consumptions) {
      const proceeds = proceedsPerUnit.times(c.quantityConsumed);
      const realizedPnlUsd = proceeds.minus(c.costBasisUsd);
      this.realizedPnlUsdTotal = this.realizedPnlUsdTotal.plus(realizedPnlUsd);
      this.realizedEvents.push({
        tokenAddress,
        disposalTxHash: txHash,
        timestamp,
        lotId: c.lotId,
        quantityConsumed: c.quantityConsumed,
        costBasisUsd: c.costBasisUsd,
        proceedsUsd: proceeds,
        realizedPnlUsd,
      });
    }
  }

  /** Self-transfer OUT: removes lots from this ledger WITHOUT recording a realized PnL event (a
   * transfer between the user's own addresses is never a disposal, per the build brief) — but
   * does NOT attempt to carry the removed lots' original cost basis/date over to the destination
   * wallet's own ledger either. True cross-wallet lot continuity would require ingesting and
   * replaying every self-owned address's full history alongside the tracked wallet's, not just
   * the tracked wallet's — out of scope for this pass. The self_in side (see replayFifo) instead
   * acquires at the transfer's own market price, same as any external inflow. This is a
   * documented simplification, not a silent one: it means a later disposal from the *receiving*
   * address may show a different cost basis than the coin's true original acquisition, but it
   * never mis-reports a wallet-to-wallet move as a taxable sale, which is the brief's actual
   * requirement. */
  removeForSelfTransfer({ tokenAddress, quantity }) {
    const lots = this._lotsFor(tokenAddress);
    const { consumptions, remainingShort } = consumeFifo(lots, new Decimal(quantity));
    for (const c of consumptions) {
      const lot = lots.find((l) => l.id === c.lotId);
      if (lot) lot.quantityRemaining = c.newRemaining;
    }
    this.lotsByToken.set(tokenAddress, lots.filter((l) => l.quantityRemaining.gt(0)));
    if (remainingShort.gt(0)) {
      console.warn(`⚠️  FIFO shortfall on self-transfer of ${tokenAddress}: short by ${remainingShort.toString()}`);
    }
  }

  /** Moves `quantity` of `tokenAddress` from open (in-wallet) lots into a separate locked queue —
   * for a DeFi farm/stake deposit, where the wallet still economically owns the tokens, just
   * "location" changes (locked in a contract instead of held directly), so this is deliberately
   * NOT a disposal: no realized PnL event, and each consumed lot's original unitCostUsd/
   * openedTimestamp/openedTxHash is carried into the locked queue UNCHANGED, not revalued at
   * today's price the way a normal acquisition would be. unlock() below restores it later, same
   * cost basis, when the position is withdrawn.
   *
   * A shortfall (locking more than the wallet's own open lots cover — most likely an incomplete/
   * un-ingested acquisition history, same class of gap dispose()'s own shortfall handles) is
   * logged loudly and the shortfall portion is simply not added to the locked queue at all — there
   * is no cost basis to carry through for tokens this ledger never saw acquired, so inventing a
   * locked lot for it would just create a phantom position unlock() could never legitimately
   * restore. */
  lock({ tokenAddress, quantity }) {
    const lots = this._lotsFor(tokenAddress);
    // Captured BEFORE consumeFifo/the filter below, so a lot fully consumed by this lock (and
    // therefore dropped from `lots`) is still findable by id when building the locked lots below —
    // consumeFifo's own `consumptions` entries carry only lotId/quantityConsumed/costBasisUsd, not
    // the source lot's openedTxHash/openedTimestamp/unitCostUsd (see its own doc).
    const preFilterLots = new Map(lots.map((l) => [l.id, l]));

    const { consumptions, remainingShort } = consumeFifo(lots, new Decimal(quantity));
    for (const c of consumptions) {
      const lot = lots.find((l) => l.id === c.lotId);
      if (lot) lot.quantityRemaining = c.newRemaining;
    }
    this.lotsByToken.set(tokenAddress, lots.filter((l) => l.quantityRemaining.gt(0)));

    if (remainingShort.gt(0)) {
      console.warn(
        `⚠️  FIFO lock shortfall: locking ${new Decimal(quantity).toString()} of ${tokenAddress} but only ` +
          `${new Decimal(quantity).minus(remainingShort).toString()} was covered by open lots — the shortfall is not carried into the locked position.`
      );
    }

    const lockedLots = this._lockedLotsFor(tokenAddress);
    for (const c of consumptions) {
      const sourceLot = preFilterLots.get(c.lotId);
      lockedLots.push({
        id: nextLotId++,
        tokenAddress,
        openedTxHash: sourceLot.openedTxHash,
        openedTimestamp: sourceLot.openedTimestamp,
        quantityRemaining: c.quantityConsumed,
        unitCostUsd: new Decimal(sourceLot.unitCostUsd),
      });
    }
  }

  /** Moves `quantity` of `tokenAddress` back from the locked queue into open (in-wallet) lots —
   * the reverse of lock() above, restoring each lot's ORIGINAL cost basis/acquisition date exactly
   * as it was before locking, never revalued at today's price. No realized PnL event, same as
   * lock() — a DeFi farm/stake withdrawal is a reacquisition of what was already owned, not a
   * fresh purchase.
   *
   * A shortfall (unlocking more than is actually in the locked queue — e.g. ingestion started
   * mid-farm-position, so this ledger never saw the original lock) falls back to a FRESH lot at
   * `fallbackUnitCostUsd` (today's live price, same "best available" fallback dispose()'s own
   * shortfall uses zero-cost-basis for) for just the shortfall portion — there's no recorded cost
   * basis to restore for tokens this ledger never saw get locked, so a live price is the closest
   * honest answer available, not a silent zero. */
  unlock({ tokenAddress, txHash, timestamp, quantity, fallbackUnitCostUsd }) {
    const lockedLots = this._lockedLotsFor(tokenAddress);
    const preFilterLockedLots = new Map(lockedLots.map((l) => [l.id, l]));
    const { consumptions, remainingShort } = consumeFifo(lockedLots, new Decimal(quantity));
    for (const c of consumptions) {
      const lot = lockedLots.find((l) => l.id === c.lotId);
      if (lot) lot.quantityRemaining = c.newRemaining;
    }
    this.lockedLotsByToken.set(tokenAddress, lockedLots.filter((l) => l.quantityRemaining.gt(0)));

    const openLots = this._lotsFor(tokenAddress);
    for (const c of consumptions) {
      const sourceLot = preFilterLockedLots.get(c.lotId);
      openLots.push({
        id: nextLotId++,
        tokenAddress,
        openedTxHash: sourceLot.openedTxHash,
        openedTimestamp: sourceLot.openedTimestamp,
        quantityRemaining: c.quantityConsumed,
        unitCostUsd: new Decimal(sourceLot.unitCostUsd),
      });
    }

    if (remainingShort.gt(0)) {
      console.warn(
        `⚠️  FIFO unlock shortfall: unlocking ${new Decimal(quantity).toString()} of ${tokenAddress} but only ` +
          `${new Decimal(quantity).minus(remainingShort).toString()} was covered by the locked queue (tx ${txHash}) — the shortfall reacquires at today's price instead of a carried-through cost basis.`
      );
      openLots.push({
        id: nextLotId++,
        tokenAddress,
        openedTxHash: txHash,
        openedTimestamp: timestamp,
        quantityRemaining: remainingShort,
        unitCostUsd: new Decimal(fallbackUnitCostUsd),
      });
    }
  }

  /** Open lots (per token) as they stand at the moment this is called — the part of snapshot()
   * (below) both it and the leaner per-checkpoint path in replayFifoCheckpoints need. Safe to keep
   * processing after calling this — the lot objects returned are copies. */
  openLotsSnapshot() {
    const lots = [];
    for (const [tokenAddress, tokenLots] of this.lotsByToken) {
      for (const lot of tokenLots) {
        if (lot.quantityRemaining.gt(0)) lots.push({ ...lot });
      }
    }
    return lots;
  }

  /** Deep-enough snapshot for reporting: open lots (per token) as they stand at the moment this is
   * called, plus every realized event recorded so far. Safe to keep processing after calling this
   * — returned Decimal values are immutable, and the lot objects returned are copies.
   *
   * Only ever called ONCE per replayFifo() run (a single opening/closing pair) — cheap. Don't call
   * this from a per-checkpoint loop (replayFifoCheckpoints below deliberately doesn't): copying
   * the full, ever-growing realizedEvents array at every one of e.g. 365 daily checkpoints is what
   * used to make that function's memory footprint grow with checkpoints × realized-event-count
   * instead of just checkpoints + events — see that function's own comment. */
  snapshot() {
    return { lots: this.openLotsSnapshot(), realizedEvents: [...this.realizedEvents] };
  }
}

/**
 * Replays a chronologically-sorted list of per-wallet events through a FIFO ledger and returns
 * snapshots at `periodStart` and `periodEnd`. Each event: one of
 *   { kind: 'in', tokenAddress, txHash, timestamp, quantity, unitCostUsd }
 *   { kind: 'out', tokenAddress, txHash, timestamp, quantity, proceedsUsd }
 *   { kind: 'self_out', tokenAddress, txHash, timestamp, quantity }
 *     — removes the lot without recording realized PnL (see FifoLedger.removeForSelfTransfer's
 *       own comment on why this doesn't attempt to carry cost basis to the destination wallet)
 *   { kind: 'self_in', tokenAddress, txHash, timestamp, quantity, unitCostUsd }
 *     — behaves identically to 'in' (acquires at the given market-price cost basis); kept as a
 *       distinct label purely so the frozen statement's backing ledger can show *why* a lot was
 *       opened (self-transfer vs. a genuine external inflow), not because the math differs.
 *   { kind: 'lock', tokenAddress, quantity }
 *     — a DeFi farm/stake deposit: the wallet still economically owns these tokens, just
 *       "location" changes (locked in a contract instead of held directly) — moves lots from open
 *       to a separate locked queue, cost basis/acquisition date carried through unchanged, no
 *       realized PnL (see FifoLedger.lock's own comment). NOT a disposal, unlike a plain 'out'.
 *   { kind: 'unlock', tokenAddress, txHash, timestamp, quantity, fallbackUnitCostUsd }
 *     — the reverse: a DeFi farm/stake withdrawal, restoring locked lots back to open with their
 *       ORIGINAL cost basis, never revalued at today's price (fallbackUnitCostUsd is used only for
 *       the rare shortfall case — see FifoLedger.unlock's own comment).
 *   { kind: 'swap', txHash, timestamp, soldTokenAddress, soldQuantity, soldProceedsUsd,
 *     boughtTokenAddress, boughtQuantity, boughtUnitCostUsd }
 * Returns { opening: {lots, realizedEvents}, closing: {lots, realizedEvents} } — `closing` is the
 * full snapshot as of periodEnd (all realized events across all of history up to periodEnd);
 * callers filter realizedEvents by timestamp >= periodStart themselves for "this period's" figures,
 * since a snapshot's own realizedEvents list is cumulative, not period-scoped.
 */
export function replayFifo(events, periodStart, periodEnd) {
  const ledger = new FifoLedger();
  let opening = null;

  for (const event of events) {
    if (event.timestamp >= periodEnd) break; // events at/after periodEnd never affect this period's snapshots — events must be pre-sorted chronologically
    if (opening === null && event.timestamp >= periodStart) {
      opening = ledger.snapshot();
    }

    switch (event.kind) {
      case "in":
        ledger.acquire(event);
        break;
      case "out":
        ledger.dispose(event);
        break;
      case "self_out":
        // Caller is responsible for feeding the returned lot breakdown into the destination
        // wallet's own replay as matching self_in acquire() calls, if it needs multi-wallet
        // continuity — see pnlStatementGenerator.js.
        ledger.removeForSelfTransfer(event);
        break;
      case "self_in":
        ledger.acquire(event);
        break;
      case "lock":
        ledger.lock(event);
        break;
      case "unlock":
        ledger.unlock(event);
        break;
      case "swap":
        ledger.dispose({
          tokenAddress: event.soldTokenAddress,
          txHash: event.txHash,
          timestamp: event.timestamp,
          quantity: event.soldQuantity,
          proceedsUsd: event.soldProceedsUsd,
        });
        ledger.acquire({
          tokenAddress: event.boughtTokenAddress,
          txHash: event.txHash,
          timestamp: event.timestamp,
          quantity: event.boughtQuantity,
          unitCostUsd: event.boughtUnitCostUsd,
        });
        break;
      default:
        throw new Error(`replayFifo: unknown event kind "${event.kind}"`);
    }
  }

  if (opening === null) opening = ledger.snapshot(); // no events at/after periodStart — inventory unchanged through the period
  const closing = ledger.snapshot();

  return { opening, closing };
}

/**
 * Like replayFifo, but takes N checkpoint timestamps (sorted ascending) instead of just one
 * periodStart/periodEnd pair, and returns a snapshot AS OF each one from a single pass over
 * `events` — same "snapshot right before any event at/after the boundary" rule replayFifo itself
 * uses for periodEnd, applied at every checkpoint in turn. There's no "opening" concept here, only
 * a series of cumulative closings, each one covering all of history up to that checkpoint.
 *
 * Built for pnlSnapshotService.js's history backfill: computing a wallet's daily PnL rollup for the
 * last 365 days by calling replayFifo() 365 times would re-walk the ENTIRE event list from scratch
 * on every single call — O(events × days). Walking the list once and collecting a snapshot at each
 * day boundary as it's crossed is O(events + days) instead.
 *
 * Deliberately does NOT use FifoLedger's own snapshot() at each checkpoint (only openLotsSnapshot()
 * — see that method's own comment): that would mean copying the WHOLE history-so-far
 * `realizedEvents` array at every checkpoint, making this genuinely O(checkpoints ×
 * realized-event-count) rather than O(events + days) — confirmed as a real memory blowup for a
 * wallet with substantial realized history. Two consumers, two different needs, both served
 * without that copy:
 *   - a caller that only needs the whole-wallet cumulative total (backfillPnlHistory) reads
 *     `realizedPnlUsdCumulative` — a running Decimal, O(1) per checkpoint.
 *   - a caller that needs to filter realized events by token (backfillCategoryPnlHistory, by
 *     category) reads `newRealizedEvents` — only what's NEW since the PREVIOUS checkpoint, and
 *     maintains its own running total(s) by accumulating that delta checkpoint over checkpoint.
 *     Summed across every checkpoint this is O(events) total, not O(checkpoints × events).
 *
 * Returns an array of { checkpoint, lots, realizedPnlUsdCumulative, newRealizedEvents } in the same
 * order as `checkpoints` — a checkpoint past the last event (including every checkpoint, for a
 * wallet with no activity at all) still gets an entry, just holding the ledger's final (possibly
 * still-empty) state.
 */
export function replayFifoCheckpoints(events, checkpoints) {
  const ledger = new FifoLedger();
  const snapshots = [];
  let checkpointIndex = 0;
  // How many of ledger.realizedEvents the PREVIOUS checkpoint already accounted for — lets each
  // checkpoint report only its own newRealizedEvents (a slice, not a copy-then-filter of the whole
  // history-so-far) while realizedPnlUsdCumulative (above) still gives the full running total for a
  // caller that doesn't need per-event detail. realizedEvents only ever grows (never spliced), so
  // slicing [lastRealizedCount, currentCount) is always exactly "what's new since last checkpoint".
  let lastRealizedCount = 0;

  for (const event of events) {
    while (checkpointIndex < checkpoints.length && event.timestamp >= checkpoints[checkpointIndex]) {
      const currentRealizedCount = ledger.realizedEvents.length;
      snapshots.push({
        checkpoint: checkpoints[checkpointIndex],
        lots: ledger.openLotsSnapshot(),
        realizedPnlUsdCumulative: ledger.realizedPnlUsdTotal,
        newRealizedEvents: ledger.realizedEvents.slice(lastRealizedCount, currentRealizedCount),
      });
      lastRealizedCount = currentRealizedCount;
      checkpointIndex++;
    }
    if (checkpointIndex >= checkpoints.length) break; // every checkpoint already captured — nothing left can change a recorded snapshot

    switch (event.kind) {
      case "in":
        ledger.acquire(event);
        break;
      case "out":
        ledger.dispose(event);
        break;
      case "self_out":
        ledger.removeForSelfTransfer(event);
        break;
      case "self_in":
        ledger.acquire(event);
        break;
      case "lock":
        ledger.lock(event);
        break;
      case "unlock":
        ledger.unlock(event);
        break;
      case "swap":
        ledger.dispose({
          tokenAddress: event.soldTokenAddress,
          txHash: event.txHash,
          timestamp: event.timestamp,
          quantity: event.soldQuantity,
          proceedsUsd: event.soldProceedsUsd,
        });
        ledger.acquire({
          tokenAddress: event.boughtTokenAddress,
          txHash: event.txHash,
          timestamp: event.timestamp,
          quantity: event.boughtQuantity,
          unitCostUsd: event.boughtUnitCostUsd,
        });
        break;
      default:
        throw new Error(`replayFifoCheckpoints: unknown event kind "${event.kind}"`);
    }
  }
  // Any checkpoints at/after the last event (e.g. "today", or every checkpoint for a wallet with no
  // activity at all) never got captured inside the loop above — the ledger's final state covers all
  // of them.
  while (checkpointIndex < checkpoints.length) {
    const currentRealizedCount = ledger.realizedEvents.length;
    snapshots.push({
      checkpoint: checkpoints[checkpointIndex],
      lots: ledger.openLotsSnapshot(),
      realizedPnlUsdCumulative: ledger.realizedPnlUsdTotal,
      newRealizedEvents: ledger.realizedEvents.slice(lastRealizedCount, currentRealizedCount),
    });
    lastRealizedCount = currentRealizedCount;
    checkpointIndex++;
  }

  return snapshots;
}
