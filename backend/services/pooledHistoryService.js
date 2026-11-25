// backend/services/pooledHistoryService.js
//
// On-demand daily history (whole portfolio, one category, one token) under the pooled average-cost
// method. The stored pnl_snapshots / pnl_category_snapshots rows are FIFO-only, so pooled history is
// computed from the wallet's event history and kept in memory only (no extra Supabase writes). Each
// call does one events read per wallet, the same read the existing token history does.
//
// Same day convention as the stored backfills: a day's checkpoint is the exclusive end of that
// calendar day, and today is included. Realized P&L for the whole portfolio is net of cumulative gas
// (matching pnlSnapshotService.backfillPnlHistory); category and token figures are gross of gas,
// matching their FIFO counterparts.
import Decimal from "decimal.js";
import { buildEventsForWallet } from "./pnlSnapshotService.js";
import { computeCumulativeGasUsdAtCheckpoints, valueInventoryAtTimestamp } from "./pnlEventBuilder.js";
import { replayPooledCheckpoints } from "./pooledCostEngine.js";
import { resolveCategoryTokenKeys, CATEGORIES } from "./categoryPnlService.js";
import { getIngestionState } from "../db/walletIngestionState.js";
import { runHeavy } from "../utils/heavyWork.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 48;
const historyCache = new Map(); // key -> { points, computedAt, ingestionUpdatedAt }

function cacheKeyFor(kind, trackedWallet, selfOwnedAddresses, arg, windowDays) {
  const selfOwnedKey = [...selfOwnedAddresses].map((a) => a.toLowerCase()).sort().join(",");
  return `${kind}|${trackedWallet.toLowerCase()}|${selfOwnedKey}|${arg ?? ""}|${windowDays ?? "all"}`;
}

function rememberPoints(key, entry) {
  historyCache.delete(key);
  historyCache.set(key, entry);
  while (historyCache.size > CACHE_MAX_ENTRIES) historyCache.delete(historyCache.keys().next().value);
}

/** Whole-day checkpoints (exclusive day ends) for the trailing window, today inclusive. `windowDays`
 * null means "the wallet's whole history", derived from its earliest event. */
function buildDays(events, windowDays) {
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const effectiveWindow =
    windowDays != null
      ? windowDays
      : events.length > 0
        ? Math.ceil((todayUtc.getTime() - new Date(events[0].timestamp).setUTCHours(0, 0, 0, 0)) / DAY_MS)
        : 0;
  const days = [];
  for (let i = effectiveWindow; i >= 0; i--) {
    days.push(new Date(todayUtc.getTime() - i * DAY_MS));
  }
  const checkpoints = days.map((d) => d.getTime() + DAY_MS);
  return { days, checkpoints };
}

/** Shared per-request path: fetch the wallet's events once, replay them pooled at every day end. */
async function replayWalletDaily(trackedWallet, selfOwnedAddresses, windowDays) {
  const built = await buildEventsForWallet(trackedWallet, selfOwnedAddresses, null, new Date());
  const { days, checkpoints } = buildDays(built.events, windowDays);
  const snapshots = replayPooledCheckpoints(built.events, checkpoints);
  return { built, days, checkpoints, snapshots };
}

async function withCache(key, ingestionStatePromise, compute) {
  const ingestionState = await ingestionStatePromise.catch(() => null);
  const ingestionUpdatedAt = ingestionState?.updated_at ? new Date(ingestionState.updated_at).getTime() : null;
  const cached = historyCache.get(key);
  if (cached && cached.ingestionUpdatedAt === ingestionUpdatedAt && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return cached.points;
  }
  const { points, complete } = await compute();
  if (complete) rememberPoints(key, { points, computedAt: Date.now(), ingestionUpdatedAt });
  return points;
}

/**
 * The whole portfolio's daily {date, totalValueUsd, realizedPnlUsd, unrealizedPnlUsd} for one
 * wallet, under the pooled method. realizedPnlUsd is cumulative and net of gas, as in the stored
 * rollup.
 */
