// Pure decision tests for services/etnTriangleStrategy.js. Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { TRIANGLE_POOLS, TRIANGLE_ROUTES, poolRate, routeEdges, decideTriangle, triangleMinOut, freshTriangleBook, applyTriangleTrade, WETN, DYNO } from "../services/etnTriangleStrategy.js";
import { botEtnInventory, summarize } from "../services/etnAccumulatorStrategy.js";

const Q96 = 2n ** 96n;
// sqrtPriceX96 for a token1-per-token0 price of p
const sqrtOf = (p) => BigInt(Math.round(Math.sqrt(p) * 2 ** 48)) * 2n ** 48n;

test("pool rate reads the right direction", () => {
  const info = TRIANGLE_POOLS["DYNO/WETN"]; // token0 WETN, token1 DYNO
  const sp = sqrtOf(1 / 1600); // 1 WETN = 1/1600 DYNO
  assert.ok(Math.abs(poolRate(info, sp, WETN) - 1 / 1600) < 1e-12);
  assert.ok(Math.abs(poolRate(info, sp, DYNO) - 1600) < 1e-6);
  assert.equal(poolRate(info, Q96, WETN), 1);
});

test("route edges: a consistent set of prices loops back to ~0, a skewed one shows on its route", () => {
  // Every pool at price 1 (token1 per token0) means every rate is 1, so every loop is flat.
  const flat = Object.fromEntries(Object.keys(TRIANGLE_POOLS).map((k) => [k, Q96]));
  for (const e of routeEdges(flat)) assert.ok(Math.abs(e.edgePct) < 1e-9);
  // Make DYNO/CLUB pay 2% more DYNO per CLUB: the loop that sells CLUB for DYNO gains, its reverse loses.
  const skew = { ...flat, "DYNO/CLUB": sqrtOf(1.02) }; // token0 CLUB, token1 DYNO
  const byName = Object.fromEntries(routeEdges(skew).map((e) => [e.name, e.edgePct]));
  assert.ok(Math.abs(byName["ETN>CLUB>DYNO>ETN"] - 2) < 1e-6);
  assert.ok(Math.abs(byName["ETN>DYNO>CLUB>ETN"] - (1 / 1.02 - 1) * 100) < 1e-6);
  assert.equal(routeEdges({ ...flat, "DYNO/CLUB": undefined }).find((e) => e.name === "ETN>DYNO>CLUB>ETN").edgePct, null);
  assert.equal(TRIANGLE_ROUTES.length, 4);
});

test("decide: biggest gain that clears the minimum and the bot can afford", () => {
  const quotes = [
    { route: "ETN>DYNO>CLUB>ETN", etnIn: 1000, etnOut: 1020 }, // +20 < 25
    { route: "ETN>DYNO>CLUB>ETN", etnIn: 10000, etnOut: 10090 }, // +90
    { route: "ETN>DYNO>BOLT>ETN", etnIn: 30000, etnOut: 30150 }, // +150 but not affordable below
  ];
  assert.equal(decideTriangle(quotes, { minGainEtn: 25 }).etnIn, 30000);
  const d = decideTriangle(quotes, { minGainEtn: 25 }, (etn) => etn <= 10000);
  assert.equal(d.etnIn, 10000);
  assert.equal(d.gainEtn, 90);
  assert.equal(decideTriangle(quotes, { minGainEtn: 200 }), null);
  assert.equal(decideTriangle([], { minGainEtn: 25 }), null);
});

test("min out keeps at least half the gain and never allows a loss", () => {
  assert.equal(triangleMinOut(10000, 10100), 10050);
  assert.equal(triangleMinOut(10000, 9990), 10000); // a losing quote would just revert
});

test("books: triangle gains count toward ETN accumulated and inventory", () => {
  const book = freshTriangleBook();
  applyTriangleTrade(book, { route: "ETN>DYNO>BOLT>ETN", etnIn: 30000, etnOut: 30583 });
  applyTriangleTrade(book, { route: "ETN>CLUB>DYNO>ETN", etnIn: 1000, etnOut: 1030 });
  assert.equal(book.trades, 2);
  assert.equal(book.gainEtn, 613);
  const state = { budgetEtn: 100000, realizedGainEtn: 0, lots: [], tri: book };
  assert.equal(botEtnInventory(state), 100613);
  const s = summarize(state);
  assert.equal(s.triTrades, 2);
  assert.equal(s.triGainEtn, 613);
});
