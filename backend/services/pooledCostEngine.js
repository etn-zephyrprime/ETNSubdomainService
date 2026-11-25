// Pooled average-cost engine (UK Section 104 / share pooling). Pure, in-memory, no database calls —
// the alternative to fifoLotEngine.js's replayFifo, selected per statement request (see
// statement_requests.cost_model). Returns the exact same { opening, closing } snapshot shape
// replayFifo does, so everything downstream of replay (valuation, realized-gain aggregation, PDF)
// is unchanged.
//
// Each token has ONE pool: a running quantity and total cost. Acquisitions add to both; a disposal
// removes quantity at the pool's current average unit cost, so the pool's average is unchanged by
// disposals and only moves when units are acquired. Each disposal produces ONE realized event
// (not one per lot), since there are no individual lots to report.
//
// Accepts the same event kinds as replayFifo (see its doc in fifoLotEngine.js) with identical
// semantics: self-transfers and farm lock/unlock move cost basis without a realized event, swaps
// dispose-then-acquire, and a disposal beyond the pool's holdings is treated as zero-cost-basis for
// the shortfall (logged, never thrown).
import Decimal from "decimal.js";

class PooledLedger {
  constructor() {
    this.poolsByToken = new Map(); // tokenAddress -> { quantity: Decimal, costUsd: Decimal, openedTimestamp }
    this.lockedByToken = new Map(); // tokenAddress -> same shape, for farm/stake positions (see lock)
    this.realizedEvents = [];
    this.realizedPnlUsdTotal = new Decimal(0);
  }

  _poolFor(map, tokenAddress) {
    if (!map.has(tokenAddress)) map.set(tokenAddress, { quantity: new Decimal(0), costUsd: new Decimal(0), openedTimestamp: null });
    return map.get(tokenAddress);
  }

  _add(pool, quantity, costUsd, timestamp) {
    pool.quantity = pool.quantity.plus(quantity);
    pool.costUsd = pool.costUsd.plus(costUsd);
    if (pool.openedTimestamp == null) pool.openedTimestamp = timestamp;
  }

  // Removes up to `quantity` at the pool's average unit cost. Returns what was actually taken and its
  // cost basis; anything beyond the pool's holdings comes back as `shortfall` with zero cost.
  _take(pool, quantity) {
    const taken = Decimal.min(pool.quantity, quantity);
    const unitCostUsd = pool.quantity.gt(0) ? pool.costUsd.dividedBy(pool.quantity) : new Decimal(0);
    const costUsd = taken.times(unitCostUsd);
    pool.quantity = pool.quantity.minus(taken);
    pool.costUsd = pool.quantity.gt(0) ? pool.costUsd.minus(costUsd) : new Decimal(0);
    return { taken, costUsd, shortfall: new Decimal(quantity).minus(taken) };
  }

  acquire({ tokenAddress, timestamp, quantity, unitCostUsd }) {
    const qty = new Decimal(quantity);
    if (qty.lte(0)) return;
    this._add(this._poolFor(this.poolsByToken, tokenAddress), qty, qty.times(new Decimal(unitCostUsd)), timestamp);
  }

  dispose({ tokenAddress, txHash, timestamp, quantity, proceedsUsd }) {
    const qty = new Decimal(quantity);
    if (qty.lte(0)) return;
    const { costUsd, shortfall } = this._take(this._poolFor(this.poolsByToken, tokenAddress), qty);
    if (shortfall.gt(0)) {
      console.warn(
        `⚠️  Pooled cost shortfall: disposing ${qty.toString()} of ${tokenAddress} but only ` +
          `${qty.minus(shortfall).toString()} was held (tx ${txHash}) — treating the shortfall as zero-cost-basis.`
      );
    }
    const proceeds = new Decimal(proceedsUsd);
    const realizedPnlUsd = proceeds.minus(costUsd);
    this.realizedPnlUsdTotal = this.realizedPnlUsdTotal.plus(realizedPnlUsd);
    this.realizedEvents.push({
      tokenAddress,
      disposalTxHash: txHash,
      timestamp,
      lotId: null,
      acquisitionTimestamp: null,
      quantityConsumed: qty,
      costBasisUsd: costUsd,
      proceedsUsd: proceeds,
      realizedPnlUsd,
    });
  }

  removeForSelfTransfer({ tokenAddress, quantity, txHash }) {
    const { shortfall } = this._take(this._poolFor(this.poolsByToken, tokenAddress), new Decimal(quantity));
    if (shortfall.gt(0)) {
      console.warn(`⚠️  Pooled cost shortfall on self-transfer of ${tokenAddress}${txHash ? ` (tx ${txHash})` : ""}: short by ${shortfall.toString()}`);
    }
  }

