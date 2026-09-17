// backend/services/diamondHandsService.js
//
// "Diamond Hands Score" — a gamified holding-BEHAVIOR score, built entirely as a read/aggregation
// layer on top of the existing FIFO ledger (fifoLotEngine.js via pnlSnapshotService.js's own
// buildEventsForWallet/replayFifo, the exact same machinery the live PnL snapshot and PnL
// Statement already use). No new lot-tracking logic — see the build brief this was written from.
//
// Answers a different question than PnL does: not "did you make money" but "how do you actually
// behave when you hold — do you sit through volatility, or sell at the first sign of trouble."
// Deliberately says nothing about performance (see WEIGHT_* below and the retention-rate comment:
// this is why retention is computed in cost-basis terms, not mark-to-market — a token that mooned
// shouldn't inflate this score purely from price movement, only from behavior).
//
// On-chain only (no CEX — same scoping as the live PnL snapshot, not the CEX-inclusive Statement).
// Live, recomputed fresh on every call, never frozen/cached here (same "not a formal record"
// treatment as computeLivePnlSnapshot — see that function's own header comment).
//
// ============================================================================================
// PROVISIONAL DEFAULTS — confirmed decision: ship with these, calibrate against real tracked-
// wallet score distribution once this has run against real Core Tier members. Do not treat these
// as final without that look.
// ============================================================================================
import Decimal from "decimal.js";
import { getIngestionState } from "../db/walletIngestionState.js";
import { ingestWalletHistory, POSITION_MANAGER_ADDRESS } from "./pnlIngestion.js";
import { buildEventsForWallet } from "./pnlSnapshotService.js";
import { replayFifo } from "./fifoLotEngine.js";
import { getPricePointsSince } from "../db/pricePoints.js";

// Rolling window (ending at each disposal) a "recent high" is measured over, and how far below
// that high counts as "sold into a dip" — both the build brief's own suggested example numbers.
const ROLLING_HIGH_WINDOW_DAYS = 30;
const DIP_THRESHOLD = 0.15;

// Below this many real cached daily price points inside a disposal's own 30-day window, that
// disposal's panic-sell classification is left UNKNOWN rather than guessed from thin data — see
// computeComponentsForScope's own comment on why this reuses only already-cached price_points
// rows (getPricePointsSince) instead of triggering fresh price-history API calls live per
// disposal, which could mean 30+ GeckoTerminal/CoinGecko calls for a single request on a wallet
// with many trades across many tokens.
const MIN_PRICE_POINTS_FOR_DIP_CHECK = 5;

// Confirmed weighting, in order of how directly each component signals the behavior this score is
// actually named for: panic-sell avoidance is the most direct test of "did you hold firm when it
// was tested"; holding period rewards patience and naturally stays low for brand-new positions
// (partially self-correcting the "just don't sell yet" gaming risk); retention rate is real
// information but the easiest to inflate with no real test behind it, so it counts least.
const WEIGHT_PANIC_SELL = 0.40;
const WEIGHT_HOLDING_PERIOD = 0.35;
const WEIGHT_RETENTION = 0.25;

// A year of average holding weighted-by-value maps to a perfect 100 on this one component —
// provisional, linear, simplest disclosed scale; recalibrate once real wallets' actual holding
// periods are visible.
const HOLDING_PERIOD_PERFECT_SCORE_DAYS = 365;

const TIERS = [
  { min: 80, name: "Titanium Hands" },
  { min: 60, name: "Diamond Hands" },
  { min: 40, name: "Steady Hands" },
  { min: 0, name: "Paper Hands" },
];

function tierFor(score) {
  return TIERS.find((t) => score >= t.min).name;
}

function clamp100(x) {
  return Math.max(0, Math.min(100, x));
}

