// backend/services/etnAccumulatorStrategy.js
//
// Pure decision logic for the ETN accumulator bot (utils/etnAccumulatorBot.js). No I/O — the bot
// fetches live quotes, hands them here, and executes whatever this returns. Kept separate so the
// rules can be unit-tested (tests/etnAccumulatorStrategy.test.js).
//
// The goal is MORE ETN, not more dollars (the user's own framing, from the Oct 2026 analysis of the
// wallets cycling ETN through ElectroSwap's USDT/ETN and USDC/ETN farm pools: the winners ended each
// sell->buy cycle with 5-12% more ETN). So:
//
//   SELL a fixed clip of ETN into whichever stablecoin pool pays the most, when the price we'd
//   actually get (after the 0.3% fee and price impact — it's a real quote) is a band above a slow
//   moving average of the pools' mid price. Each sale opens a "lot": N ETN out, S stablecoin in.
//
//   BUY A LOT BACK only when its S stablecoin, in that same pool, now buys at least N x (1 + minGain)
//   ETN — again a real quote. So every closed cycle ends with more ETN than it started with; a cycle
//   can never be closed at an ETN loss by the bot. The risk instead is ETN rallying away and the
//   stablecoin staying parked — capped by maxStableFraction (how much of the budget may be sitting
//   in open lots at once) and the sell ladder (each further sale needs a higher price than the
//   highest open one, so a long rally sells a few clips at rising prices rather than the whole stack
//   at the start of it).
//
// One action per tick at most: buybacks first (they lock in ETN), then at most one sale.

export const DEFAULT_CONFIG = {
  clipEtn: 10000, // ETN per sale (~$20 at Oct 2026 prices; ~0.2% price impact in these pools)
  sellBandPct: 3, // sell when the quoted sale price is >= EMA x (1 + 3%)
  sellStepPct: 3, // ...and >= the highest open lot's sale price x (1 + 3%)
  minGainPct: 3, // buy a lot back only for >= 3% more ETN than it sold
  maxStableFraction: 0.5, // at most half the budget (in ETN sold) parked in open lots
  emaHalfLifeHours: 12,
  warmupSamples: 30, // ticks of price history before the first sale
};

/** Exponential moving average with a half-life in wall-clock time, so irregular tick spacing (a
 * restart, a skipped tick) weighs correctly. */
export function updateEma(prevEma, price, dtMs, halfLifeMs) {
  if (prevEma == null || !Number.isFinite(prevEma)) return price;
  if (!(dtMs > 0)) return prevEma;
  const alpha = 1 - Math.pow(2, -dtMs / halfLifeMs);
  return prevEma + alpha * (price - prevEma);
}

/** ETN the bot itself owns: budget minus what's sitting in open lots, plus every cycle's gain —
 * and, with the gap mode on (services/etnGapStrategy.js), plus its gains, minus the ETN sold to seed
 * its stablecoin book and any gap trade's first leg still waiting on its second. */
export function botEtnInventory(state) {
  const openSold = state.lots.filter((l) => l.status === "open").reduce((s, l) => s + l.etnSold, 0);
  const gap = state.gap ? state.gap.gainEtn - state.gap.seedEtn - (state.gapLeg?.etnSold || 0) : 0;
  const triangles = state.tri?.gainEtn || 0; // triangle loops return ETN in the same transaction, so only the gain stays out
  // KuCoin catch-up: its open lots' ETN was bought with the mode's own stablecoin and is held back to
  // close them, so only the closed lots' gain joins the inventory.
  const catchup = state.cu?.gainEtn || 0;
  return state.budgetEtn + state.realizedGainEtn - openSold + gap + triangles + catchup;
}

/**
 * The one action to take this tick, or { action: "hold", reason }.
 *
 * @param state  { budgetEtn, realizedGainEtn, lots: [{ id, status, stable, etnSold, stableAmount, sellPrice }], ema, samples }
 * @param quotes {
 *   sell: [{ stable, stableOut }]          — selling config.clipEtn ETN into each pool
 *   buyback: { [lotId]: etnOut }           — buying each open lot's stableAmount back into ETN, in its pool
 *   walletEtn                              — native ETN the wallet holds right now (minus the gas reserve)
 * }
 */
