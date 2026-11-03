// backend/services/cexArbStrategy.js
//
// Pure logic for trading ETN across centralised exchanges (KuCoin, HTX — see services/cexVenues.js):
//   - the CEX-vs-CEX arbitrage: buy where ETN is cheap, sell where it's dear, both at once
//   - the second leg of ANY two-venue trade (this one, and the ElectroSwap hedge): sized and priced so
//     the pair can't lose money — a break-even price cap on an IOC limit order
//   - the checks that must ALL pass before a first leg is placed
// No I/O here; tests/cexArbStrategy.test.js.
//
// Why IOC limit orders, never market orders: an IOC ("immediate or cancel") fills whatever it can at the
// given price or better and cancels the rest, so a thin or moving book can never fill it at a worse
// price than planned. A partial fill is fine — the other leg is sized to what actually filled.

export const ARB_DEFAULTS = {
  minEdgePct: 0.4, // profit after both venues' fees, as % of the dollars traded
  minProfitUsd: 0.1,
  sizesUsd: [45, 90], // HTX's book is thin (~$1.8k in its top 20 bids) — keep trades small
  maxGapPct: 5, // a bigger gap between venues is treated as bad data, not an opportunity
  maxSpreadPct: 2, // either venue's own bid/ask spread wider than this: don't trade there
  maxBookAgeMs: 5000, // an order book older than this when it's used: don't trade on it
  minIntervalMs: 30000, // between two arbitrage trades
  maxTradesPerDay: 40,
  maxUsdPerDay: 2000,
  maxRecentLossEtn: 2000, // pause if the last 10 trades together lost more than this
};

const round = (x, step, dir) => {
  if (!(step > 0)) return x;
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  const n = dir === "up" ? Math.ceil(x / step - 1e-9) : Math.floor(x / step + 1e-9);
  return Number((n * step).toFixed(decimals));
};
export const roundDown = (x, step) => round(x, step, "down");
export const roundUp = (x, step) => round(x, step, "up");

/** Walks one side of a book for `etn`: { usd, worstPrice } or null if it isn't deep enough. levels best first. */
export function walk(levels, etn) {
  let left = etn, usd = 0, worstPrice = null;
  for (const [p, s] of levels || []) {
    const price = Number(p), size = Number(s);
    if (!(price > 0) || !(size > 0)) continue;
    const take = Math.min(left, size);
    usd += take * price;
    worstPrice = price;
    left -= take;
    if (left <= 1e-9) return { usd, worstPrice };
  }
  return null;
}

export const midOf = (book) => (Number(book.bids[0][0]) + Number(book.asks[0][0])) / 2;
export const spreadPctOf = (book) => (Number(book.asks[0][0]) / Number(book.bids[0][0]) - 1) * 100;

/**
 * The best CEX-vs-CEX trade, or null. books: { [venue]: { bids, asks } }; fees: { [venue]: taker % }.
 * For every ordered pair (buy on one, sell on the other) and size: buy `etn` on the cheap venue's asks and
 * sell it into the dear venue's bids. Returns { buyVenue, sellVenue, etn, buyUsd, sellUsd, buyLimit,
 * sellLimit, profitUsd, edgePct } — buyLimit/sellLimit being the worst price each side needs.
 */
export function planArb(books, fees, cfg = ARB_DEFAULTS) {
  const venues = Object.keys(books);
  let best = null;
  for (const buyVenue of venues) for (const sellVenue of venues) {
    if (buyVenue === sellVenue) continue;
    const lo = books[buyVenue], hi = books[sellVenue];
    for (const usd of cfg.sizesUsd) {
      const etn = Math.floor(usd / Number(lo.asks[0][0]));
      const b = walk(lo.asks, etn), s = walk(hi.bids, etn);
      if (!b || !s) continue;
      const cost = b.usd * (1 + fees[buyVenue] / 100);
      const proceeds = s.usd * (1 - fees[sellVenue] / 100);
      const profitUsd = proceeds - cost;
      const edgePct = (profitUsd / cost) * 100;
      if (edgePct >= cfg.minEdgePct && profitUsd >= cfg.minProfitUsd && (!best || profitUsd > best.profitUsd)) {
        best = { buyVenue, sellVenue, etn, buyUsd: b.usd, sellUsd: s.usd, buyLimit: b.worstPrice, sellLimit: s.worstPrice, profitUsd, edgePct };
      }
    }
  }
  return best;
}

/**
 * Every reason NOT to place an arbitrage's first leg right now ([] = all clear). ctx:
 *   plan, books (with ts), nowMs, status { [venue]: { trading, etn: {deposit, withdraw}, usdt: {deposit, withdraw} } },
 *   balances { [venue]: { ETN, USDT } }, book (the arb book: lastTradeAt, today {trades, usd}, recent[]),
 *   paused (reason or null)
 */
