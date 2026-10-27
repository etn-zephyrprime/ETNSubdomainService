// backend/services/etnCatchupStrategy.js
//
// Pure decision logic for the ETN accumulator bot's fourth mode: KuCoin catch-up. ElectroSwap's pools
// only reprice when someone trades on them, so when ETN moves on the big exchanges they can sit well
// behind for minutes or hours (Oct 2026: +6.7% on KuCoin while ElectroSwap stayed flat for 8h+). When
// ElectroSwap's ETN price is at least `lagPct` BELOW KuCoin's, this buys ETN on ElectroSwap with a
// clip of the mode's own stablecoin pot, opening a lot { stable, usd, etn }. When ElectroSwap has
// caught up enough that selling back FEWER ETN restores the lot's dollars (by at least `minGainPct`),
// it sells just that much and keeps the rest — every closed lot ends with more ETN, never less.
//
// Unlike the triangles this is NOT risk-free: it bets that ElectroSwap catches up. If KuCoin falls
// back instead, the lot just stays open (holding ETN instead of dollars) until ElectroSwap rises
// enough — so the pot's cash can be tied up. Only the buy-first side is implemented; selling first on
// a premium is the existing sell/buyback strategy's job.
//
// Backtest (Sep–Oct 2026, 42.8 days of KuCoin 1-minute closes against both USD pools' swap history,
// no own price impact, open lots valued at the end): lag >= 4%, $50 clips, 15-minute re-entry, $143
// pot -> +53.5k ETN net (85 round trips); lag >= 3% (the default) -> +31.8k (59) — fewer ETN in the
// backtest, but it acts earlier in each lag, which counts once faster traders compete for it. ElectroSwap was >= 3% below KuCoin
// 9.1% of minutes.

export const CATCHUP_DEFAULTS = {
  potUsd: 100, // stablecoin the mode may use (claimed from new USDT/USDC sent to the wallet)
  lagPct: 3, // buy when ElectroSwap's mid is at least this far below KuCoin's (the owner's pick: faster traders
  // close bigger lags first, so act at 3% rather than wait for 4%)
  clipUsd: 50,
  minGainPct: 1, // close when the dollars come back for at least this much less ETN
  reentryMinutes: 15, // at most one new buy per this many minutes
  maxSpreadPct: 2, // ignore KuCoin's price when its bid/ask spread is wider than this (thin book)
};

export function freshCatchupBook(potUsd = 0) {
  return { target: potUsd, cash: { USDT: 0, USDC: 0 }, lots: [], nextId: 1, gainEtn: 0, closed: 0, lastBuyAt: null, recent: [] };
}

/** KuCoin's mid from its level-1 book, or null when it isn't usable (missing, crossed, or too wide). */
export function kucoinMid({ bestBid, bestAsk } = {}, maxSpreadPct = CATCHUP_DEFAULTS.maxSpreadPct) {
  const bid = Number(bestBid), ask = Number(bestAsk);
  if (!(bid > 0) || !(ask >= bid)) return null;
  const mid = (bid + ask) / 2;
  return ((ask - bid) / mid) * 100 > maxSpreadPct ? null : mid;
}

/** How far each pool's ETN price is from KuCoin's, in % (negative = ElectroSwap cheaper). */
export function lagsPct(mids, kMid) {
  return Object.fromEntries(Object.entries(mids).map(([k, m]) => [k, (m / kMid - 1) * 100]));
}

/**
 * A buy to open, or null. The cheapest pool whose stablecoin the pot has a full clip of, if its lag
 * is at least lagPct and the last buy was at least reentryMinutes ago.
 */
export function decideCatchupBuy(book, lags, cfg = CATCHUP_DEFAULTS, nowMs = Date.now()) {
  if (book.lastBuyAt && nowMs - Date.parse(book.lastBuyAt) < cfg.reentryMinutes * 60000) return null;
  const candidates = Object.entries(lags)
    .filter(([k, lag]) => lag <= -cfg.lagPct && (book.cash[k] || 0) >= cfg.clipUsd)
    .sort((a, b) => a[1] - b[1]);
  if (!candidates.length) return null;
  const [stable, lagPct] = candidates[0];
  return { stable, usd: cfg.clipUsd, lagPct };
}

/** The open lot to close, or null: needEtn[lotId] = ETN it would take now to get the lot's dollars back. */
export function decideCatchupClose(book, needEtn, cfg = CATCHUP_DEFAULTS) {
  let best = null;
  for (const lot of book.lots) {
    const need = needEtn[lot.id];
    if (!(need > 0)) continue;
    const keep = lot.etn - need;
    if (keep >= (lot.etn * cfg.minGainPct) / 100 && (!best || keep > best.keepEtn)) best = { lotId: lot.id, stable: lot.stable, usd: lot.usd, needEtn: need, keepEtn: keep };
  }
  return best;
}

/** A filled buy: the clip leaves the pot's cash, a lot opens. */
export function applyCatchupBuy(book, { stable, usdSpent, etnBought, at = null, txHash = null, lagPct = null }) {
  book.cash[stable] = (book.cash[stable] || 0) - usdSpent;
  book.lots.push({ id: book.nextId++, stable, usd: usdSpent, etn: etnBought, openedAt: at, txHash, lagPct });
  book.lastBuyAt = at;
  return book;
}

/** A filled close: the ETN sold restores (about) the lot's dollars; whatever ETN is left is the gain. */
export function applyCatchupClose(book, lotId, { etnSold, usdReceived, at = null, txHash = null }) {
  const i = book.lots.findIndex((l) => l.id === lotId);
  if (i < 0) throw new Error(`Unknown catch-up lot ${lotId}`);
  const [lot] = book.lots.splice(i, 1);
  book.cash[lot.stable] = (book.cash[lot.stable] || 0) + usdReceived;
  book.gainEtn += lot.etn - etnSold;
  book.closed += 1;
  book.recent.push({ id: lot.id, stable: lot.stable, usd: lot.usd, etnBought: lot.etn, etnSold, usdReceived, gainEtn: lot.etn - etnSold, openedAt: lot.openedAt, closedAt: at });
  if (book.recent.length > 50) book.recent.shift();
  return book;
}

/** Adds stablecoin to the pot (a deposit claimed by splitDeposit, or the virtual pot in paper mode). */
export function applyCatchupFunding(book, stable, usd) {
  book.cash[stable] = (book.cash[stable] || 0) + usd;
  book.funded = (book.funded || 0) + usd;
  return book;
}

/** Splits a stablecoin surplus found in the wallet: the catch-up pot is filled up to its target
 * first (it's funded from new deposits), the rest is returned for the gap book. */
export function splitDeposit(book, stable, usd) {
  if (!(usd > 0) || !book) return { toCatchup: 0, rest: usd };
  const fundedSoFar = (book.funded || 0);
  const room = Math.max(0, (book.target || 0) - fundedSoFar);
  const toCatchup = Math.min(room, usd);
  return { toCatchup, rest: usd - toCatchup };
}
