// backend/services/pnlSnapshotService.js
//
// Core tier's "ongoing dashboard PnL" feature — current holdings, running unrealized/realized P&L
// for one tracked wallet, computed live. Explicitly NOT the PnL Statement product: no CEX
// inclusion, no fixed reporting periods, no immutability, no per-disposal ledger — this is a
// lightweight "how am I doing right now" view, not a formal record (see the build brief). Reads
// the exact same FIFO ledger the Statement uses (fifoLotEngine.js via pnlEventBuilder.js) so this
// can never report a different realized/unrealized figure than the Statement would for the same
// wallet/token/timestamp — two independent implementations that could drift apart would undermine
// trust in both products.
//
// Recomputed fresh on every call, never cached/frozen here (pnlSnapshotScheduler.js's daily
// pnl_snapshots rows are a SEPARATE, deliberately lightweight rollup purely for the chart — see
// that file's own header comment; the "right now" figures shown alongside the chart always come
// from THIS function, live).
import Decimal from "decimal.js";
import { getAllTransfersBefore } from "../db/ingestedTransfers.js";
import { getAllSwapTradesBefore } from "../db/swapTrades.js";
import { getAllDefiActivityBefore } from "../db/defiActivity.js";
import { getIngestionState } from "../db/walletIngestionState.js";
import { upsertPnlSnapshot, getExistingSnapshotDates } from "../db/pnlSnapshots.js";
import { ingestWalletHistory, backfillDeferredPrices, POSITION_MANAGER_ADDRESS } from "./pnlIngestion.js";
import { replayFifo, replayFifoCheckpoints } from "./fifoLotEngine.js";
import {
  transferToEvent,
  buildNftEvents,
  swapToEvent,
  buildDefiFarmEvents,
  computeGasFeesUsd,
  valueInventoryAtTimestamp,
  groupNftHoldingsByCollection,
  groupNftRealizedByCollection,
} from "./pnlEventBuilder.js";

// V3 concentrated-liquidity positions use the exact same "address:tokenId" lot-key shape as an NFT
// (see pnlIngestion.js's own V3 header comment) — excluded from groupNftHoldingsByCollection below
// so a position isn't combined away like a real collectible would be.
const NFT_GROUPING_EXCLUSIONS = new Set([POSITION_MANAGER_ADDRESS]);

/** Fetches and assembles one wallet's full, chronologically-sorted event list — the shared first
 * half of both computeLivePnlSnapshot (below) and backfillPnlHistory: both need "every event this
 * wallet has ever had," they just replay it differently (one point-in-time closing snapshot vs. a
 * series of daily ones). Kept here rather than duplicated a third time alongside
 * pnlStatementGenerator.js's own (period-scoped) event assembly. */
// Exported so categoryPnlService.js can build the exact same event list this file replays for the
// whole-portfolio history, then filter it down to one category's own token keys — same "never a
// second, divergence-prone reimplementation" reasoning as pnlEventBuilder.js's own extraction.
export async function buildEventsForWallet(trackedWallet, selfOwnedAddresses, priorityAssets, asOf) {
  const [transfers, swaps, defiActivity] = await Promise.all([
    getAllTransfersBefore(trackedWallet, asOf),
    getAllSwapTradesBefore(trackedWallet, asOf),
    getAllDefiActivityBefore(trackedWallet, asOf),
  ]);

  const { events: nftEvents, consumedRowIds: nftConsumedRowIds } = buildNftEvents(transfers);
  const { events: defiEvents } = await buildDefiFarmEvents(defiActivity, priorityAssets);
  const events = [
    ...transfers.filter((t) => !nftConsumedRowIds.has(t.id)).map(transferToEvent),
    ...swaps.map(swapToEvent),
    ...nftEvents,
    ...defiEvents,
  ].sort((a, b) => a.timestamp - b.timestamp);

  return { events, transfers };
}