export function arbChecks({ plan, books, nowMs, status, balances, book, paused = null }, cfg = ARB_DEFAULTS) {
  const out = [];
  if (paused) out.push(`paused: ${paused}`);
  for (const v of [plan.buyVenue, plan.sellVenue]) {
    const bk = books[v];
    if (!bk?.ts || nowMs - bk.ts > cfg.maxBookAgeMs) out.push(`${v} order book is stale`);
    if (bk && spreadPctOf(bk) > cfg.maxSpreadPct) out.push(`${v} spread ${spreadPctOf(bk).toFixed(2)}% is too wide`);
    const st = status?.[v];
    if (!st?.trading) out.push(`${v} ETN-USDT isn't trading`);
    // A one-sided premium often means one venue can't take deposits or withdrawals — trading into it would
    // strand the inventory there. Both assets must be movable both ways on both venues.
    for (const a of ["etn", "usdt"]) if (!st?.[a]?.deposit || !st?.[a]?.withdraw) out.push(`${v} ${a.toUpperCase()} deposits/withdrawals aren't both open`);
  }
  const gapPct = Math.abs(midOf(books[plan.sellVenue]) / midOf(books[plan.buyVenue]) - 1) * 100;
  if (gapPct > cfg.maxGapPct) out.push(`${gapPct.toFixed(1)}% between venues looks like bad data`);
  if (plan.edgePct < cfg.minEdgePct) out.push(`edge ${plan.edgePct.toFixed(2)}% below ${cfg.minEdgePct}%`);
  const head = 1.02;
  if (!(balances?.[plan.buyVenue]?.USDT >= plan.buyUsd * head)) out.push(`${plan.buyVenue} USDT ${(balances?.[plan.buyVenue]?.USDT ?? 0).toFixed(2)} short of ${(plan.buyUsd * head).toFixed(2)}`);
  if (!(balances?.[plan.sellVenue]?.ETN >= plan.etn * head)) out.push(`${plan.sellVenue} ETN ${Math.round(balances?.[plan.sellVenue]?.ETN ?? 0)} short of ${Math.round(plan.etn * head)}`);
  if (book?.lastTradeAt && nowMs - Date.parse(book.lastTradeAt) < cfg.minIntervalMs) out.push("too soon after the last trade");
  const today = book?.today || {};
  if ((today.trades || 0) >= cfg.maxTradesPerDay) out.push("daily trade limit reached");
  if ((today.usd || 0) + plan.buyUsd > cfg.maxUsdPerDay) out.push("daily volume limit reached");
  const recentLoss = (book?.recent || []).slice(-10).reduce((s, r) => s + Math.min(0, r.gainEtn || 0), 0);
  if (-recentLoss > cfg.maxRecentLossEtn) out.push(`recent trades lost ${Math.round(-recentLoss)} ETN`);
  return out;
}

/**
 * The second leg when it BUYS ETN: spend up to `budgetUsd` (after fee) so that at least `breakEvenEtn` ETN
 * comes back. Price capped at break-even (budget / (breakEvenEtn × fee)) and at the worst ask actually
 * needed; size = what the budget buys at that limit — so whatever fills costs no more than the budget and
 * every ETN costs no more than break-even. Returns { size, price } or null (book too thin / below minimums).
 */
export function buyLegOrder({ asks, budgetUsd, breakEvenEtn, feePct, rules }) {
  const fee = 1 + feePct / 100;
  const cap = budgetUsd / (fee * breakEvenEtn);
  const estSize = budgetUsd / (fee * Number(asks[0][0]));
  const w = walk(asks, estSize);
  const price = roundDown(Math.min(cap, w ? w.worstPrice : cap), rules.priceStep);
  if (!(price > 0)) return null;
  const size = roundDown(budgetUsd / (fee * price), rules.sizeStep);
  if (size < rules.minSize || size * price < rules.minFunds) return null;
  return { size, price };
}

/**
 * The second leg when it SELLS ETN: get `targetUsd` back (after fee) from at most `availableEtn`. Price
 * floored at break-even (target / (available × fee)) and at the worst bid actually needed; size = what
 * reaches the target at that floor — so whatever fills sells no ETN below break-even. Returns
 * { size, price } or null.
 */
export function sellLegOrder({ bids, targetUsd, availableEtn, feePct, rules }) {
  const fee = 1 - feePct / 100;
  const floor = targetUsd / (fee * availableEtn);
  const estSize = targetUsd / (fee * Number(bids[0][0]));
  const w = walk(bids, estSize);
  const price = roundUp(Math.max(floor, w ? w.worstPrice : floor), rules.priceStep);
  const size = Math.min(roundDown(availableEtn, rules.sizeStep), roundUp(targetUsd / (fee * price), rules.sizeStep));
  if (size < rules.minSize || size * price < rules.minFunds) return null;
  return { size, price };
}

/** A fill in net terms: { etn, usd } the venue actually moved (fees taken in whichever asset the venue
 * charges them in — KuCoin always USDT; HTX ETN on buys, USDT on sells). */
export function netFill(side, fill) {
  const feeEtn = fill.feeCurrency === "ETN" ? fill.fee : 0;
  const feeUsd = fill.feeCurrency === "USDT" ? fill.fee : 0;
  return side === "buy" ? { etn: fill.dealSize - feeEtn, usd: fill.dealFunds + feeUsd } : { etn: fill.dealSize + feeEtn, usd: fill.dealFunds - feeUsd };
}

export function freshArbBook() {
  return { trades: 0, gainEtn: 0, gainUsd: 0, notionalUsd: 0, today: { day: null, trades: 0, usd: 0 }, lastTradeAt: null, paused: null, failures: 0, recent: [], since: new Date().toISOString() };
}
