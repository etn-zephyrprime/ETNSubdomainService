// backend/services/pnlPositionValuation.js
//
// Puts liquidity and staking/farm positions into the live PnL snapshot's "Current Value".
//
// Why they were missing: the FIFO ledger already tracks these positions with real cost basis — a V2
// LP token and a V3 position are ordinary lots (keyed by the pair address / `positionManager:tokenId`),
// and funds locked in a farm or stake sit in a separate locked queue (see fifoLotEngine.js's
// lock()/unlock()). But valueInventoryAtTimestamp prices a lot via a market price feed, and nothing
// prices an LP token or a position, so those lots contributed $0 to Current Value (and their locked
// counterparts weren't in the snapshot at all). Meanwhile lpPositionValuation.js and
// defiPositionValuation.js already value the same positions correctly from live on-chain state — what
// the Portfolio panel shows. This module bridges the two, so PnL keeps the ledger's cost basis (which
// is what makes Unrealized P&L meaningful) but values the position at its live worth.
//
//  - V2 LP token / V3 position (open lots): expressed as a per-unit live price for that lot key, fed
//    into valueInventoryAtTimestamp's `livePricesUsd` exactly like a token price.
//  - Farm / stake principal (locked lots): valued per underlying token from the position legs
//    (`combineLockedPositionValue`), since defiPositionValuation reports legs by token.
import Decimal from "decimal.js";
import { ethers } from "ethers";
// computeLpPositionsLive, not the cached getLiquidityPositionsUsd — this file's own candidate list
// (below) is derived from the FIFO ledger's open lots, a genuinely different basis than the live
// Blockscout-balance candidates the Portfolio page's own router builds. Sharing a cache between the
// two was a confirmed real bug (intermittently zeroed the Portfolio page's own Liquidity Positions
// figure) — see computeLpPositionsLive's own export comment in lpPositionValuation.js.
import { computeLpPositionsLive } from "./lpPositionValuation.js";
import { getOpenDefiPositionsUsd } from "./defiPositionValuation.js";
import { POSITION_MANAGER_ADDRESS } from "./pnlIngestion.js";

const NATIVE = "NATIVE";

/** For ONE token's locked (farm/stake) principal: the ledger's view (`lockedQuantity`,
 * `lockedCostUsd` — from the locked lot queue) against the live position legs' view
 * (`positionAmount`, `positionValueUsd`). Returns the quantity/cost/value to add to that token's row.
 *
 *  - value is always the live position value — that's the point.
 *  - cost basis comes from the ledger where it has it. Where the live position is BIGGER than what the
 *    ledger saw locked (history incomplete, e.g. ingestion began mid-position), the uncovered part is
 *    given cost = its own current value, i.e. zero unrealized — the same "acquire at today's price"
 *    fallback fifoLotEngine.unlock() already uses for a shortfall — rather than booking the whole
 *    unexplained amount as profit. Where the ledger locked MORE than the live position holds (stale
 *    lock), the ledger cost is scaled down to the live amount so cost never exceeds what's held.
 * Returns null when there's nothing live to value. */
export function combineLockedPositionValue({ lockedQuantity, lockedCostUsd, positionAmount, positionValueUsd }) {
  const amount = new Decimal(positionAmount);
  const value = new Decimal(positionValueUsd);
  if (amount.lte(0) || value.lte(0)) return null;

  const ledgerQty = new Decimal(lockedQuantity);
  const ledgerCost = new Decimal(lockedCostUsd);
  const unitValue = value.div(amount);

  let cost;
  if (ledgerQty.lte(0)) {
    cost = value; // ledger never saw this locked — no basis to claim, so no gain to claim either
  } else if (ledgerQty.gte(amount)) {
    cost = ledgerCost.times(amount.div(ledgerQty)); // cap to what's actually held
  } else {
    cost = ledgerCost.plus(amount.minus(ledgerQty).times(unitValue)); // ledger-covered part at its cost, the rest at today's value
  }
  return { quantity: amount, costBasisUsd: cost, marketValueUsd: value };
}

/** Live valuation inputs for `trackedWallet`'s positions, matched against its ledger.
 *  `openLots`   — closing.lots (freely-held lots; includes LP-token and V3-position lots)
 *  `lockedLots` — closing.lockedLots (farm/stake principal)
 * Returns { livePricesUsd, lockedByToken }:
 *  - livePricesUsd: `{ [lot key]: usd per unit }` for every LP token / V3 position it could value
 *  - lockedByToken: Map(tokenAddress -> { quantity, costBasisUsd, marketValueUsd }) to add on top of
 *    the open-lot valuation.
 * Never throws: any lookup failure just means that piece is left out (logged), which is exactly the
 * pre-existing behavior for it. */