export function computePooledWalletHistory(trackedWallet, selfOwnedAddresses = [], windowDays = 365) {
  return runHeavy("computePooledWalletHistory", async () => {
    const key = cacheKeyFor("wallet", trackedWallet, selfOwnedAddresses, null, windowDays);
    return withCache(key, getIngestionState(trackedWallet), async () => {
      const { built, days, checkpoints, snapshots } = await replayWalletDaily(trackedWallet, selfOwnedAddresses, windowDays);
      const gasUsdByCheckpoint = await computeCumulativeGasUsdAtCheckpoints(built.transfers, checkpoints);
      const points = [];
      for (let i = 0; i < days.length; i++) {
        const { lots, realizedPnlUsdCumulative } = snapshots[i];
        const valuation = await valueInventoryAtTimestamp(lots, new Date(checkpoints[i]));
        points.push({
          date: days[i].toISOString().slice(0, 10),
          totalValueUsd: valuation.totalMarketValueUsd.toNumber(),
          realizedPnlUsd: realizedPnlUsdCumulative.minus(gasUsdByCheckpoint[i]).toNumber(),
          unrealizedPnlUsd: valuation.totalUnrealizedUsd.toNumber(),
        });
      }
      return { points, complete: !built.incomplete };
    });
  });
}

/** One category's (liquidity or farm_staking) daily series under the pooled method. Gross of gas. */
export function computePooledCategoryHistory(trackedWallet, selfOwnedAddresses = [], category, windowDays = 365) {
  if (!Object.values(CATEGORIES).includes(category)) throw new Error(`Unknown category "${category}"`);
  return runHeavy("computePooledCategoryHistory", async () => {
    const key = cacheKeyFor("category", trackedWallet, selfOwnedAddresses, category, windowDays);
    return withCache(key, getIngestionState(trackedWallet), async () => {
      const { built, days, checkpoints, snapshots } = await replayWalletDaily(trackedWallet, selfOwnedAddresses, windowDays);
      const tokenKeys = (await resolveCategoryTokenKeys(built.events, built.defiActivity))[category];
      const points = [];
      let cumulativeRealized = new Decimal(0);
      for (let i = 0; i < days.length; i++) {
        const { lots, newRealizedEvents } = snapshots[i];
        cumulativeRealized = newRealizedEvents
          .filter((e) => tokenKeys.has(e.tokenAddress))
          .reduce((sum, e) => sum.plus(e.realizedPnlUsd), cumulativeRealized);
        const valuation = await valueInventoryAtTimestamp(lots.filter((l) => tokenKeys.has(l.tokenAddress)), new Date(checkpoints[i]));
        points.push({
          date: days[i].toISOString().slice(0, 10),
          totalValueUsd: valuation.totalMarketValueUsd.toNumber(),
          realizedPnlUsd: cumulativeRealized.toNumber(),
          unrealizedPnlUsd: valuation.totalUnrealizedUsd.toNumber(),
        });
      }
      return { points, complete: !built.incomplete };
    });
  });
}

/** One token's daily series under the pooled method. Gross of gas, as computeTokenPnlHistory is. */
export function computePooledTokenHistory(trackedWallet, selfOwnedAddresses = [], tokenAddress, windowDays = 365) {
  const tokenKey = tokenAddress.toLowerCase();
  return runHeavy("computePooledTokenHistory", async () => {
    const key = cacheKeyFor("token", trackedWallet, selfOwnedAddresses, tokenKey, windowDays);
    return withCache(key, getIngestionState(trackedWallet), async () => {
      const { built, days, checkpoints, snapshots } = await replayWalletDaily(trackedWallet, selfOwnedAddresses, windowDays);
      const points = [];
      let cumulativeRealized = new Decimal(0);
      for (let i = 0; i < days.length; i++) {
        const { lots, newRealizedEvents } = snapshots[i];
        cumulativeRealized = newRealizedEvents
          .filter((e) => e.tokenAddress === tokenKey)
          .reduce((sum, e) => sum.plus(e.realizedPnlUsd), cumulativeRealized);
        const valuation = await valueInventoryAtTimestamp(lots.filter((l) => l.tokenAddress === tokenKey), new Date(checkpoints[i]));
        points.push({
          date: days[i].toISOString().slice(0, 10),
          totalValueUsd: valuation.totalMarketValueUsd.toNumber(),
          realizedPnlUsd: cumulativeRealized.toNumber(),
          unrealizedPnlUsd: valuation.totalUnrealizedUsd.toNumber(),
        });
      }
      return { points, complete: !built.incomplete };
    });
  });
}
