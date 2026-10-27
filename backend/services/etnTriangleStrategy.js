// backend/services/etnTriangleStrategy.js
//
// Pure decision logic for the ETN accumulator bot's third mode: ETN triangles. ElectroSwap's DYNO,
// BOLT and CLUB V3 pools (0.3% each) don't always agree with each other, so a loop like
//
//   ETN -> DYNO -> CLUB -> ETN        (or ETN -> DYNO -> BOLT -> ETN, and both reverses)
//
// can come back with more ETN than went in. The whole loop is ONE transaction (SwapRouter02
// exactInput over a 3-hop path, then unwrap to native ETN) with amountOutMinimum above the ETN put
// in, so it either ends with more ETN or reverts — the only cost of a miss is gas. ETN only: no
// stablecoin, and the ETN is back in the wallet in the same transaction.
//
// Research (Oct 2026, 43.6 days of swaps, one trade per gap episode): ~+3,165 ETN (~73 ETN/day);
// the 25 ETN minimum gain kept all of it with 20 trades instead of 36. QuoterV2 crossed no ticks even
// at 30,000 ETN, and an eth_call of the full loop through the router returned exactly the quote on
// all four routes, so none of the three tokens taxes transfers. CORE and PDY are excluded (taxes).

export const WETN = "0x138DAFbDA0CCB3d8E39C19edb0510Fc31b7C1c77";
export const DYNO = "0xEe432C220273e4F949007B4c1946562826Efa055";
export const BOLT = "0x043fAa1b5C5FC9a7dc35171f290c29ECDE0cCff1";
export const CLUB = "0xc9fc4ab00911793d99b5c7bd01f01203c21d4131";

// The five V3 pools the routes use (all fee 3000), with their token order — read for the pre-screen.
export const TRIANGLE_POOLS = {
  "DYNO/WETN": { pool: "0x806559d60869359cd4eb4ffd94ad8f9b668d919c", token0: WETN, token1: DYNO },
  "CLUB/WETN": { pool: "0x86566c3c78424e3c3c2adb274fab551b7262e0ca", token0: WETN, token1: CLUB },
  "BOLT/WETN": { pool: "0x2df6c494b5e96b781b5cb410c4889d4f079bad30", token0: BOLT, token1: WETN },
  "DYNO/CLUB": { pool: "0x2132e7c909c4c3338eda5f0e165a3a43aadc3fbe", token0: CLUB, token1: DYNO },
  "DYNO/BOLT": { pool: "0x32ecfc060373e3379a86538a5017b4d89a5a75c1", token0: BOLT, token1: DYNO },
};

// Each route as token hops (fee 3000 between each) and the pools it crosses, in order.
export const TRIANGLE_ROUTES = [
  { name: "ETN>DYNO>CLUB>ETN", tokens: [WETN, DYNO, CLUB, WETN], pools: ["DYNO/WETN", "DYNO/CLUB", "CLUB/WETN"] },
  { name: "ETN>CLUB>DYNO>ETN", tokens: [WETN, CLUB, DYNO, WETN], pools: ["CLUB/WETN", "DYNO/CLUB", "DYNO/WETN"] },
  { name: "ETN>DYNO>BOLT>ETN", tokens: [WETN, DYNO, BOLT, WETN], pools: ["DYNO/WETN", "DYNO/BOLT", "BOLT/WETN"] },
  { name: "ETN>BOLT>DYNO>ETN", tokens: [WETN, BOLT, DYNO, WETN], pools: ["BOLT/WETN", "DYNO/BOLT", "DYNO/WETN"] },
];
export const TRIANGLE_FEE = 3000;

export const TRIANGLE_DEFAULTS = {
  sizesEtn: [1000, 3000, 10000, 30000],
  minGainEtn: 25, // backtest pick: same total as 2 ETN with about half the transactions
};

/** Price of `tokenOut` per `tokenIn` from a V3 pool's sqrtPriceX96 (raw units; all of these tokens
 * have 18 decimals). */
export function poolRate(poolInfo, sqrtPriceX96, tokenIn) {
  const p = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // token1 per token0
  return tokenIn.toLowerCase() === poolInfo.token0.toLowerCase() ? p : 1 / p;
}

/** Mid-price edge of each route, in %, before fees and price impact: the product of the three pool
 * rates around the loop, minus one. A route can only pay if this beats the three 0.3% fees — used as
 * a cheap pre-screen (five slot0 reads) before asking the quoter for real figures. */
export function routeEdges(sqrtPrices) {
  return TRIANGLE_ROUTES.map((r) => {
    let x = 1;
    for (let i = 0; i < 3; i++) {
      const info = TRIANGLE_POOLS[r.pools[i]];
      const sp = sqrtPrices[r.pools[i]];
      if (!sp) return { name: r.name, edgePct: null };
      x *= poolRate(info, sp, r.tokens[i]);
    }
    return { name: r.name, edgePct: (x - 1) * 100 };
  });
}

/** Fees alone take ~0.9% (three 0.3% hops), so below this mid edge nothing can clear. */
export const PRESCREEN_EDGE_PCT = 0.9;

/**
 * The best triangle to run, or null.
 * @param quotes [{ route, etnIn, etnOut }] — real QuoterV2 figures
 * @param canSpendEtn (etn) => bool — the bot's own inventory / wallet balance check
 */
export function decideTriangle(quotes, cfg = TRIANGLE_DEFAULTS, canSpendEtn = () => true) {
  let best = null;
  for (const q of quotes) {
    if (!(q.etnOut > 0) || !canSpendEtn(q.etnIn)) continue;
    const gainEtn = q.etnOut - q.etnIn;
    if (gainEtn >= cfg.minGainEtn && (!best || gainEtn > best.gainEtn)) best = { ...q, gainEtn };
  }
  return best;
}

/** The least ETN the transaction may return: keeps at least half the quoted gain, so a filled loop
 * can never end with less ETN than it started with, even if prices move a little first. */
export function triangleMinOut(etnIn, expectedOut) {
  const gain = expectedOut - etnIn;
  return etnIn + Math.max(gain / 2, 0);
}

export function freshTriangleBook() {
  return { trades: 0, gainEtn: 0, recent: [] };
}

/** Books a filled loop (mutates and returns the book). */
export function applyTriangleTrade(book, { route, etnIn, etnOut, txHash = null, at = null }) {
  book.trades += 1;
  book.gainEtn += etnOut - etnIn;
  book.recent.push({ at, route, etnIn, etnOut, gainEtn: etnOut - etnIn, txHash });
  if (book.recent.length > 50) book.recent.shift();
  return book;
}
