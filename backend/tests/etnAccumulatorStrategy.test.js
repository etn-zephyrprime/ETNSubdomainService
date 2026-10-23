// Pure decision tests for services/etnAccumulatorStrategy.js. Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, updateEma, decide, applySell, applyBuyback, summarize, botEtnInventory } from "../services/etnAccumulatorStrategy.js";

const cfg = { ...DEFAULT_CONFIG, clipEtn: 10000, warmupSamples: 1 };
const fresh = (over = {}) => ({ budgetEtn: 100000, realizedGainEtn: 0, lots: [], ema: 0.002, samples: 5, ...over });

test("EMA: half-life weighting and first sample", () => {
  assert.equal(updateEma(null, 5, 0, 1000), 5);
  assert.equal(updateEma(4, 6, 1000, 1000), 5); // one half-life moves halfway
  assert.equal(updateEma(4, 6, 0, 1000), 4);
});

test("sells only above the band, into the pool that pays most", () => {
  const below = decide(fresh(), { sell: [{ stable: "USDT", stableOut: 20.5 }] }, cfg); // 0.00205 < 0.00206
  assert.equal(below.action, "hold");
  const d = decide(fresh(), { sell: [{ stable: "USDT", stableOut: 20.7 }, { stable: "USDC", stableOut: 21 }] }, cfg);
  assert.equal(d.action, "sell");
  assert.equal(d.stable, "USDC");
  assert.equal(d.etnAmount, 10000);
});

test("warm-up blocks sales", () => {
  const d = decide(fresh({ samples: 0 }), { sell: [{ stable: "USDT", stableOut: 30 }] }, { ...cfg, warmupSamples: 10 });
  assert.equal(d.action, "hold");
});

test("ladder: a further sale needs a higher price than the highest open lot", () => {
  const s = fresh();
  applySell(s, { id: 1, stable: "USDT", etnSold: 10000, stableAmount: 21, txHash: null, at: "t" }); // 0.0021
  assert.equal(decide(s, { sell: [{ stable: "USDT", stableOut: 21.5 }] }, cfg).action, "hold"); // < 0.002163
  assert.equal(decide(s, { sell: [{ stable: "USDT", stableOut: 21.7 }] }, cfg).action, "sell");
});

test("stablecoin exposure cap", () => {
  const s = fresh();
  for (let i = 1; i <= 5; i++) applySell(s, { id: i, stable: "USDT", etnSold: 10000, stableAmount: 20 + i, txHash: null, at: "t" });
  const d = decide(s, { sell: [{ stable: "USDT", stableOut: 100 }] }, cfg);
  assert.equal(d.action, "hold");
  assert.match(d.reason, /exposure/);
});

test("buys a lot back only for at least minGain more ETN, best lot first, before any sale", () => {
  const s = fresh();
  applySell(s, { id: 1, stable: "USDT", etnSold: 10000, stableAmount: 22, txHash: null, at: "t" });
  applySell(s, { id: 2, stable: "USDC", etnSold: 10000, stableAmount: 23, txHash: null, at: "t" });
  assert.equal(decide(s, { buyback: { 1: 10250, 2: 10100 }, sell: [] }, cfg).action, "hold"); // +2.5%, +1% < 3%
  const d = decide(s, { buyback: { 1: 10350, 2: 10600 }, sell: [{ stable: "USDT", stableOut: 99 }] }, cfg);
  assert.equal(d.action, "buyback");
  assert.equal(d.lotId, 2);
  assert.equal(d.stable, "USDC");
});

test("books: inventory, realized gain and summary", () => {
  const s = fresh();
  applySell(s, { id: 1, stable: "USDT", etnSold: 10000, stableAmount: 22, txHash: "0xa", at: "t" });
  assert.equal(botEtnInventory(s), 90000);
  applyBuyback(s, 1, { etnBought: 10500, txHash: "0xb", at: "t" });
  assert.equal(s.realizedGainEtn, 500);
  assert.equal(botEtnInventory(s), 100500);
  applySell(s, { id: 2, stable: "USDC", etnSold: 10000, stableAmount: 23, txHash: "0xc", at: "t" });
  const sum = summarize(s, { 2: 9800 });
  assert.equal(sum.cyclesClosed, 1);
  assert.equal(sum.etnEquivalentNow, 90500 + 9800);
  assert.ok(Math.abs(sum.vsHoldPct - 0.3) < 1e-9);
});

test("inventory below a clip holds", () => {
  const s = fresh({ budgetEtn: 5000 });
  assert.equal(decide(s, { sell: [{ stable: "USDT", stableOut: 30 }] }, cfg).action, "hold");
  assert.equal(decide(fresh(), { sell: [{ stable: "USDT", stableOut: 30 }], walletEtn: 5000 }, cfg).action, "hold");
});
