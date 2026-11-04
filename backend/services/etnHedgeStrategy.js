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
  book.recent.push({ at, venue: h.venue ?? null, dir: h.dir, stable: h.stable, etn: h.etn, notional: h.notional, profitUsd: h.profitUsd, profitPct: h.profitPct, lagPct: h.lagPct ?? null });
  if (book.recent.length > 50) book.recent.shift();
  return book;
}

// ---- live ------------------------------------------------------------------------------------
// Live hedges take their profit in ETN (the owner's yardstick), not dollars:
//   sellOnEs: sell X ETN on ElectroSwap for $D, spend that $D on KuCoin -> Y ETN; gain Y - X ETN
//   buyOnEs:  spend $D on ElectroSwap -> X ETN, sell just enough on KuCoin (Z ETN) to get $D back; gain X - Z
// so the dollars only move between venues (the wallet's hedge stables <-> KuCoin USDT) and come back
// the other way on the opposite hedge.

/** ETN to sell into KuCoin's bids so the proceeds, after the fee, are at least `usd`; null if the book
 * shown isn't deep enough. */
export function etnToSellForUsd(bids, usd, feePct = HEDGE_DEFAULTS.kucoinFeePct) {
  const target = usd / (1 - feePct / 100);
  let got = 0, etn = 0;
  for (const [p, s] of bids || []) {
    const price = Number(p), size = Number(s);
    if (!(price > 0) || !(size > 0)) continue;
    const need = (target - got) / price;
    if (need <= size) return etn + need;
    got += size * price;
    etn += size;
  }
  return null;
}

export function freshLiveHedgeBook() {
  return { trades: 0, gainEtn: 0, notionalUsd: 0, stables: { USDT: 0, USDC: 0 }, walletEtnNet: 0, kucoinEtnNet: 0, kucoinUsdNet: 0, failures: 0, pausedReason: null, recent: [], since: new Date().toISOString() };
}

/**
 * Books a completed live hedge. esEtn/esUsd: the ElectroSwap leg (ETN sold and $ received, or $ spent and
 * ETN bought); kcEtn/kcUsd: the KuCoin leg (ETN bought and $ spent, or ETN sold and $ received, net of fee).
 */
export function applyLiveHedge(book, { dir, stable, esEtn, esUsd, kcEtn, kcUsd, at = null, txHash = null, orderId = null }) {
  const sellOnEs = dir === "sellOnEs";
  const gainEtn = sellOnEs ? kcEtn - esEtn : esEtn - kcEtn;
  book.trades += 1;
  book.gainEtn += gainEtn;
  book.notionalUsd += esUsd;
  book.stables[stable] = (book.stables[stable] || 0) + (sellOnEs ? esUsd : -esUsd); // the wallet's hedge dollars
  book.walletEtnNet += sellOnEs ? -esEtn : esEtn;
  book.kucoinEtnNet += sellOnEs ? kcEtn : -kcEtn;
  book.kucoinUsdNet += sellOnEs ? -kcUsd : kcUsd;
  book.recent.push({ at, dir, stable, esEtn, esUsd, kcEtn, kcUsd, gainEtn, txHash, orderId });
  if (book.recent.length > 50) book.recent.shift();
  return gainEtn;
}

// ---- round trip: keeping both venues stocked ------------------------------------------------------
// Sell-side hedges (the common kind) leave ETN piling up on KuCoin and dollars in the wallet; buy-side
// ones do the reverse. decideRebalance picks at most ONE transfer per check to put them back:
//   sweep*      a deposit that's arrived in KuCoin's MAIN account -> its TRADE account
//   convertUsdc USDC in the TRADE account -> USDT (KuCoin has no ETN-USDC market). Its own step, driven
//               by the trade balance, so a conversion that fails after the sweep is simply retried
//   withdrawEtn KuCoin ETN above etnHigh -> withdraw down to etnTarget, to the bot wallet
//   bridgeUsdc  KuCoin USDT below usdtLow -> the hedge's wallet USDC to KuCoin via Hyperlane to Base
//               (63.6 ETN; KuCoin takes Base USDC with no minimum)
//   bridgeUsdt  the hedge's wallet USDT -> KuCoin via Hyperlane to Ethereum (391 ETN — the only USDT
//               route), only in batches of usdtBatchMin
//   depositEtn  KuCoin ETN below etnLow -> send wallet ETN up to etnTarget (for buy-side hedges)

export const REBALANCE_DEFAULTS = {
  etnHigh: 200000,
  etnTarget: 100000,
  etnLow: 40000,
  usdtLow: 100,
  usdcBatchMin: 40,
  usdtBatchMin: 300,
  minWithdrawEtn: 50000,
};

/** @param kc { trade: {ETN, USDT, USDC}, main: {ETN, USDT, USDC} } — KuCoin balances
 *  @param hb the live hedge book (stables, inTransit[], walletEtnNet)
 *  @param walletEtnRoom how much of the bot's ETN may still go to KuCoin (cap and wallet, combined) */