// Classifies one lot/event's own `tokenAddress` key for the per-asset breakdown below. Same
// "address:tokenId" composite-key shape (and the same V3-position carve-out) as
// groupNftHoldingsByCollection/pnlSnapshotService.js's own NFT_GROUPING_EXCLUSIONS use elsewhere
// in this app — a real NFT tokenId groups into its collection (so "By Asset" shows one "Bored Ape"
// row, not one row per tokenId ever bought/sold), while a V3 concentrated-liquidity position keeps
// its own composite key ungrouped, same reasoning as those call sites: it's a financial position,
// not a collectible to fold away.
function classifyAssetKey(tokenAddress) {
  if (tokenAddress === "NATIVE") return { type: "native", groupKey: tokenAddress };
  const colonIndex = tokenAddress.indexOf(":");
  if (colonIndex === -1) return { type: "token", groupKey: tokenAddress };
  const prefix = tokenAddress.slice(0, colonIndex);
  if (prefix === POSITION_MANAGER_ADDRESS) return { type: "lp", groupKey: tokenAddress };
  return { type: "nft", groupKey: prefix };
}

// Same asset-key normalization getCachedHistoricalPriceUsd/getHistoricalPriceUsd use internally
// (pnlPricing.js — not exported, so this is the smallest possible duplication of an already-
// established one-line convention rather than a real second implementation of anything).
function cacheAssetFor(tokenAddress) {
  return tokenAddress === "NATIVE" || tokenAddress.toUpperCase() === "ETN" ? "ETN" : tokenAddress.toLowerCase();
}

/**
 * Computes the three raw Diamond Hands components from a pool of `lots` (currently open) and
 * `realizedEvents` (every disposal ever, both already whatever replayFifo's own `closing` snapshot
 * returns — see fifoLotEngine.js), optionally scoped to one `tokenAddress` for an asset-level
 * drill-down. `lots`/`realizedEvents` may already be POOLED across several wallets by the caller
 * (see computeDiamondHandsScore's own portfolio-level combining) — this function has no idea how
 * many wallets its input came from, it just aggregates whatever it's given.
 *
 * Returns raw (un-normalized, un-combined) figures — see scoreFromComponents for the 0-100/
 * tier mapping. Never throws; a genuinely empty scope (no lots, no events) comes back with every
 * numeric field null rather than a divide-by-zero or a fabricated 0.
 */