/**
 * Live PnL snapshot for `trackedWallet` as of right now: current holdings (per token, valued at
 * today's price via the same ElectroSwap-derived pipeline the Statement uses), unrealized P&L, and
 * a running realized P&L total since cold-start ingestion — NOT bound to any calendar period (no
 * "opening"/"closing" period concept at all here, unlike the Statement).
 *
 * Gas fees DO reduce the realized total (confirmed decision, for accuracy) even though — unlike
 * the Statement — they're not broken out as their own line item here; see `gasUsd` on the returned
 * object if a caller wants to show it separately anyway.
 *
 * `selfOwnedAddresses`: the member's OTHER actively-tracked wallets, passed through so a transfer
 * between a member's own tracked wallets is correctly excluded from realized P&L (a self-transfer,
 * never a disposal) — the exact same self_owned_addresses concept a Statement request lets a user
 * supply manually, just sourced here from Core tier's own tracked-wallet list instead of asking
 * the user to type addresses in twice.
 *
 * `replayFifo(events, now, now)` is deliberate: this feature has no period concept, so only the
 * `closing` snapshot (full history up to right now) is ever used — `opening` is discarded.
 *
 * `priorityTokens` (optional array of token addresses) — the cold-start speedup: ingestion prices
 * JUST these tokens (plus native ETN, always) in full; everything else gets recorded with a null
 * price for now (see pnlIngestion.js's priorityAssets) rather than paying for a full GeckoTerminal
 * bulk-price-backfill of every token the wallet has EVER touched before showing anything. A
 * background pass (backfillDeferredPrices, fired but not awaited below) fills the rest in
 * afterward, without re-walking Blockscout — a later call naturally sees more complete prices as
 * that finishes.
 *
 * SAFETY BOUNDARY: `priorityTokens` only ever takes effect while this wallet's cold-start
 * ingestion is still incomplete (wallet_ingestion_state.cold_start_completed_at is null) — checked
 * here, not left to the caller's discretion. Once cold-start is done (which it always is after
 * the FIRST successful ingestWalletHistory call, priority-scoped or not), every subsequent call
 * gets full, unscoped pricing regardless of what `priorityTokens` is passed — so a stale/narrow
 * selection can never quietly under-price a wallet's PnL forever; it only ever shortens the very
 * first computation.
 */
