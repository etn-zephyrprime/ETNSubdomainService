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
    this.realizedEvents = [];
  }

  _lotsFor(tokenAddress) {
    if (!this.lotsByToken.has(tokenAddress)) this.lotsByToken.set(tokenAddress, []);
    return this.lotsByToken.get(tokenAddress);
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
      this.realizedEvents.push({
        tokenAddress,
        disposalTxHash: txHash,
        timestamp,
        lotId: c.lotId,
        quantityConsumed: c.quantityConsumed,
        costBasisUsd: c.costBasisUsd,
        proceedsUsd: proceeds,
        realizedPnlUsd: proceeds.minus(c.costBasisUsd),
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

  /** Deep-enough snapshot for reporting: open lots (per token) as they stand at the moment this is
   * called, plus every realized event recorded so far. Safe to keep processing after calling this
   * — returned Decimal values are immutable, and the lot objects returned are copies. */
  snapshot() {
    const lots = [];
    for (const [tokenAddress, tokenLots] of this.lotsByToken) {
      for (const lot of tokenLots) {
        if (lot.quantityRemaining.gt(0)) lots.push({ ...lot });
      }
    }
    return { lots, realizedEvents: [...this.realizedEvents] };
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
