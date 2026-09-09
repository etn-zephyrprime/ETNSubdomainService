// backend/services/categoryPnlService.js
//
// Per-category PnL history — "Liquidity Positions" and "Staking / Yield Farms" charts, alongside
// the existing whole-portfolio Value Over Time chart (pnlSnapshotService.js/pnl_snapshots.sql).
// Same "simplest possible daily rollup, computed via one replayFifoCheckpoints pass over the whole
// missing window" design as that file's own backfillPnlHistory — see this file's own
// backfillCategoryPnlHistory for the one real difference: no separate "write today live" step
// (there's no live, right-now display for a category the way the whole-portfolio one has — the
// existing Liquidity Positions / Staked & Farming Positions sections on the Portfolio page already
// cover "right now" via lpPositionValuation.js/defiPositionValuation.js), so this backfills the
// FULL window INCLUDING today, called once daily from the same scheduler tick that backfills the
// whole-portfolio history.
//
// KNOWN LIMITATION, deliberate rather than overlooked: this is built purely from the FIFO ledger's
// own lot snapshot (fifoLotEngine.js's FifoLedger.snapshot()), which — same as
// computeLivePnlSnapshot's own holdings — only ever returns OPEN (freely-held) lots, never
// CURRENTLY-LOCKED ones (funds sitting in a farm/staking contract right now use a SEPARATE
// lockedLotsByToken map that snapshot() doesn't touch at all; see fifoLotEngine.js's own lock()/
// unlock() comments). So the "Staking / Yield Farms" chart shows real PnL history for reward
// tokens and for principal during any period it WASN'T locked (before locking, after unlocking) —
// it does NOT show the live value of principal that's currently locked, the same gap
// defiPositionValuation.js's own header comment identifies for the live "right now" figures.
// Reconstructing what a currently-locked position was worth on an arbitrary PAST day would need
// point-in-time historical contract-state queries this app has no way to do — rather than fake
// that or silently produce a misleading chart, this is a documented, known scope boundary; a
// wallet with an actively-open farm/stake position will correctly show $0 contribution from that
// position specifically, not a bug.
import Decimal from "decimal.js";
import { replayFifoCheckpoints } from "./fifoLotEngine.js";
import { valueInventoryAtTimestamp, resolveFarmStakingTokenKeys } from "./pnlEventBuilder.js";
import { buildEventsForWallet } from "./pnlSnapshotService.js";
import { probeV2Pool } from "./lpPositionValuation.js";
import { POSITION_MANAGER_ADDRESS } from "./pnlIngestion.js";
import { getAllDefiActivityBefore } from "../db/defiActivity.js";
import { upsertPnlCategorySnapshot, getExistingCategorySnapshotDates } from "../db/pnlCategorySnapshots.js";

export const CATEGORIES = { LIQUIDITY: "liquidity", FARM_STAKING: "farm_staking" };

/** Classifies every distinct token key across `events` into "liquidity" (a confirmed V2 LP pool
 * token, or a V3 position's own composite key — see pnlIngestion.js's own V3 header comment) or
 * "farm_staking" (resolved from `defiActivity` — see resolveFarmStakingTokenKeys's own comment).
 * A key can only ever land in one category: a V2/V3 key's shape is structurally distinct from a
 * real fungible token address, and this app has no scenario where a genuine farm/staking token
 * (CORE, a farm's own token0/token1, a reward token) is ALSO an LP pool contract — so there's no
 * double-counting risk between the two, and a caller can safely treat the two Sets as disjoint. */
async function resolveCategoryTokenKeys(events, defiActivity) {
  const candidates = new Set(events.map((e) => e.tokenAddress).filter(Boolean));
  const liquidity = new Set();
  for (const key of candidates) {
    if (key.startsWith(`${POSITION_MANAGER_ADDRESS}:`)) {
      liquidity.add(key);
      continue;
    }
    if (key.includes(":")) continue; // some other composite key shape (e.g. a real NFT) — not a liquidity position
    const pool = await probeV2Pool(key).catch(() => null);
    if (pool) liquidity.add(key);
  }
  const farmStaking = await resolveFarmStakingTokenKeys(defiActivity);
  return { [CATEGORIES.LIQUIDITY]: liquidity, [CATEGORIES.FARM_STAKING]: farmStaking };
}

/** One category's {totalValueUsd, realizedPnlUsd, unrealizedPnlUsd} at a point in time, filtering
 * a FULL (unfiltered) lots/realizedEvents snapshot down to just `tokenKeys` first. Gross of gas,
 * same convention pnlSnapshotService.js's own per-token realizedByToken already uses and documents
 * — gas is paid in ETN regardless of which category a transaction touched, so there's no honest
 * way to carve a slice of it out for just this category. */
