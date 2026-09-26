// backend/services/tokenPnlService.js
//
// On-demand per-token PnL history for the "Value Over Time" chart's per-token filter
// (CoreTierPnl.jsx) — deliberately NOT a precomputed/stored daily rollup like
// categoryPnlService.js's own Liquidity/Staking charts. Those two are a small, FIXED set of
// categories (2), so pre-storing 365 days for every tracked wallet is cheap and bounded. A single
// held token is neither fixed nor bounded — every new token a wallet ever picks up would need its
// own backfilled history, growing storage unboundedly per wallet rather than the flat "2 categories
// x wallets" cost the category tables have. Computing it fresh, only for the one token a member
// actually selects, right when they select it, keeps this feature's cost proportional to how often
// it's actually used rather than to how many tokens exist across every tracked wallet — see
// categoryPnlService.js's own header comment for the precomputed alternative this deliberately
// isn't. Confirmed decision (see that file/this feature's own design discussion).
//
// Cost is comparable to computeLivePnlSnapshot's own live replay (same order of magnitude — one
// buildEventsForWallet + one replayFifoCheckpoints pass), NOT a new class of expensive: the FIFO
// primitives (replayFifoCheckpoints, lot-filtering by tokenAddress) are already fully generic over
// an arbitrary token-key Set, proven at the "2 categories" scale in categoryPnlService.js — a single
// token is just a Set with one member instead of many.
//
// Fungible tokens only — a `tokenAddress` here must be a plain token contract address, never a V2/V3
// composite key or an NFT's "collection:tokenId" key. NFTs have their own dedicated PnL section
// (CoreTierNftPnl.jsx / nftPnlService.js) — explicitly out of scope for this filter (confirmed:
// "don't add NFT, there is a whole section just for that").
import Decimal from "decimal.js";
import { replayFifoCheckpoints } from "./fifoLotEngine.js";
import { valueInventoryAtTimestamp } from "./pnlEventBuilder.js";
import { buildEventsForWallet } from "./pnlSnapshotService.js";
import { getIngestionState } from "../db/walletIngestionState.js";

// Short-lived cache, same shape/reasoning as pnlSnapshotService.js's own snapshotCache — a member
// toggling the token filter (or a component re-rendering) shouldn't repeat this same replay within
// a few seconds. Invalidated the moment real new ingestion lands for this wallet, same as that
// cache, not just by time.
const tokenHistoryCache = new Map(); // cacheKey -> { points, computedAt: ms, ingestionUpdatedAt: ms|null }
const TOKEN_HISTORY_CACHE_TTL_MS = process.env.PNL_TOKEN_HISTORY_CACHE_TTL_MS
  ? parseInt(process.env.PNL_TOKEN_HISTORY_CACHE_TTL_MS, 10)
  : 10 * 60 * 1000; // 10 min: history is fixed data plus today's live price — the whole-history read behind it is the expensive part (see pnlSnapshotService.js's getLedgerState comment)

function tokenHistoryCacheKey(trackedWallet, selfOwnedAddresses, tokenKey, windowDays) {
  const selfOwnedKey = [...selfOwnedAddresses].map((a) => a.toLowerCase()).sort().join(",");
  return `${trackedWallet.toLowerCase()}|${selfOwnedKey}|${tokenKey}|${windowDays ?? "all"}`;
}

/**
 * One token's daily `{date, totalValueUsd, realizedPnlUsd, unrealizedPnlUsd}` series for
 * `trackedWallet` over the trailing `windowDays` (today inclusive) — computed fresh via one
 * replayFifoCheckpoints pass over the wallet's full event history, then filtered down to just this
 * token's lots/realized events at each checkpoint (same technique as
 * categoryPnlService.js's own backfillCategoryPnlHistory, just against one token key instead of a
 * category's resolved Set, and computed on read rather than stored).
 *
 * `windowDays = null` means "the wallet's entire history" — since this is computed on demand
 * (nothing stored to just query a floor date from), that's derived from the earliest event this
 * wallet actually has, not an arbitrary large constant.
 */
