// Pure tests for services/lpCompositionHistory.js. Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { sqrtPriceX96FromUsd, v3Amounts, v2Amounts, dailyQuantities, dailyFarmLiquidity, toPoints, valueInEtn, priceFromSqrt } from "../services/lpCompositionHistory.js";

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test("pool price from the two tokens' USD prices (decimals included)", () => {
  // ETN (18 dp) at $0.002, USDT (6 dp) at $1: 0.002 USDT per ETN -> raw 0.002e-12
  const sp = sqrtPriceX96FromUsd(0.002, 1, 18, 6);
  close((Number(sp) / 2 ** 96) ** 2 * 1e12, 0.002);
  assert.equal(sqrtPriceX96FromUsd(0, 1, 18, 6), null);
});

test("full-range (farm) and V2: as token0's price rises, the position holds less token0 and more token1", () => {
  const L = 10n ** 21n;
  const lo = v3Amounts(L, sqrtPriceX96FromUsd(0.002, 1, 18, 6), null, null, 18, 6);
  const hi = v3Amounts(L, sqrtPriceX96FromUsd(0.004, 1, 18, 6), null, null, 18, 6);
  close(hi.amount0, lo.amount0 / Math.SQRT2, 1e-9); // token0 down by sqrt(2)
  close(hi.amount1, lo.amount1 * Math.SQRT2, 1e-9); // token1 up by sqrt(2)
  // and the two legs are worth the same at the pool price (50/50 for full range)
  close(lo.amount0 * 0.002, lo.amount1, 1e-6);

  const v1 = v2Amounts(100, 50, 0.002), v2 = v2Amounts(100, 50, 0.004);
  close(v2.amount0, v1.amount0 / Math.SQRT2);
  close(v2.amount1, v1.amount1 * Math.SQRT2);
});

test("V3 range position: all token0 below the range, all token1 above it", () => {
  const L = 10n ** 18n;
  const below = v3Amounts(L, sqrtPriceX96FromUsd(0.5, 1, 18, 18), 0, 6932, 18, 18); // price 0.5, range 1..2
  const above = v3Amounts(L, sqrtPriceX96FromUsd(4, 1, 18, 18), 0, 6932, 18, 18);
  const inside = v3Amounts(L, sqrtPriceX96FromUsd(1.4, 1, 18, 18), 0, 6932, 18, 18);
  assert.ok(below.amount0 > 0 && below.amount1 === 0);
  assert.ok(above.amount0 === 0 && above.amount1 > 0);
  assert.ok(inside.amount0 > 0 && inside.amount1 > 0);
});

test("daily quantities: in/out/self/swap move the position; lock/unlock don't", () => {
  const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
  const t = (d, h = 12) => Date.parse(`${d}T${String(h).padStart(2, "0")}:00:00Z`);
  const events = [
    { kind: "in", tokenAddress: "lp", quantity: 10, timestamp: t("2026-10-01") },
    { kind: "lock", tokenAddress: "lp", quantity: 10, timestamp: t("2026-10-02") },
    { kind: "swap", soldTokenAddress: "x", soldQuantity: 1, boughtTokenAddress: "lp", boughtQuantity: 5, timestamp: t("2026-10-02", 13) },
    { kind: "out", tokenAddress: "lp", quantity: 15, timestamp: t("2026-10-03") },
    { kind: "in", tokenAddress: "other", quantity: 99, timestamp: t("2026-10-03") },
  ];
  assert.deepEqual(dailyQuantities(events, new Set(["lp"]), days).byKey.get("lp"), [10, 15, 0, 0]);
});

test("farm liquidity: deposits add liquidityAdded; reward claims (0-token withdrawals) change nothing; real withdrawals remove sqrt(a0*a1)", () => {
  const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"];
  const rows = [
    { event_type: "farm_deposit", raw_args: { liquidityAdded: "1000" }, timestamp: "2026-10-01T10:00:00Z" },
    { event_type: "farm_withdraw", raw_args: { amount0Withdrawn: "0", amount1Withdrawn: "0" }, timestamp: "2026-10-02T09:00:00Z" }, // a reward claim: no change
    { event_type: "farm_deposit", raw_args: { liquidityAdded: "500" }, timestamp: "2026-10-02T10:00:00Z" },
    { event_type: "farm_withdraw", raw_args: { amount0Withdrawn: "250", amount1Withdrawn: "1600" }, timestamp: "2026-10-03T10:00:00Z" }, // removes sqrt(400000) = 632
    { event_type: "farm_withdraw", raw_args: { amount0Withdrawn: "10000", amount1Withdrawn: "10000" }, timestamp: "2026-10-04T10:00:00Z" }, // everything left
  ];
  assert.deepEqual(dailyFarmLiquidity(rows, days), [1000n, 1500n, 868n, 0n, 0n]);
});

test("chart points: held days, plus a zero on the day it closed; unpriced days skipped", () => {
  const days = ["d1", "d2", "d3", "d4", "d5"];
  const pts = toPoints(days, [0, 2, 3, 0, 0], (d) => (d === 2 ? null : { amount0: d, amount1: -d }));
  assert.deepEqual(pts, [{ date: "d2", amount0: 1, amount1: -1 }, { date: "d4", amount0: 0, amount1: 0 }]);
});

test("position value in ETN: both legs at the pool's price, through the WETN leg or token0's ETN price", () => {
  // CLUB/DYNO: 10,000 CLUB + 183 DYNO, pool price 0.0183 DYNO per CLUB, 1 CLUB = 28 ETN -> 280k + 280k
  close(valueInEtn({ amount0: 10000, amount1: 183 }, 0.0183, { leg: 0, etnPerToken: 28 }), 560000);
  // USDT/ETN with ETN as token1: 1,000,000 ETN + $2,000 at 500 ETN per USDT -> 2,000,000 ETN
  close(valueInEtn({ amount0: 2000, amount1: 1000000 }, 500, { leg: 1, etnPerToken: 1 }), 2000000);
  assert.equal(valueInEtn({ amount0: 1, amount1: 1 }, 1, null), null);
  close(priceFromSqrt(sqrtPriceX96FromUsd(0.002, 1, 18, 6), 18, 6), 0.002);
});
