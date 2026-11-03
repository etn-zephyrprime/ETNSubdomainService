// backend/services/etnHedgeStrategy.js
//
// PAPER ONLY (for now): the hedged version of the KuCoin catch-up trade — what the wallet 0xA7d1…073C
// does (Nov 2026: 54 sells, ~$4.8k, avg +3.2% vs KuCoin, USDC bridged back after each). When
// ElectroSwap's ETN price is far enough ABOVE KuCoin's, sell ETN on ElectroSwap and, at the same moment,
// buy the same ETN back on KuCoin; when it's far enough BELOW, the reverse. The profit is fixed at
// once — nothing is left open waiting for ElectroSwap to come back (the catch-up mode's weakness in a
// rally). The cost is inventory on both sides that drifts and has to be moved back now and then (a
// KuCoin ETN withdrawal one way, a USDC bridge the other).
//
// This file is the pure part: filling a size against KuCoin's real order book, and picking the most
// profitable hedge. The bot logs what each would have made, with real ElectroSwap quotes and KuCoin's
// live book — no orders anywhere — so the owner can judge whether funding KuCoin and an API key is
// worth it. Pure, unit-tested (tests/etnHedgeStrategy.test.js).

export const HEDGE_DEFAULTS = {
  lagPct: 1.5, // look for a hedge once a pool is this far from KuCoin's mid (where 073C trades from)
  sizesUsd: [45, 90, 180, 360], // notionals tried; the most profitable wins
  kucoinFeePct: 0.1, // KuCoin spot taker fee (0.1% default tier; less with KCS)
  minProfitPct: 0.3, // after both venues' fees and impact
  minProfitUsd: 0.1,
};

/**
 * Fills `etn` against one side of KuCoin's book. side "buy" takes the asks (what buying that ETN
 * costs), "sell" hits the bids (what selling it brings). levels: [[price, size], ...] best first.
 * Returns { usd, avgPrice } or null if the book shown isn't deep enough.
 */
export function kucoinFill(levels, etn, side) {
  let left = etn;
  let usd = 0;
  for (const [p, s] of levels || []) {
    const price = Number(p), size = Number(s);
    if (!(price > 0) || !(size > 0)) continue;
    const take = Math.min(left, size);
    usd += take * price;
    left -= take;
    if (left <= 1e-9) break;
  }
  if (left > 1e-9) return null;
  return { usd, avgPrice: usd / etn, side };
}

/**
 * The best hedge, or null. candidates:
 *  { dir: "sellOnEs", stable, etn, esUsd, kcUsd } — sell etn on ElectroSwap for esUsd, buy it on KuCoin for kcUsd (before fee)
 *  { dir: "buyOnEs",  stable, usd, etn, kcUsd }   — spend usd on ElectroSwap for etn, sell it on KuCoin for kcUsd (before fee)
 * Profit is in dollars; the ETN on each side nets to zero.
 */
export function decideHedge(candidates, cfg = HEDGE_DEFAULTS) {
  const fee = cfg.kucoinFeePct / 100;
  let best = null;
  for (const c of candidates) {
    let profitUsd, notional;
    if (c.dir === "sellOnEs") {
      if (!(c.esUsd > 0) || !(c.kcUsd > 0)) continue;
      profitUsd = c.esUsd - c.kcUsd * (1 + fee);
      notional = c.esUsd;
    } else {
      if (!(c.usd > 0) || !(c.kcUsd > 0)) continue;
      profitUsd = c.kcUsd * (1 - fee) - c.usd;
      notional = c.usd;
    }
    const profitPct = (profitUsd / notional) * 100;
    if (profitPct >= cfg.minProfitPct && profitUsd >= cfg.minProfitUsd && (!best || profitUsd > best.profitUsd)) best = { ...c, profitUsd, profitPct, notional };
  }
  return best;
}

export function freshHedgeBook() {
  return { trades: 0, profitUsd: 0, profitEtn: 0, notionalUsd: 0, drift: { etnToWallet: 0, usdToKucoin: 0 }, recent: [], since: new Date().toISOString() };
}

/**
 * Records a (paper) hedge. `kucoinPrice` turns the dollar profit into ETN for the headline. drift
 * tracks what rebalancing would have to move: selling on ElectroSwap leaves ETN piling up on KuCoin
 * and dollars in the wallet (positive etnToWallet / usdToKucoin = move that much back); buying on
 * ElectroSwap does the opposite.
 */
export function applyHedge(book, h, { kucoinPrice, at = null } = {}) {
  book.trades += 1;
  book.profitUsd += h.profitUsd;
  book.profitEtn += kucoinPrice > 0 ? h.profitUsd / kucoinPrice : 0;
  book.notionalUsd += h.notional;
  const sign = h.dir === "sellOnEs" ? 1 : -1;
  book.drift.etnToWallet += sign * h.etn;
  book.drift.usdToKucoin += sign * h.notional;
  book.recent.push({ at, dir: h.dir, stable: h.stable, etn: h.etn, notional: h.notional, profitUsd: h.profitUsd, profitPct: h.profitPct, lagPct: h.lagPct ?? null });
  if (book.recent.length > 50) book.recent.shift();
  return book;
}