async function valueCategoryAtCheckpoint(lots, realizedEvents, tokenKeys, timestamp) {
  const categoryLots = lots.filter((l) => tokenKeys.has(l.tokenAddress));
  const categoryRealized = realizedEvents.filter((e) => tokenKeys.has(e.tokenAddress));
  const valuation = await valueInventoryAtTimestamp(categoryLots, timestamp);
  const realizedPnlUsd = categoryRealized.reduce((sum, e) => sum.plus(e.realizedPnlUsd), new Decimal(0));
  return { totalValueUsd: valuation.totalMarketValueUsd, unrealizedPnlUsd: valuation.totalUnrealizedUsd, realizedPnlUsd };
}

/**
 * Retroactively fills BOTH category charts' missing days for one wallet, in ONE
 * replayFifoCheckpoints pass shared across both categories — the expensive part (walking the
 * whole event list) never needs to happen twice just because there are two categories, only the
 * final per-day filter+valuation step differs between them. Idempotent/resumable exactly like
 * pnlSnapshotService.js's own backfillPnlHistory: a day already recorded for a given category is
 * never recomputed, so a wallet whose farm/staking history finishes backfilling before its
 * liquidity history does (or vice versa) still converges correctly, and a wallet with NEITHER kind
 * of activity costs one cheap existence check and nothing more.
 *
 * Unlike backfillPnlHistory, this covers TODAY too (see this file's own header comment on why
 * there's no separate live write for a category) — so on any day after a wallet's window is fully
 * backfilled, this still does a small amount of real work (recomputing just today's row) rather
 * than becoming a complete no-op, same cost shape as the scheduler's own "write today, backfill
 * the rest" split for the whole-portfolio chart, just folded into one function here.
 */
export async function backfillCategoryPnlHistory(ownerWallet, trackedWallet, selfOwnedAddresses = [], windowDays = 365) {
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  const days = [];
  for (let i = windowDays; i >= 0; i--) { // i=0 (today) INCLUDED — see this function's own comment
    const d = new Date(todayUtc);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d);
  }
  const fromDateStr = days[0].toISOString().slice(0, 10);
  const toDateStr = days[days.length - 1].toISOString().slice(0, 10);

  const categories = Object.values(CATEGORIES);
  const existingDateSets = await Promise.all(
    categories.map((cat) => getExistingCategorySnapshotDates(ownerWallet, trackedWallet, cat, fromDateStr, toDateStr))
  );
  const existingByCategory = new Map(categories.map((cat, i) => [cat, new Set(existingDateSets[i])]));

  // Only the days missing from AT LEAST ONE category need replaying at all — a day already
  // present for every category is skipped entirely, same as backfillPnlHistory's own missingDays
  // filter, just OR'd across categories instead of checked against a single table.
  const missingDays = days.filter((d) => {
    const dateStr = d.toISOString().slice(0, 10);
    return categories.some((cat) => !existingByCategory.get(cat).has(dateStr));
  });
  if (missingDays.length === 0) return; // every category's window is already fully caught up through today

  const [{ events }, defiActivity] = await Promise.all([
    buildEventsForWallet(trackedWallet, selfOwnedAddresses, null, new Date()),
    getAllDefiActivityBefore(trackedWallet, new Date()),
  ]);
  const categoryTokenKeys = await resolveCategoryTokenKeys(events, defiActivity);

  // Each checkpoint is the EXCLUSIVE end of its calendar day — same convention as
  // backfillPnlHistory's own checkpoints (see that function's own comment).
  const checkpoints = missingDays.map((d) => new Date(d.getTime() + 24 * 60 * 60 * 1000).getTime());
  const snapshots = replayFifoCheckpoints(events, checkpoints);

  for (let i = 0; i < missingDays.length; i++) {
    const day = missingDays[i];
    const dateStr = day.toISOString().slice(0, 10);
    const dayEndExclusive = new Date(checkpoints[i]);
    const { lots, realizedEvents } = snapshots[i];

    for (const category of categories) {
      if (existingByCategory.get(category).has(dateStr)) continue; // this specific category already has this day — see this function's own header comment on why that's checked per-day, not just once up front
      try {
        const tokenKeys = categoryTokenKeys[category];
        const { totalValueUsd, realizedPnlUsd, unrealizedPnlUsd } = await valueCategoryAtCheckpoint(lots, realizedEvents, tokenKeys, dayEndExclusive);
        await upsertPnlCategorySnapshot(ownerWallet, trackedWallet, category, dateStr, {
          totalValueUsd: totalValueUsd.toString(),
          realizedPnlUsd: realizedPnlUsd.toString(),
          unrealizedPnlUsd: unrealizedPnlUsd.toString(),
        });
      } catch (err) {
        // One bad day/category shouldn't abort the rest — naturally retried next time this runs,
        // since this day+category is still missing then. Same posture as backfillPnlHistory's own
        // per-day catch.
        console.warn(`⚠️  Category PnL history backfill: failed for ${trackedWallet} (${category}) on ${dateStr}:`, err.message);
      }
    }
  }
}