export async function computeTokenPnlHistory(trackedWallet, selfOwnedAddresses = [], tokenAddress, windowDays = 365) {
  const tokenKey = tokenAddress.toLowerCase();
  const key = tokenHistoryCacheKey(trackedWallet, selfOwnedAddresses, tokenKey, windowDays);
  const ingestionState = await getIngestionState(trackedWallet).catch(() => null);
  const ingestionUpdatedAtMs = ingestionState?.updated_at ? new Date(ingestionState.updated_at).getTime() : null;

  const cached = tokenHistoryCache.get(key);
  if (cached && Date.now() - cached.computedAt < TOKEN_HISTORY_CACHE_TTL_MS && cached.ingestionUpdatedAt === ingestionUpdatedAtMs) {
    return cached.points;
  }

  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  const { events } = await buildEventsForWallet(trackedWallet, selfOwnedAddresses, null, new Date());

  const effectiveWindowDays =
    windowDays != null
      ? windowDays
      : events.length > 0
        ? Math.ceil((todayUtc.getTime() - new Date(events[0].timestamp).setUTCHours(0, 0, 0, 0)) / (24 * 60 * 60 * 1000))
        : 0;

  const days = [];
  for (let i = effectiveWindowDays; i >= 0; i--) { // i=0 (today) INCLUDED — same convention as categoryPnlService.js
    const d = new Date(todayUtc);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d);
  }

  // Each checkpoint is the EXCLUSIVE end of its calendar day — same convention as
  // backfillPnlHistory/backfillCategoryPnlHistory's own checkpoints.
  const checkpoints = days.map((d) => new Date(d.getTime() + 24 * 60 * 60 * 1000).getTime());
  const snapshots = replayFifoCheckpoints(events, checkpoints);

  let cumulativeRealized = new Decimal(0);
  const points = [];
  for (let i = 0; i < days.length; i++) {
    const dateStr = days[i].toISOString().slice(0, 10);
    const { lots, newRealizedEvents } = snapshots[i];
    const delta = newRealizedEvents
      .filter((e) => e.tokenAddress === tokenKey)
      .reduce((sum, e) => sum.plus(e.realizedPnlUsd), new Decimal(0));
    cumulativeRealized = cumulativeRealized.plus(delta);

    const tokenLots = lots.filter((l) => l.tokenAddress === tokenKey);
    const valuation = await valueInventoryAtTimestamp(tokenLots, new Date(checkpoints[i]));
    points.push({
      date: dateStr,
      totalValueUsd: valuation.totalMarketValueUsd.toNumber(),
      realizedPnlUsd: cumulativeRealized.toNumber(),
      unrealizedPnlUsd: valuation.totalUnrealizedUsd.toNumber(),
    });
  }

  tokenHistoryCache.set(key, { points, computedAt: Date.now(), ingestionUpdatedAt: ingestionUpdatedAtMs });
  return points;
}

/** Merges per-wallet daily point arrays into one combined series. Simpler than
 * pnlCategorySnapshots.js's own combineCategorySnapshotsByDate (no forward-fill needed): unlike a
 * partial DB-backed rollup, every array here comes from computeTokenPnlHistory's own identical
 * `days` construction, so every wallet's array already has exactly one entry per day in the window,
 * in the same order — a plain index-aligned sum is correct, not just a shortcut. */
export function combineTokenPnlHistory(perWalletPoints) {
  if (perWalletPoints.length === 0) return [];
  const dateCount = perWalletPoints[0].length;
  const combined = [];
  for (let i = 0; i < dateCount; i++) {
    const date = perWalletPoints[0][i].date;
    let totalValueUsd = 0, realizedPnlUsd = 0, unrealizedPnlUsd = 0;
    for (const points of perWalletPoints) {
      const p = points[i];
      if (!p) continue;
      totalValueUsd += p.totalValueUsd;
      realizedPnlUsd += p.realizedPnlUsd;
      unrealizedPnlUsd += p.unrealizedPnlUsd;
    }
    combined.push({ date, totalValueUsd, realizedPnlUsd, unrealizedPnlUsd });
  }
  return combined;
}
