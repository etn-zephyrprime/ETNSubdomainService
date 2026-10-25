// Pure decision tests for services/etnGapStrategy.js (and how the gap book feeds the bot's ETN
// inventory in services/etnAccumulatorStrategy.js). Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGap, gapSizes, affordableLegEtn, freshGapBook, applyGapSellLeg, applyGapBuyLeg, applyGapTrade, applyGapDeposit } from "../services/etnGapStrategy.js";
import { botEtnInventory, summarize } from "../services/etnAccumulatorStrategy.js";

const book = (USDT, USDC) => ({ ...freshGapBook(), stables: { USDT, USDC } });

test("sizes: full, half, quarter clip", () => {
  assert.deepEqual(gapSizes(10000), [10000, 5000, 2500]);
});

test("picks the biggest net ETN gain that clears minGain", () => {
  const cands = [
    { dear: "USDT", cheap: "USDC", etnIn: 10000, stableOut: 22, etnBack: 10120 }, // +1.2%
    { dear: "USDT", cheap: "USDC", etnIn: 5000, stableOut: 11.1, etnBack: 5090 }, // +1.8%, +90
    { dear: "USDT", cheap: "USDC", etnIn: 2500, stableOut: 5.6, etnBack: 2550 }, // +2%, +50
  ];
  const d = decideGap(book(20, 20), cands, { minGainPct: 1.5 });
  assert.equal(d.etnIn, 5000);
  assert.equal(Math.round(d.gainEtn), 90);
  assert.equal(decideGap(book(20, 20), cands, { minGainPct: 2.5 }), null);
});

test("never spends more of the cheap stablecoin than the book holds", () => {
  const cands = [
    { dear: "USDT", cheap: "USDC", etnIn: 10000, stableOut: 22, etnBack: 10300 },
    { dear: "USDT", cheap: "USDC", etnIn: 2500, stableOut: 5.5, etnBack: 2560 },
  ];
  const d = decideGap(book(50, 6), cands, { minGainPct: 1 });
  assert.equal(d.etnIn, 2500);
  assert.equal(decideGap(book(50, 5), cands, { minGainPct: 1 }), null);
});

test("legs: stablecoin shifts from the cheap side to the dear side, gain is pure ETN", () => {
  const b = book(20, 20);
  applyGapSellLeg(b, { dear: "USDT", stableReceived: 11 });
  assert.equal(b.stables.USDT, 31);
  applyGapBuyLeg(b, { dear: "USDT", cheap: "USDC", etnSold: 5000, stableReceived: 11, stableSpent: 11, etnBought: 5080 });
  assert.equal(b.stables.USDC, 9);
  assert.equal(b.gainEtn, 80);
  assert.equal(b.trades, 1);
  assert.equal(b.recent.length, 1);
  applyGapTrade(b, { dear: "USDC", cheap: "USDT", etnSold: 2500, stableReceived: 5, stableSpent: 5, etnBought: 2540 });
  assert.equal(b.stables.USDC, 14);
  assert.equal(b.stables.USDT, 26);
  assert.equal(b.gainEtn, 120);
});

test("inventory: seed out, gains in, an unfinished first leg out", () => {
  const state = { budgetEtn: 100000, realizedGainEtn: 0, lots: [], gap: { ...book(22, 22), seedEtn: 20000, gainEtn: 150 } };
  assert.equal(botEtnInventory(state), 80150);
  state.gapLeg = { etnSold: 5000 };
  assert.equal(botEtnInventory(state), 75150);
  state.gapLeg = null;
  const s = summarize(state, {}, 19800); // the gap book's stablecoin would buy 19,800 ETN now
  assert.equal(s.etnEquivalentNow, 80150 + 19800);
  assert.equal(s.gapGainEtn, 150);
});

test("no gap book: inventory unchanged", () => {
  assert.equal(botEtnInventory({ budgetEtn: 100000, realizedGainEtn: 10, lots: [] }), 100010);
});

test("sizes: a nearly drained side still trades with what it can afford", () => {
  // $5.17 of USDC at ~$0.00215/ETN affords ~2,330 ETN — just under the 2,500 quarter clip (Oct 2026).
  const afford = affordableLegEtn(5.17, 0.00215);
  assert.ok(afford > 2300 && afford < 2340);
  assert.deepEqual(gapSizes(10000, afford), [Math.floor(afford)]);
  assert.deepEqual(gapSizes(10000, 6000), [5000, 2500, 6000]);
  assert.deepEqual(gapSizes(10000, 400), []); // below the minimum leg
  assert.equal(affordableLegEtn(0, 0.002), 0);
});

test("deposits: top-ups join the book and count as money put in", () => {
  const b = book(27.39, 16.14);
  applyGapDeposit(b, "USDC", 50, 22900);
  assert.equal(b.stables.USDC, 66.14);
  assert.equal(b.depositsUsd.USDC, 50);
  assert.equal(b.depositEtn, 22900);
  applyGapDeposit(b, "USDT", -100, -45800); // more missing than the book holds: floored at zero
  assert.equal(b.stables.USDT, 0);
  assert.ok(Math.abs(b.depositsUsd.USDT + 27.39) < 1e-9);
  assert.ok(Math.abs(b.depositEtn - (22900 - 45800 * (27.39 / 100))) < 1e-6);
  const state = { budgetEtn: 100000, realizedGainEtn: 0, lots: [], gap: { ...book(0, 0), seedEtn: 20000, gainEtn: 0, depositEtn: 22900 } };
  const s = summarize(state, {}, 42900); // seed + deposit stablecoin worth exactly what went in
  assert.equal(s.contributedEtn, 122900);
  assert.equal(s.vsHoldPct, 0);
});