export async function computeLivePnlSnapshot(trackedWallet, selfOwnedAddresses = [], priorityTokens = null) {
  const now = new Date();

  const ingestionState = await getIngestionState(trackedWallet);
  const isColdStart = !ingestionState?.cold_start_completed_at;
  const priorityAssets =
    isColdStart && priorityTokens && priorityTokens.length > 0 ? new Set(priorityTokens.map((a) => a.toLowerCase())) : null;

  await ingestWalletHistory(trackedWallet, selfOwnedAddresses, priorityAssets);

  const { events, transfers } = await buildEventsForWallet(trackedWallet, selfOwnedAddresses, priorityAssets, now);

  const { closing } = replayFifo(events, now, now);

  const [valuation, gas] = await Promise.all([
    valueInventoryAtTimestamp(closing.lots, now),
    computeGasFeesUsd(transfers), // whole history — this view has no period to scope it to
  ]);

  const realizedPnlUsdGross = closing.realizedEvents.reduce((sum, e) => sum.plus(e.realizedPnlUsd), new Decimal(0));
  const realizedPnlUsd = realizedPnlUsdGross.minus(gas.totalGasUsd);

  // Per-token realized P&L, for the dashboard's token filter (CoreTierPnl.jsx) — GROSS of gas,
  // unlike the aggregate realizedPnlUsd above: gas is paid in ETN regardless of which token a
  // transaction touched, so there's no honest way to attribute a slice of it to one specific
  // token's own figure. Deliberately a separate field rather than folding gas in per-token anyway
  // (which would either double-count it across every token or require an arbitrary allocation
  // rule) — the frontend labels a single-token view accordingly rather than implying it nets to
  // the same total as the all-tokens aggregate.
  const realizedByTokenMap = new Map(); // tokenAddress -> Decimal
  for (const e of closing.realizedEvents) {
    const running = realizedByTokenMap.get(e.tokenAddress) || new Decimal(0);
    realizedByTokenMap.set(e.tokenAddress, running.plus(e.realizedPnlUsd));
  }

  if (priorityAssets) {
    // Fire-and-forget — the caller already has a usable (partial) result; this fills in the rest
    // without making them wait for it. Errors are logged inside backfillDeferredPrices itself, per
    // row, never thrown out to here.
    backfillDeferredPrices(trackedWallet).catch((err) =>
      console.error(`⚠️  Background deferred-price backfill failed for ${trackedWallet}:`, err)
    );
  }

  return {
    asOf: now,
    // [{ tokenAddress, quantity, costBasisUsd, marketValueUsd }] — marketValueUsd null for a token
    // whose price didn't resolve (same "omit rather than fake" convention valueInventoryAtTimestamp
    // itself already documents). NFT lots combined to one row per collection here (see
    // groupNftHoldingsByCollection's own comment) — done once, this early, so every downstream
    // consumer (combineLivePnlSnapshots' own per-tokenAddress merge, the dashboard's token filter)
    // just sees a collection address like any other regular holdings row, no special-casing needed.
    holdings: groupNftHoldingsByCollection(valuation.perToken, NFT_GROUPING_EXCLUSIONS),
    currentValueUsd: valuation.totalMarketValueUsd.toString(),
    unrealizedPnlUsd: valuation.totalUnrealizedUsd.toString(),
    realizedPnlUsd: realizedPnlUsd.toString(),
    // [{ tokenAddress, realizedPnlUsd }] — gross of gas, see the comment above realizedByTokenMap.
    // A token with holdings but no realized events (never sold) simply doesn't appear here, not a
    // fabricated 0 — same "omit rather than fake" convention as holdings' own marketValueUsd null.
    // Grouped the same way as `holdings` above (same exclusions) — the dashboard's token filter is
    // built from `holdings`, so this must key off the exact same collection addresses or a
    // collection's realized P&L would silently look like zero once selected.
    realizedByToken: groupNftRealizedByCollection(
      [...realizedByTokenMap.entries()].map(([tokenAddress, usd]) => ({ tokenAddress, realizedPnlUsd: usd.toString() })),
      NFT_GROUPING_EXCLUSIONS
    ),
    gasUsd: gas.totalGasUsd.toString(),
    // True only when THIS computation used priority scoping — the figures above are a lower
    // bound (same spirit as the rest of this app's "≈" convention) until the background backfill
    // (already kicked off) finishes filling in the deferred prices.
    pricingIncomplete: Boolean(priorityAssets),
  };
}

/** Combines several wallets' own live snapshots (from computeLivePnlSnapshot) into one — holdings
 * merged by token address, everything else summed. Each wallet's own snapshot is still fully
 * available to the caller unmerged; this is purely for the "combined across all of them" figure
 * the build brief also asks for, same "own data + a merged view" shape
 * useCombinedPortfolio.js/CoreTierPortfolio.jsx already use for the live balance/holdings view. */
