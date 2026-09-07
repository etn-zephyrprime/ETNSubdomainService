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
import { ingestWalletHistory, backfillDeferredPrices } from "./pnlIngestion.js";
import { replayFifo } from "./fifoLotEngine.js";
import {
  transferToEvent,
  buildNftEvents,
  swapToEvent,
  buildDefiFarmEvents,
  computeGasFeesUsd,
  valueInventoryAtTimestamp,
} from "./pnlEventBuilder.js";

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

  const [transfers, swaps, defiActivity] = await Promise.all([
    getAllTransfersBefore(trackedWallet, now),
    getAllSwapTradesBefore(trackedWallet, now),
    getAllDefiActivityBefore(trackedWallet, now),
  ]);

  const { events: nftEvents, consumedRowIds: nftConsumedRowIds } = buildNftEvents(transfers);
  const { events: defiEvents } = await buildDefiFarmEvents(defiActivity, priorityAssets);
  const events = [
    ...transfers.filter((t) => !nftConsumedRowIds.has(t.id)).map(transferToEvent),
    ...swaps.map(swapToEvent),
    ...nftEvents,
    ...defiEvents,
  ].sort((a, b) => a.timestamp - b.timestamp);

  const { closing } = replayFifo(events, now, now);

  const [valuation, gas] = await Promise.all([
    valueInventoryAtTimestamp(closing.lots, now),
    computeGasFeesUsd(transfers), // whole history — this view has no period to scope it to
  ]);

  const realizedPnlUsdGross = closing.realizedEvents.reduce((sum, e) => sum.plus(e.realizedPnlUsd), new Decimal(0));
  const realizedPnlUsd = realizedPnlUsdGross.minus(gas.totalGasUsd);

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
    // itself already documents).
    holdings: valuation.perToken,
    currentValueUsd: valuation.totalMarketValueUsd.toString(),
    unrealizedPnlUsd: valuation.totalUnrealizedUsd.toString(),
    realizedPnlUsd: realizedPnlUsd.toString(),
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
    currentValueUsd: currentValueUsd.toString(),
    unrealizedPnlUsd: unrealizedPnlUsd.toString(),
    realizedPnlUsd: realizedPnlUsd.toString(),
    gasUsd: gasUsd.toString(),
    pricingIncomplete,
  };
}
