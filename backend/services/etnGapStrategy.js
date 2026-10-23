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

/** Candidate leg sizes to quote for a given max clip. */
export function gapSizes(clipEtn) {
  return [clipEtn, clipEtn / 2, clipEtn / 4];
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
  return { seedEtn: 0, seeded: {}, stables: { USDT: 0, USDC: 0 }, gainEtn: 0, trades: 0, recent: [] };
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