export function decideRebalance(kc, hb, walletEtnRoom, cfg = REBALANCE_DEFAULTS) {
  const inTransit = (cur) => (hb.inTransit || []).some((t) => t.currency === cur);
  if (kc.main.USDC >= 1) return { type: "sweepUsdc", amount: kc.main.USDC };
  if ((kc.trade.USDC || 0) >= 1) return { type: "convertUsdc", amount: kc.trade.USDC };
  if (kc.main.USDT >= 1) return { type: "sweepUsdt", amount: kc.main.USDT };
  if (kc.main.ETN >= 100) return { type: "sweepEtn", amount: kc.main.ETN };
  if (kc.trade.ETN > cfg.etnHigh) {
    const amount = Math.floor(kc.trade.ETN - cfg.etnTarget);
    if (amount >= cfg.minWithdrawEtn) return { type: "withdrawEtn", amount };
  }
  const usdc = hb.stables?.USDC || 0;
  const usdt = hb.stables?.USDT || 0;
  if (kc.trade.USDT < cfg.usdtLow && usdc >= cfg.usdcBatchMin && !inTransit("USDC")) return { type: "bridgeUsdc", amount: usdc };
  if (usdt >= cfg.usdtBatchMin && !inTransit("USDT")) return { type: "bridgeUsdt", amount: usdt };
  if (kc.trade.ETN < cfg.etnLow && !inTransit("ETN")) {
    const amount = Math.floor(Math.min(cfg.etnTarget - kc.trade.ETN, walletEtnRoom));
    if (amount >= 10000) return { type: "depositEtn", amount };
  }
  return null;
}

/** Clears in-transit entries of `currency` that an arrival of `amount` covers (oldest first). */
export function settleArrival(hb, currency, amount) {
  let left = amount * 1.02; // a little slack: bridge/rounding dust
  hb.inTransit = (hb.inTransit || []).filter((t) => {
    if (t.currency !== currency || left <= 0) return true;
    const size = t.usd ?? t.etn ?? 0;
    if (size <= left) {
      left -= size;
      return false;
    }
    return true;
  });
}

// ---- sweeping excess ETN back to the wallet ---------------------------------------------------------
// ETN gained by hedges and the CEX arbitrage builds up on the exchanges. Each keeps a working float (what
// its trades need on hand) and anything above float + minBatch comes back to the bot wallet — the batch
// minimum keeps a fixed withdrawal fee (KuCoin 308 ETN) a small share of what's moved.
export const SWEEP_DEFAULTS = {
  kucoin: { float: 50000, minBatch: 50000 },
  htx: { float: 100000, minBatch: 10000 },
};

/** How much ETN to withdraw from a venue holding `etn` now (0 = leave it). */
export function sweepAmount(etn, { float, minBatch }, withdrawMin = 0) {
  const excess = Math.floor(etn - float);
  return excess >= Math.max(minBatch, withdrawMin) ? excess : 0;
}

// ---- refilling the exchanges for the CEX arbitrage -------------------------------------------------
// The arbitrage mostly runs one way (HTX is usually the dearer venue): buy ETN on KuCoin with USDT, sell
// it on HTX for USDT. That drains HTX's ETN and KuCoin's USDT. Two cheap transfers put them back:
//   ETN  bot wallet -> HTX     an on-chain send (gas only), when HTX's ETN falls below htxEtnLow — up to
//                              htxEtnTarget (kept under HTX's sweep float, or the sweep sends it straight
//                              back), never leaving the wallet with less than walletKeepEtn + what its open
//                              catch-up lots need
//   USDT HTX -> KuCoin         an HTX withdrawal on BEP20 (0.01 USDT fee), when KuCoin's USDT falls below
//                              kucoinUsdtLow — up to kucoinUsdtTarget, leaving htxUsdtKeep on HTX
// One transfer of each kind in flight at a time. (The third leg — KuCoin's ETN back to the wallet — is
// the sweep, or the withdraw alert while KuCoin's key can't withdraw.)

export const REFILL_DEFAULTS = {
  htxEtnLow: 50000,
  htxEtnTarget: 80000,
  walletKeepEtn: 50000,
  minEtn: 10000,
  kucoinUsdtLow: 100,
  kucoinUsdtTarget: 200,
  htxUsdtKeep: 50,
  minUsdt: 30,
};

/** ETN to send from the wallet to HTX now (0 = none). walletEtn: the wallet's spendable ETN (after the gas
 * reserve); lotEtn: ETN the open catch-up lots will need to sell back; depositMin: HTX's deposit minimum. */
export function decideEtnRefill({ htxEtn, walletEtn, lotEtn = 0, pending = false, depositMin = 0 }, cfg = REFILL_DEFAULTS) {
  if (pending || !(htxEtn < cfg.htxEtnLow)) return 0;
  const spare = walletEtn - cfg.walletKeepEtn - lotEtn;
  const amount = Math.floor(Math.min(cfg.htxEtnTarget - htxEtn, spare) / 100) * 100;
  return amount >= Math.max(cfg.minEtn, depositMin) ? amount : 0;
}

/** USDT to withdraw from HTX to KuCoin now (0 = none), to the cent. kucoinUsdt: KuCoin's USDT (trading +
 * funding accounts); fee/withdrawMin: HTX's rules for the chain. */
export function decideUsdtRefill({ kucoinUsdt, htxUsdt, pending = false, fee = 0, withdrawMin = 0 }, cfg = REFILL_DEFAULTS) {
  if (pending || !(kucoinUsdt < cfg.kucoinUsdtLow)) return 0;
  const spare = htxUsdt - cfg.htxUsdtKeep - fee;
  const amount = Math.floor(Math.min(cfg.kucoinUsdtTarget - kucoinUsdt, spare) * 100 + 1e-6) / 100; // 1e-6: float dust (149.07 - 50 = 99.0699…)
  return amount >= Math.max(cfg.minUsdt, withdrawMin) ? amount : 0;
}