export function decide(state, quotes, config = DEFAULT_CONFIG) {
  const open = state.lots.filter((l) => l.status === "open");

  // 1. Buybacks — the best qualifying lot by ETN gained.
  let best = null;
  for (const lot of open) {
    const etnOut = quotes.buyback?.[lot.id];
    if (!(etnOut > 0)) continue;
    const gainPct = (etnOut / lot.etnSold - 1) * 100;
    if (gainPct >= config.minGainPct && (!best || gainPct > best.gainPct)) best = { lot, etnOut, gainPct };
  }
  if (best) return { action: "buyback", lotId: best.lot.id, stable: best.lot.stable, stableAmount: best.lot.stableAmount, expectedEtn: best.etnOut, gainPct: best.gainPct };

  // 2. A sale.
  if (state.ema == null || state.samples < config.warmupSamples) return { action: "hold", reason: `warming up (${state.samples}/${config.warmupSamples} price samples)` };
  const inventory = botEtnInventory(state);
  if (inventory < config.clipEtn) return { action: "hold", reason: "bot ETN inventory below one clip" };
  if (quotes.walletEtn != null && quotes.walletEtn < config.clipEtn) return { action: "hold", reason: "wallet ETN balance below one clip" };
  const openSold = open.reduce((s, l) => s + l.etnSold, 0);
  if (openSold + config.clipEtn > config.maxStableFraction * state.budgetEtn) return { action: "hold", reason: "max stablecoin exposure reached" };

  const sale = (quotes.sell || []).filter((q) => q.stableOut > 0).reduce((a, q) => (!a || q.stableOut > a.stableOut ? q : a), null);
  if (!sale) return { action: "hold", reason: "no sale quote" };
  const price = sale.stableOut / config.clipEtn;
  const bandPrice = state.ema * (1 + config.sellBandPct / 100);
  if (price < bandPrice) return { action: "hold", reason: `price ${price.toPrecision(4)} below sell band ${bandPrice.toPrecision(4)}` };
  const highestOpen = open.reduce((m, l) => Math.max(m, l.sellPrice), 0);
  if (highestOpen > 0 && price < highestOpen * (1 + config.sellStepPct / 100)) return { action: "hold", reason: `price ${price.toPrecision(4)} below next ladder step ${(highestOpen * (1 + config.sellStepPct / 100)).toPrecision(4)}` };

  return { action: "sell", stable: sale.stable, etnAmount: config.clipEtn, expectedStable: sale.stableOut, price };
}

/** Applies a filled sale to the state (mutates and returns it). */
export function applySell(state, { id, stable, etnSold, stableAmount, txHash, at }) {
  state.lots.push({ id, status: "open", stable, etnSold, stableAmount, sellPrice: stableAmount / etnSold, sellTx: txHash, openedAt: at });
  return state;
}

/** Applies a filled buyback to the state (mutates and returns it). */
export function applyBuyback(state, lotId, { etnBought, txHash, at }) {
  const lot = state.lots.find((l) => l.id === lotId);
  if (!lot) throw new Error(`Unknown lot ${lotId}`);
  lot.status = "closed";
  lot.etnBought = etnBought;
  lot.buyPrice = lot.stableAmount / etnBought;
  lot.buyTx = txHash;
  lot.closedAt = at;
  state.realizedGainEtn += etnBought - lot.etnSold;
  return state;
}

/** Headline figures: realized gain, plus what the open lots' stablecoin would buy back right now.
 * `gapStablesEtn`: what the gap book's stablecoin would buy in ETN right now (0 without the gap mode). */
export function summarize(state, buybackQuotes = {}, gapStablesEtn = 0) {
  const open = state.lots.filter((l) => l.status === "open");
  const closed = state.lots.filter((l) => l.status === "closed");
  const openEtnSold = open.reduce((s, l) => s + l.etnSold, 0);
  const openBuybackEtn = open.reduce((s, l) => s + (buybackQuotes[l.id] ?? 0), 0);
  const allQuoted = open.every((l) => buybackQuotes[l.id] > 0);
  const etnNow = botEtnInventory(state) + (allQuoted ? openBuybackEtn : openEtnSold) + gapStablesEtn;
  // Everything put in, in ETN: the budget plus any stablecoin topped up into the gap book (at the ETN
  // value it had when it arrived).
  const contributedEtn = state.budgetEtn + (state.gap?.depositEtn || 0);
  return {
    budgetEtn: state.budgetEtn,
    cyclesClosed: closed.length,
    lotsOpen: open.length,
    realizedGainEtn: state.realizedGainEtn,
    openEtnSold,
    openBuybackEtn: allQuoted ? openBuybackEtn : null,
    gapTrades: state.gap?.trades || 0,
    gapGainEtn: state.gap?.gainEtn || 0,
    gapSeedEtn: state.gap?.seedEtn || 0,
    triTrades: state.tri?.trades || 0,
    triGainEtn: state.tri?.gainEtn || 0,
    cuClosed: state.cu?.closed || 0,
    cuGainEtn: state.cu?.gainEtn || 0,
    cuOpenLots: state.cu?.lots?.length || 0,
    gapStablesEtn,
    gapDepositsUsd: state.gap?.depositsUsd || {},
    contributedEtn,
    etnEquivalentNow: etnNow,
    vsHoldPct: (etnNow / contributedEtn - 1) * 100,
  };
}