export function combineLivePnlSnapshots(snapshots) {
  const holdingsByToken = new Map(); // tokenAddress -> { tokenAddress, quantity: Decimal, costBasisUsd: Decimal, marketValueUsd: Decimal|null }
  const realizedByTokenMap = new Map(); // tokenAddress -> Decimal
  let currentValueUsd = new Decimal(0);
  let unrealizedPnlUsd = new Decimal(0);
  let realizedPnlUsd = new Decimal(0);
  let gasUsd = new Decimal(0);
  let pricingIncomplete = false;

  for (const snap of snapshots) {
    currentValueUsd = currentValueUsd.plus(snap.currentValueUsd);
    unrealizedPnlUsd = unrealizedPnlUsd.plus(snap.unrealizedPnlUsd);
    realizedPnlUsd = realizedPnlUsd.plus(snap.realizedPnlUsd);
    gasUsd = gasUsd.plus(snap.gasUsd);
    if (snap.pricingIncomplete) pricingIncomplete = true;

    // Defaults to [] for a snapshot computed before this field existed (a stale cached response
    // shape, in principle — this is never persisted, so in practice only matters for the instant
    // this deploys) rather than throwing on a wallet whose own snapshot predates it.
    for (const r of snap.realizedByToken || []) {
      const running = realizedByTokenMap.get(r.tokenAddress) || new Decimal(0);
      realizedByTokenMap.set(r.tokenAddress, running.plus(r.realizedPnlUsd));
    }

    for (const h of snap.holdings) {
      const existing = holdingsByToken.get(h.tokenAddress);
      const quantity = new Decimal(h.quantity);
      const costBasisUsd = new Decimal(h.costBasisUsd);
      const marketValueUsd = h.marketValueUsd != null ? new Decimal(h.marketValueUsd) : null;
      if (!existing) {
        holdingsByToken.set(h.tokenAddress, { tokenAddress: h.tokenAddress, quantity, costBasisUsd, marketValueUsd });
      } else {
        existing.quantity = existing.quantity.plus(quantity);
        existing.costBasisUsd = existing.costBasisUsd.plus(costBasisUsd);
        // Same "unresolved price contributes to neither side" convention as valueInventoryAtTimestamp —
        // if EITHER wallet's holding of this token has an unresolved price, the combined figure can't
        // honestly claim a total either.
        existing.marketValueUsd = existing.marketValueUsd != null && marketValueUsd != null ? existing.marketValueUsd.plus(marketValueUsd) : null;
      }
    }
  }

  return {
    asOf: new Date(),
    holdings: [...holdingsByToken.values()].map((h) => ({
      tokenAddress: h.tokenAddress,
      quantity: h.quantity.toString(),
      costBasisUsd: h.costBasisUsd.toString(),
      marketValueUsd: h.marketValueUsd?.toString() ?? null,
    })),
    realizedByToken: [...realizedByTokenMap.entries()].map(([tokenAddress, usd]) => ({ tokenAddress, realizedPnlUsd: usd.toString() })),
    currentValueUsd: currentValueUsd.toString(),
    unrealizedPnlUsd: unrealizedPnlUsd.toString(),
    realizedPnlUsd: realizedPnlUsd.toString(),
    gasUsd: gasUsd.toString(),
    pricingIncomplete,
  };
}

/**
 * One-time-per-wallet retroactive fill for the value-over-time chart: pnl_snapshots only got a
 * ROW GOING FORWARD from whenever pnlSnapshotScheduler.js first started ticking for a given wallet
 * (that table's own header comment is explicit about this — it's a lightweight daily rollup, never
 * a backfill mechanism) — so until this runs, the chart only ever has however many days have
 * elapsed since the scheduler was deployed, which for a brand-new wallet (or a brand-new feature)
 * can be as little as "today." This reconstructs the missing days retroactively, using the exact
 * same FIFO ledger / pricing pipeline as the live "right now" figures, so a backfilled day is never
 * a different kind of number than a scheduler-written one.
 *
 * Cost shape, and why this is safe to run inline rather than treat as some rare heavy job: the
 * expensive part of a FIFO replay is walking the event list, and replayFifoCheckpoints (see
 * fifoLotEngine.js) does that ONCE for all `windowDays` days combined, not once per day — what's
 * left scaling with `windowDays` is a cheap in-memory snapshot copy per day plus that day's pricing
 * lookups, and those lookups hit getHistoricalPriceUsd's day-bucketed cache (see pnlPricing.js) for
 * any token this wallet has already caused to be bulk-backfilled, which by the time this runs is
 * normally every token it holds — a historical price lookup here is a cache read, not a fresh
 * GeckoTerminal crawl, for the common case.
 *
 * Idempotent and resumable: only computes days that don't already have a pnl_snapshots row (a
 * cheap existence check against the whole window, done BEFORE building the event list at all — a
 * wallet whose backfill already completed costs one indexed query and nothing more on every later
 * call), so an interrupted run, a redeploy mid-backfill, or calling this again after the daily
 * scheduler has since filled in more days all just pick up whatever's still missing.
 *
 * `ownerWallet` is needed here (unlike computeLivePnlSnapshot) purely because pnl_snapshots rows
 * are keyed by (owner_wallet, wallet_address, date) — see that table's own schema comment.
 */
