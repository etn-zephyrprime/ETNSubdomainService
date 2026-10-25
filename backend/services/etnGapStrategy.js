// backend/services/etnGapStrategy.js
//
// Pure decision logic for the ETN accumulator bot's second mode: the USDT-pool vs USDC-pool gap.
// ElectroSwap's WETN/USDT and WETN/USDC pools often price ETN differently (Oct 2026: >= 1.5% apart
// 37% of the time, typical gap 1.2%). A gap trade sells ETN into the pool that pays more, then
// spends exactly the same number of dollars of the OTHER stablecoin buying ETN in the cheaper pool:
//
//   sell  X ETN -> D of the dear pool's stablecoin
//   buy   D of the cheap pool's stablecoin -> E ETN          gain = E - X ETN
//
// The stablecoin total doesn't change (it just shifts from the cheap side to the dear side, both
// counted at $1), so the gain is pure ETN and doesn't depend on which way ETN's price moves. It
// needs stablecoin inventory on both sides — a "gap book" seeded once by selling some ETN into each
// pool — and it pauses on a side that runs dry until the gap flips the other way.
//
// Every figure here is a real quote (fees and price impact included), so `minGainPct` is net.

export const GAP_DEFAULTS = {
  clipEtn: 10000, // largest ETN leg; smaller sizes (1/2, 1/4) are tried too and the best net gain wins
  minGainPct: 1.5, // net ETN gain per trade, after both legs' fees and impact (backtest pick, Oct 2026)
};

// Smallest leg worth a transaction: below this the gain is a handful of ETN.
export const MIN_GAP_LEG_ETN = 500;

/** Candidate leg sizes to quote: the full, half and quarter clip, plus `affordableEtn` — the largest
 * leg the cheap side's stablecoin can pay for — so a nearly drained side still trades with what's
 * left instead of sitting out a gap (Oct 2026: a 3.3% gap went untraded for 3 hours because $5.17 of
 * USDC was just short of the quarter clip). Sizes the book can't pay for are dropped here; decideGap
 * checks the real quotes against the book as well. */
export function gapSizes(clipEtn, affordableEtn = Infinity) {
  const sizes = [clipEtn, clipEtn / 2, clipEtn / 4].filter((s) => s <= affordableEtn);
  if (affordableEtn < clipEtn && affordableEtn >= MIN_GAP_LEG_ETN) sizes.push(Math.floor(affordableEtn));
  return [...new Set(sizes)];
}

/** The largest ETN leg whose sale into the dear pool (at about `dearPriceUsd` per ETN) stays within
 * `cheapStableUsd` — with 3% headroom for fees and price impact going the other way. */
export function affordableLegEtn(cheapStableUsd, dearPriceUsd) {
  if (!(cheapStableUsd > 0) || !(dearPriceUsd > 0)) return 0;
  return (cheapStableUsd * 0.97) / dearPriceUsd;
}

/**
 * The best gap trade, or null.
 * @param book       { stables: { USDT, USDC } } — stablecoin the gap book holds
 * @param candidates [{ dear, cheap, etnIn, stableOut, etnBack }] — sell etnIn into `dear` for
 *                   stableOut; stableOut of `cheap`'s stablecoin buys etnBack ETN
 */
export function decideGap(book, candidates, cfg = GAP_DEFAULTS) {
  let best = null;
  for (const c of candidates) {
    if (!(c.stableOut > 0) || !(c.etnBack > 0)) continue;
    if (c.stableOut > (book.stables[c.cheap] || 0)) continue; // not enough of the stablecoin to buy with
    const gainEtn = c.etnBack - c.etnIn;
    const gainPct = (gainEtn / c.etnIn) * 100;
    if (gainPct >= cfg.minGainPct && (!best || gainEtn > best.gainEtn)) best = { ...c, gainEtn, gainPct };
  }
  return best;
}

export function freshGapBook() {
  return { seedEtn: 0, seeded: {}, stables: { USDT: 0, USDC: 0 }, gainEtn: 0, trades: 0, recent: [], depositsUsd: {}, depositEtn: 0 };
}

/** Stablecoin added to (positive) or taken out of (negative) the gap book from outside the bot —
 * `etnValue` is what it was worth in ETN at that moment, so performance is measured against
 * everything put in, not just the ETN budget. The book never goes below zero. */
export function applyGapDeposit(book, stable, usd, etnValue) {
  const before = book.stables[stable] || 0;
  const applied = Math.max(usd, -before);
  book.stables[stable] = before + applied;
  book.depositsUsd = { ...(book.depositsUsd || {}), [stable]: ((book.depositsUsd || {})[stable] || 0) + applied };
  book.depositEtn = (book.depositEtn || 0) + (usd === 0 ? 0 : etnValue * (applied / usd));
  return book;
}

/** First leg filled: the dear pool's stablecoin arrived. Live trades settle the two legs separately
 * (each is its own transaction); see applyGapTrade for both at once. */
export function applyGapSellLeg(book, { dear, stableReceived }) {
  book.stables[dear] = (book.stables[dear] || 0) + stableReceived;
  return book;
}

/** Second leg filled: the cheap pool's stablecoin was spent on ETN. Closes the trade. */
export function applyGapBuyLeg(book, { dear, cheap, etnSold, stableReceived, stableSpent, etnBought, at = null, txHashes = null }) {
  book.stables[cheap] = (book.stables[cheap] || 0) - stableSpent;
  book.gainEtn += etnBought - etnSold;
  book.trades += 1;
  if (book.recent) {
    book.recent.push({ at, dear, cheap, etnSold, stableReceived, stableSpent, etnBought, gainEtn: etnBought - etnSold, txHashes });
    if (book.recent.length > 50) book.recent.shift();
  }
  return book;
}

/** Applies a completed gap trade (both legs) to the book. Mutates and returns it. */
export function applyGapTrade(book, trade) {
  applyGapSellLeg(book, trade);
  return applyGapBuyLeg(book, trade);
}