// Exported for direct unit testing (no DB dependency when `realizedEvents` is empty — the only
// DB touch in here is the panic-sell price-history fetch, and Promise.all([]) short-circuits
// cleanly when there are no disposals to classify).
// `scope` is either a single tokenAddress string (exact match — the original shape, still what
// portfolio-level/per-wallet calls and existing unit tests pass), a Set of tokenAddress strings
// (matches any member — how a grouped NFT collection's several "collection:tokenId" keys get
// pooled into one scope, see computeDiamondHandsScore's own asset-grouping below), or null/
// undefined for no filtering at all.
export async function computeComponentsForScope(lots, realizedEvents, scope, now) {
  const matches = scope == null ? null : scope instanceof Set ? (addr) => scope.has(addr) : (addr) => addr === scope;
  const scopedLots = matches ? lots.filter((l) => matches(l.tokenAddress)) : lots;
  const scopedEvents = matches ? realizedEvents.filter((e) => matches(e.tokenAddress)) : realizedEvents;
  const nowMs = now.getTime();

  // ---- 1. Value-weighted average holding period ----
  // Weight = USD value AT ACQUISITION (unitCostUsd × quantity) for both still-held and disposed
  // portions — per the build brief's own "weight by value... rather than raw token quantity, so a
  // large low-value token doesn't distort the average." costBasisUsd on a realized event already
  // IS quantityConsumed × unitCostUsd (see fifoLotEngine.js's own dispose()), so no separate
  // multiplication is needed there.
  let weightedDaysSum = new Decimal(0);
  let holdingWeightTotal = new Decimal(0);

  for (const lot of scopedLots) {
    const weight = lot.quantityRemaining.times(lot.unitCostUsd);
    if (weight.lte(0)) continue;
    const days = (nowMs - new Date(lot.openedTimestamp).getTime()) / 86400000;
    weightedDaysSum = weightedDaysSum.plus(weight.times(days));
    holdingWeightTotal = holdingWeightTotal.plus(weight);
  }
  for (const e of scopedEvents) {
    // acquisitionTimestamp is null only for a FIFO shortfall portion (disposing more than this
    // ledger ever saw acquired — see dispose()'s own remainingShort handling) — there's no real
    // acquisition date to measure a holding period against, so it's excluded here rather than
    // guessed at zero (which would wrongly drag the average toward "never held it at all").
    if (e.acquisitionTimestamp == null) continue;
    const weight = e.costBasisUsd;
    if (weight.lte(0)) continue;
    const days = (new Date(e.timestamp).getTime() - new Date(e.acquisitionTimestamp).getTime()) / 86400000;
    weightedDaysSum = weightedDaysSum.plus(weight.times(days));
    holdingWeightTotal = holdingWeightTotal.plus(weight);
  }
  const avgHoldingDays = holdingWeightTotal.gt(0) ? weightedDaysSum.dividedBy(holdingWeightTotal).toNumber() : null;

  // ---- 2. Retention rate ----
  // Deliberately COST-BASIS terms (value at acquisition) for both numerator and denominator, NOT
  // today's mark-to-market value. A retention rate computed at current market price would let a
  // token that simply went up in price look more "retained" than one that didn't, even with
  // IDENTICAL selling behavior — that's performance leaking into a score the build brief is
  // explicit is about behavior only ("a diamond-hands score is about behavior, not about whether
  // that behavior made or lost money" — see its own "explicitly out of scope" section on HODL
  // benchmark comparisons). Held-in-cost-basis-terms keeps this a pure "how much of what you put
  // in did you keep" measure, immune to price movement either way.
  const heldValueUsd = scopedLots.reduce((sum, l) => sum.plus(l.quantityRemaining.times(l.unitCostUsd)), new Decimal(0));
  const disposedValueUsd = scopedEvents.reduce((sum, e) => sum.plus(e.costBasisUsd), new Decimal(0));
  const totalAcquiredUsd = heldValueUsd.plus(disposedValueUsd);
  const retentionRate = totalAcquiredUsd.gt(0) ? heldValueUsd.dividedBy(totalAcquiredUsd).toNumber() : null;

  // ---- 3. Panic-sell frequency ----
  // One range read from price_points per distinct token actually disposed in scope, not one per
  // disposal — getPricePointsSince is a cache read (already-resolved daily closes from ordinary
  // PnL ingestion elsewhere), never a fresh price-history fetch triggered live here. A disposal
  // whose own 30-day window has too few real cached points (MIN_PRICE_POINTS_FOR_DIP_CHECK) is
  // left UNCLASSIFIED — excluded from both dipSells and classifiedSells below — rather than
  // guessed from sparse data or paying for a live multi-day price-history backfill mid-request.
  const tokensWithDisposals = [...new Set(scopedEvents.map((e) => e.tokenAddress))];
  const priceHistoryByToken = new Map();
  await Promise.all(
    tokensWithDisposals.map(async (addr) => {
      const disposalTimesMs = scopedEvents.filter((e) => e.tokenAddress === addr).map((e) => new Date(e.timestamp).getTime());
      const windowStart = new Date(Math.min(...disposalTimesMs) - ROLLING_HIGH_WINDOW_DAYS * 86400000);
      const rows = await getPricePointsSince(cacheAssetFor(addr), windowStart);
      priceHistoryByToken.set(
        addr,
        rows.map((r) => ({ timestampMs: new Date(r.timestamp).getTime(), priceUsd: Number(r.price_usd) }))
      );
    })
  );

  let dipSells = 0;
  let classifiedSells = 0;
  for (const e of scopedEvents) {
    if (e.quantityConsumed.lte(0)) continue;
    const disposalMs = new Date(e.timestamp).getTime();
    const windowStartMs = disposalMs - ROLLING_HIGH_WINDOW_DAYS * 86400000;
    const series = priceHistoryByToken.get(e.tokenAddress) || [];
    const windowPrices = series.filter((p) => p.timestampMs >= windowStartMs && p.timestampMs <= disposalMs).map((p) => p.priceUsd);
    if (windowPrices.length < MIN_PRICE_POINTS_FOR_DIP_CHECK) continue;

    const rollingHigh = Math.max(...windowPrices);
    const disposalPricePerUnit = e.proceedsUsd.dividedBy(e.quantityConsumed).toNumber();
    classifiedSells++;
    if (rollingHigh > 0 && disposalPricePerUnit <= rollingHigh * (1 - DIP_THRESHOLD)) dipSells++;
  }
  const panicSellRate = classifiedSells > 0 ? dipSells / classifiedSells : null;

  return {
    avgHoldingDays,
    retentionRate,
    panicSellRate,
    dipSells,
    classifiedSells,
    totalSells: scopedEvents.length,
    totalAcquiredUsd: totalAcquiredUsd.toString(),
    heldValueUsd: heldValueUsd.toString(),
  };
}