export async function computeLivePositionValuation(trackedWallet, openLots, lockedLots) {
  const livePricesUsd = {};
  const lockedByToken = new Map();

  // ---- open lots: V2 LP tokens + V3 positions ----
  try {
    const qtyByKey = new Map();
    for (const lot of openLots) {
      if (lot.quantityRemaining.lte(0)) continue;
      qtyByKey.set(lot.tokenAddress, (qtyByKey.get(lot.tokenAddress) || new Decimal(0)).plus(lot.quantityRemaining));
    }

    // Every plain fungible key is a candidate LP token; resolveV2LpCandidate probes each and drops
    // anything that isn't an ElectroSwap pair, so over-inclusion only costs a probe. LP tokens are
    // always 18 decimals.
    const candidates = [];
    for (const [key, qty] of qtyByKey) {
      if (key === NATIVE || key.includes(":")) continue;
      candidates.push({ address: key, decimals: 18, rawBalance: ethers.parseUnits(qty.toFixed(18), 18).toString() });
    }

    const lp = await computeLpPositionsLive(trackedWallet, candidates);
    for (const p of lp.v2Positions) {
      const key = String(p.tokenAddress).toLowerCase();
      const qty = qtyByKey.get(key);
      if (p.totalUsd == null || p.hasUnpriced || !qty || qty.lte(0)) continue;
      // Per-unit price of the pair token, from the position valued at the SAME quantity the ledger holds.
      livePricesUsd[key] = new Decimal(p.totalUsd).div(qty).toNumber();
    }
    for (const p of lp.v3Positions) {
      const key = `${POSITION_MANAGER_ADDRESS}:${p.tokenId}`;
      const qty = qtyByKey.get(key);
      if (p.totalUsd == null || p.hasUnpriced || !qty || qty.lte(0)) continue;
      livePricesUsd[key] = new Decimal(p.totalUsd).div(qty).toNumber();
    }
  } catch (err) {
    console.warn(`⚠️  PnL position valuation: liquidity positions skipped for ${trackedWallet}:`, err.message);
  }

  // ---- locked lots: farm / stake principal ----
  try {
    const locked = new Map(); // token -> { quantity, cost }
    for (const lot of lockedLots) {
      if (lot.quantityRemaining.lte(0)) continue;
      const agg = locked.get(lot.tokenAddress) || { quantity: new Decimal(0), cost: new Decimal(0) };
      agg.quantity = agg.quantity.plus(lot.quantityRemaining);
      agg.cost = agg.cost.plus(lot.quantityRemaining.times(lot.unitCostUsd));
      locked.set(lot.tokenAddress, agg);
    }

    const defi = await getOpenDefiPositionsUsd(trackedWallet);
    const live = new Map(); // token -> { amount, value }
    for (const position of defi.positions || []) {
      for (const leg of position.legs || []) {
        if (!leg.tokenAddress || leg.usdValue == null) continue; // an unpriced leg is left out, same convention as elsewhere
        const key = String(leg.tokenAddress).toLowerCase();
        const agg = live.get(key) || { amount: new Decimal(0), value: new Decimal(0) };
        agg.amount = agg.amount.plus(leg.amount);
        agg.value = agg.value.plus(leg.usdValue);
        live.set(key, agg);
      }
    }

    for (const [token, l] of live) {
      const ledger = locked.get(token) || { quantity: new Decimal(0), cost: new Decimal(0) };
      const combined = combineLockedPositionValue({
        lockedQuantity: ledger.quantity,
        lockedCostUsd: ledger.cost,
        positionAmount: l.amount,
        positionValueUsd: l.value,
      });
      if (combined) lockedByToken.set(token, combined);
    }
  } catch (err) {
    console.warn(`⚠️  PnL position valuation: farm/staking positions skipped for ${trackedWallet}:`, err.message);
  }

  return { livePricesUsd, lockedByToken };
}

/** Folds `lockedByToken` (from computeLivePositionValuation) into a valueInventoryAtTimestamp
 * result: each locked token's quantity/cost/value is added to that token's existing row (or becomes
 * its own row), and the totals move by the same amounts, so Current Value and Unrealized P&L stay
 * consistent with the holdings list. Pure — returns a new result. */
export function addLockedPositionsToValuation(valuation, lockedByToken) {
  if (lockedByToken.size === 0) return valuation;
  const perToken = valuation.perToken.map((r) => ({ ...r }));
  let totalMarketValueUsd = valuation.totalMarketValueUsd;
  let totalUnrealizedUsd = valuation.totalUnrealizedUsd;

  for (const [token, locked] of lockedByToken) {
    const existing = perToken.find((r) => r.tokenAddress === token);
    if (existing) {
      existing.quantity = new Decimal(existing.quantity).plus(locked.quantity).toString();
      existing.costBasisUsd = new Decimal(existing.costBasisUsd).plus(locked.costBasisUsd).toString();
      // A free-held part with no resolved price leaves the row's own value null, but the locked part
      // is still real value — start the row from 0 rather than dropping it.
      existing.marketValueUsd = new Decimal(existing.marketValueUsd ?? 0).plus(locked.marketValueUsd).toString();
    } else {
      perToken.push({
        tokenAddress: token,
        quantity: locked.quantity.toString(),
        costBasisUsd: locked.costBasisUsd.toString(),
        marketValueUsd: locked.marketValueUsd.toString(),
      });
    }
    totalMarketValueUsd = totalMarketValueUsd.plus(locked.marketValueUsd);
    totalUnrealizedUsd = totalUnrealizedUsd.plus(locked.marketValueUsd.minus(locked.costBasisUsd));
  }
  return { totalMarketValueUsd, totalUnrealizedUsd, perToken };
}
