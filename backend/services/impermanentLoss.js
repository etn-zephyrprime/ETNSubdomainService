// backend/services/impermanentLoss.js
//
// Impermanent loss for one liquidity position (V2 LP, V3 position, full-range yield farm): what the
// position's tokens are worth now versus simply having held what was deposited — before fees.
//
// Two methods, by position type:
//
//  - FULL RANGE (V2 pairs, YieldFarm positions — always full-range, see isFullRangeFarm): the exact
//    constant-product formula, IL = 2√r / (1 + r) − 1, with r = current pool price / entry price.
//    The entry price is the ratio of the net deposited amounts (deposited1 / deposited0) and the
//    current price is the ratio of what the share holds now (amount1 / amount0). Only RATIOS are
//    used, so it stays right even when the deposited baseline's scale is off — e.g. LP tokens that
//    arrived by transfer rather than being minted by this wallet. Fees don't enter it: V2 fees
//    compound into both reserves pro rata, leaving the price ratio untouched.
//  - CONCENTRATED (V3 positions): no closed form for an arbitrary range, so compare values directly
//    at today's prices — Σ amount × price against Σ deposited × price. Uses the deposited amounts
//    themselves (getV3PositionDepositedQuantities — each NFT is minted by its owner, so there's no
//    transfer-in scale problem).
//
// "Deposited" is each position's net baseline (every add/top-up minus every removal's principal), so
// several deposits at different prices give a blended entry — an approximation for the formula
// method, exact for the value method.
import Decimal from "decimal.js";

// Before fees a pooled position can never beat holding. A clearly positive figure means the baseline
// is incomplete (history before ingestion began, etc.), so it's shown as nothing rather than as a
// fabricated gain. Small tolerance for rounding.
const MAX_POSITIVE_IL_PERCENT = 0.5;

const toDec = (v) => (v == null ? null : new Decimal(v));

/** legs: exactly two [{ amount, pendingFees?, depositedAmount, priceUsd }] (Decimal-able).
 * opts.fullRange: true for V2 / farm positions (formula method), false for V3 (value method).
 * Returns { percent, lossUsd, afterFeesPercent, method } as strings — percent ≤ 0, lossUsd the dollar
 * shortfall vs holding (≤ 0), afterFeesPercent with uncollected fees added back (null when the
 * position has no separate fee figure, i.e. V2) — or null when it can't be computed honestly. */
export function computeImpermanentLoss(legs, { fullRange }) {
  if (!Array.isArray(legs) || legs.length !== 2) return null;
  const parsed = legs.map((l) => ({
    amount: toDec(l.amount),
    deposited: toDec(l.depositedAmount),
    price: toDec(l.priceUsd),
    fees: toDec(l.pendingFees),
  }));
  if (parsed.some((l) => l.amount == null || l.deposited == null || l.price == null)) return null;
  if (parsed.some((l) => !l.price.isFinite() || l.price.lte(0) || l.amount.lt(0) || l.deposited.lt(0))) return null;

  const [a, b] = parsed;
  const positionUsd = a.amount.times(a.price).plus(b.amount.times(b.price));
  const feesUsd = parsed.reduce((s, l) => (l.fees ? s.plus(l.fees.times(l.price)) : s), new Decimal(0));
  const hasFees = parsed.some((l) => l.fees != null);

  let fraction; // IL as a fraction, e.g. -0.057
  let hodlUsd; // value of the equivalent held tokens at today's prices
  if (fullRange) {
    if (a.amount.lte(0) || b.amount.lte(0) || a.deposited.lte(0) || b.deposited.lte(0)) return null;
    const r = b.amount.div(a.amount).div(b.deposited.div(a.deposited)); // current price / entry price
    fraction = r.sqrt().times(2).div(r.plus(1)).minus(1);
    hodlUsd = positionUsd.div(fraction.plus(1));
  } else {
    hodlUsd = a.deposited.times(a.price).plus(b.deposited.times(b.price));
    if (hodlUsd.lte(0)) return null;
    fraction = positionUsd.div(hodlUsd).minus(1);
    if (fraction.times(100).gt(MAX_POSITIVE_IL_PERCENT)) return null;
    fraction = Decimal.min(fraction, 0);
  }
  if (fraction.lte(-1)) return null;

  return {
    percent: fraction.times(100).toString(),
    lossUsd: hodlUsd.times(fraction).toString(),
    afterFeesPercent: hasFees ? positionUsd.plus(feesUsd).minus(hodlUsd).div(hodlUsd).times(100).toString() : null,
    method: fullRange ? "full_range_formula" : "value_vs_hold",
  };
}