/**
 * Maps raw components (from computeComponentsForScope) to 0-100 sub-scores, a combined score, and
 * a tier — the only place normalization/weighting/tier cutoffs live, so recalibrating any of them
 * later (see this file's own header comment) never means touching the raw aggregation above.
 *
 * Null-handling, each a deliberate choice, not an oversight:
 *   - avgHoldingDays null (nothing was ever acquired in scope) -> holding score excluded, weights
 *     renormalized across whatever components DO have data.
 *   - retentionRate null (same "nothing acquired" case) -> same exclusion/renormalization.
 *   - panicSellRate null with totalSells === 0 (never sold anything in scope) -> scored as a
 *     PERFECT 100 for this component: never having sold at all is, if anything, the most
 *     diamond-handed case this metric can observe, not an absence of data.
 *   - panicSellRate null with totalSells > 0 but classifiedSells === 0 (sold, but every disposal
 *     lacked enough price history to classify) -> genuinely unknown, excluded/renormalized, same
 *     as the other two nulls -- NOT treated as favorable, unlike the zero-sells case above.
 */
// Exported for direct unit testing — fully pure, no I/O at all.
export function scoreFromComponents(components) {
  const parts = [];
  // Each component's own normalized 0-100 sub-score, surfaced alongside the combined score/tier
  // purely for display (e.g. a progress bar per component) — null for whichever component got
  // excluded/renormalized above, same null-handling as the combined score itself. Computed here,
  // the one place normalization lives, rather than the frontend re-deriving them and risking drift.
  const subScores = { holdingPeriod: null, retention: null, panicSell: null };

  if (components.avgHoldingDays != null) {
    const s = clamp100((components.avgHoldingDays / HOLDING_PERIOD_PERFECT_SCORE_DAYS) * 100);
    subScores.holdingPeriod = s;
    parts.push({ weight: WEIGHT_HOLDING_PERIOD, score: s });
  }
  if (components.retentionRate != null) {
    const s = clamp100(components.retentionRate * 100);
    subScores.retention = s;
    parts.push({ weight: WEIGHT_RETENTION, score: s });
  }
  if (components.totalSells === 0) {
    subScores.panicSell = 100;
    parts.push({ weight: WEIGHT_PANIC_SELL, score: 100 });
  } else if (components.panicSellRate != null) {
    const s = clamp100((1 - components.panicSellRate) * 100);
    subScores.panicSell = s;
    parts.push({ weight: WEIGHT_PANIC_SELL, score: s });
  }

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  if (totalWeight === 0) return { score: null, tier: null, subScores };

  const score = parts.reduce((sum, p) => sum + p.score * p.weight, 0) / totalWeight;
  return { score, tier: tierFor(score), subScores };
}

/** One wallet's own (lots, realizedEvents) pair — ingests + replays exactly like
 * computeLivePnlSnapshot does, so this can never report different underlying holdings/disposals
 * than the PnL views do for the same wallet. */
async function getWalletLedgerState(trackedWallet, selfOwnedAddresses) {
  const now = new Date();
  const ingestionState = await getIngestionState(trackedWallet);
  if (!ingestionState?.cold_start_completed_at) {
    await ingestWalletHistory(trackedWallet, selfOwnedAddresses, null);
  }
  const { events } = await buildEventsForWallet(trackedWallet, selfOwnedAddresses, null, now);
  const { closing } = replayFifo(events, now, now);
  return { lots: closing.lots, realizedEvents: closing.realizedEvents, now };
}