export async function backfillPnlHistory(ownerWallet, trackedWallet, selfOwnedAddresses = [], windowDays = 365) {
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  const days = [];
  for (let i = windowDays; i >= 1; i--) {
    // oldest first; i=0 (today) is deliberately excluded — the daily scheduler already writes
    // today's row itself, right before it calls this.
    const d = new Date(todayUtc);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d);
  }

  const fromDateStr = days[0].toISOString().slice(0, 10);
  const toDateStr = days[days.length - 1].toISOString().slice(0, 10);
  const existingDates = new Set(await getExistingSnapshotDates(ownerWallet, trackedWallet, fromDateStr, toDateStr));
  const missingDays = days.filter((d) => !existingDates.has(d.toISOString().slice(0, 10)));
  if (missingDays.length === 0) return; // fully backfilled already — nothing to do, and no need to touch ingestion/events at all

  // No priorityAssets here — a backfill only ever runs after this wallet already has at least one
  // successful live snapshot (see the trigger in pnlSnapshotScheduler.js), so cold-start priority
  // scoping never applies by this point; full pricing throughout.
  const { events, transfers } = await buildEventsForWallet(trackedWallet, selfOwnedAddresses, null, new Date());

  // Each checkpoint is the EXCLUSIVE end of its calendar day (start of the next day) — matches
  // replayFifo's own "closing = snapshot as of periodEnd, events at/after periodEnd excluded"
  // convention, so a backfilled day's figures mean exactly what a scheduler-written day's do.
  const checkpoints = missingDays.map((d) => new Date(d.getTime() + 24 * 60 * 60 * 1000).getTime());
  const snapshots = replayFifoCheckpoints(events, checkpoints);

  for (let i = 0; i < missingDays.length; i++) {
    const day = missingDays[i];
    const dateStr = day.toISOString().slice(0, 10);
    const dayEndExclusive = new Date(checkpoints[i]);
    const { lots, realizedPnlUsdCumulative } = snapshots[i];

    try {
      const transfersUpToDay = transfers.filter((t) => new Date(t.timestamp) < dayEndExclusive);
      const [valuation, gas] = await Promise.all([
        valueInventoryAtTimestamp(lots, dayEndExclusive),
        computeGasFeesUsd(transfersUpToDay),
      ]);
      const realizedPnlUsd = realizedPnlUsdCumulative.minus(gas.totalGasUsd);

      await upsertPnlSnapshot(ownerWallet, trackedWallet, dateStr, {
        totalValueUsd: valuation.totalMarketValueUsd.toString(),
        realizedPnlUsd: realizedPnlUsd.toString(),
        unrealizedPnlUsd: valuation.totalUnrealizedUsd.toString(),
      });
    } catch (err) {
      // One bad day (a pricing hiccup, an RPC blip) shouldn't abort the rest of the backfill —
      // it's naturally retried on the next scheduler tick since this day is still missing then.
      console.warn(`⚠️  PnL history backfill: failed for ${trackedWallet} on ${dateStr}:`, err.message);
    }
  }
}