  lock({ tokenAddress, quantity, txHash }) {
    const { taken, costUsd, shortfall } = this._take(this._poolFor(this.poolsByToken, tokenAddress), new Decimal(quantity));
    if (shortfall.gt(0)) {
      console.warn(
        `⚠️  Pooled lock shortfall: locking ${new Decimal(quantity).toString()} of ${tokenAddress} but only ` +
          `${taken.toString()} was held (tx ${txHash}) — the shortfall is not carried into the locked position.`
      );
    }
    if (taken.gt(0)) this._add(this._poolFor(this.lockedByToken, tokenAddress), taken, costUsd, null);
  }

  unlock({ tokenAddress, txHash, timestamp, quantity, fallbackUnitCostUsd }) {
    const locked = this._poolFor(this.lockedByToken, tokenAddress);
    const { taken, costUsd, shortfall } = this._take(locked, new Decimal(quantity));
    const pool = this._poolFor(this.poolsByToken, tokenAddress);
    if (taken.gt(0)) this._add(pool, taken, costUsd, timestamp);
    if (shortfall.gt(0)) {
      console.warn(
        `⚠️  Pooled unlock shortfall: unlocking ${new Decimal(quantity).toString()} of ${tokenAddress} but only ` +
          `${taken.toString()} was in the locked pool (tx ${txHash}) — the shortfall reacquires at today's price instead of a carried-through cost basis.`
      );
      this._add(pool, shortfall, shortfall.times(new Decimal(fallbackUnitCostUsd)), timestamp);
    }
  }

  _lotsFrom(map) {
    const lots = [];
    for (const [tokenAddress, pool] of map) {
      if (pool.quantity.lte(0)) continue;
      lots.push({
        id: null,
        tokenAddress,
        openedTxHash: null,
        openedTimestamp: pool.openedTimestamp,
        quantityRemaining: pool.quantity,
        unitCostUsd: pool.costUsd.dividedBy(pool.quantity),
      });
    }
    return lots;
  }

  snapshot() {
    return {
      lots: this._lotsFrom(this.poolsByToken),
      lockedLots: this._lotsFrom(this.lockedByToken),
      realizedEvents: [...this.realizedEvents],
    };
  }
}

/**
 * Applies one event to a PooledLedger. Shared by replayPooled and replayPooledCheckpoints so the two
 * never disagree on what an event does.
 */
function applyPooledEvent(ledger, event) {
  switch (event.kind) {
    case "in":
    case "self_in":
      ledger.acquire(event);
      break;
    case "out":
      ledger.dispose(event);
      break;
    case "self_out":
      ledger.removeForSelfTransfer(event);
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
        timestamp: event.timestamp,
        quantity: event.boughtQuantity,
        unitCostUsd: event.boughtUnitCostUsd,
      });
      break;
    default:
      throw new Error(`replayPooled: unknown event kind "${event.kind}"`);
  }
}

/**
 * Same contract as the FIFO checkpoint replay (see fifoLotEngine.js's replayFifoCheckpoints):
 * one snapshot per checkpoint (each the exclusive end of a day), from a single pass. Each snapshot is
 * { checkpoint, lots, realizedPnlUsdCumulative, newRealizedEvents }, where newRealizedEvents are only
 * the events recorded since the previous checkpoint.
 */
export function replayPooledCheckpoints(events, checkpoints) {
  const ledger = new PooledLedger();
  const snapshots = [];
  let checkpointIndex = 0;
  let lastRealizedCount = 0;
  const capture = (checkpoint) => {
    const currentRealizedCount = ledger.realizedEvents.length;
    snapshots.push({
      checkpoint,
      lots: ledger._lotsFrom(ledger.poolsByToken),
      realizedPnlUsdCumulative: ledger.realizedPnlUsdTotal,
      newRealizedEvents: ledger.realizedEvents.slice(lastRealizedCount, currentRealizedCount),
    });
    lastRealizedCount = currentRealizedCount;
  };

  for (const event of events) {
    while (checkpointIndex < checkpoints.length && event.timestamp >= checkpoints[checkpointIndex]) {
      capture(checkpoints[checkpointIndex]);
      checkpointIndex++;
    }
    if (checkpointIndex >= checkpoints.length) break;
    applyPooledEvent(ledger, event);
  }
  // Checkpoints past the last event still get an entry, holding the ledger's final state.
  while (checkpointIndex < checkpoints.length) {
    capture(checkpoints[checkpointIndex]);
    checkpointIndex++;
  }
  return snapshots;
}

/**
 * Same contract as replayFifo (see fifoLotEngine.js): replays chronologically-sorted events and
 * returns { opening, closing } snapshots at periodStart and periodEnd. Same event kinds, including
 * 'swap', and the same "events at/after periodEnd are never applied" rule.
 */
export function replayPooled(events, periodStart, periodEnd) {
  const ledger = new PooledLedger();
  let opening = null;

  for (const event of events) {
    if (event.timestamp >= periodEnd) break;
    if (opening === null && event.timestamp >= periodStart) {
      opening = ledger.snapshot();
    }
    applyPooledEvent(ledger, event);
  }

  if (opening === null) opening = ledger.snapshot();
  const closing = ledger.snapshot();

  return { opening, closing };
}