/**
 * Full Diamond Hands result for a set of tracked wallets, combined as one pooled portfolio-level
 * ledger — NOT an average of per-wallet scores, an aggregation of the underlying lots/disposals
 * themselves, so e.g. retention rate reflects true portfolio-wide value retained rather than an
 * average of ratios that could mislead when wallets hold very different amounts.
 *
 * Each wallet's own ledger fetch is isolated in its own try/catch, same reasoning
 * pnlSnapshotRouter.js's own per-wallet loop already documents: a full transfer-history walk + FIFO
 * replay per wallet is real work, and one wallet's transient failure (an RPC hiccup, anything
 * ingestWalletHistory/buildEventsForWallet doesn't already swallow internally) shouldn't blank the
 * OTHER wallets' already-computable portfolio/per-wallet/per-asset results along with it — a single
 * Promise.all across all wallets would reject the whole computation on one bad wallet, exactly the
 * "one try wrapping the whole loop" failure mode that file's own comment describes hitting live.
 *
 * Returns:
 *   portfolio: { components, score, tier } -- pooled across every wallet that succeeded
 *   perWallet: [{ walletAddress, components, score, tier }] -- only successful wallets
 *   perAsset: [{ tokenAddress, type, components, score, tier }] -- combined across successful
 *     wallets, one row per DISTINCT ASSET that has any lot or disposal in scope: native ETN
 *     (type "native", keyed as "NATIVE" — matches pnlEventBuilder.js's own convention), a fungible
 *     token (type "token"), a V3 liquidity position (type "lp", one row per position — never
 *     grouped, same as elsewhere in this app), or an NFT collection (type "nft", `tokenAddress` is
 *     the COLLECTION address — every tokenId ever held/sold in that collection is pooled into this
 *     one row, see classifyAssetKey's own comment on why)
 *   failed: [walletAddress, ...] -- any wallet whose ledger fetch itself failed, so the frontend
 *     can show which one(s) didn't load rather than silently under-reporting the combined totals
 */
export async function computeDiamondHandsScore(trackedWallets) {
  const failed = [];
  const ledgerResults = await Promise.all(
    trackedWallets.map(async (addr) => {
      const selfOwned = trackedWallets.filter((a) => a !== addr);
      try {
        return { walletAddress: addr, ...(await getWalletLedgerState(addr, selfOwned)) };
      } catch (err) {
        console.error(`Diamond Hands ledger fetch failed for wallet ${addr}:`, err);
        failed.push(addr);
        return null;
      }
    })
  );
  const perWalletLedger = ledgerResults.filter(Boolean);
  const now = perWalletLedger[0]?.now ?? new Date();

  const pooledLots = perWalletLedger.flatMap((w) => w.lots);
  const pooledEvents = perWalletLedger.flatMap((w) => w.realizedEvents);

  const portfolioComponents = await computeComponentsForScope(pooledLots, pooledEvents, null, now);
  const portfolioScoring = scoreFromComponents(portfolioComponents);

  const perWallet = await Promise.all(
    perWalletLedger.map(async ({ walletAddress, lots, realizedEvents }) => {
      const components = await computeComponentsForScope(lots, realizedEvents, null, now);
      const scoring = scoreFromComponents(components);
      return { walletAddress, components, ...scoring };
    })
  );

  const allTokenAddresses = [...new Set([...pooledLots.map((l) => l.tokenAddress), ...pooledEvents.map((e) => e.tokenAddress)])];
  const assetGroups = new Map(); // groupKey -> { type, memberKeys: Set<realTokenAddress> }
  for (const tokenAddress of allTokenAddresses) {
    const { type, groupKey } = classifyAssetKey(tokenAddress);
    if (!assetGroups.has(groupKey)) assetGroups.set(groupKey, { type, memberKeys: new Set() });
    assetGroups.get(groupKey).memberKeys.add(tokenAddress);
  }
  const perAsset = await Promise.all(
    [...assetGroups.entries()].map(async ([groupKey, { type, memberKeys }]) => {
      const components = await computeComponentsForScope(pooledLots, pooledEvents, memberKeys, now);
      const scoring = scoreFromComponents(components);
      return { tokenAddress: groupKey, type, components, ...scoring };
    })
  );
  // Largest-position-first is the natural default sort for a drill-down list — same "biggest
  // holdings first" convention CoreTierPortfolio.jsx's own token list already uses.
  perAsset.sort((a, b) => Number(b.components.totalAcquiredUsd) - Number(a.components.totalAcquiredUsd));

  return {
    asOf: now,
    portfolio: { components: portfolioComponents, ...portfolioScoring },
    perWallet,
    perAsset,
    failed,
  };
}
