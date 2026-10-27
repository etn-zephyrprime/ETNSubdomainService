// Pure decision tests for services/etnCatchupStrategy.js. Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATCHUP_DEFAULTS, freshCatchupBook, kucoinMid, lagsPct, decideCatchupBuy, decideCatchupClose, applyCatchupBuy, applyCatchupClose, applyCatchupFunding, splitDeposit } from "../services/etnCatchupStrategy.js";
import { botEtnInventory, summarize } from "../services/etnAccumulatorStrategy.js";

const cfg = { ...CATCHUP_DEFAULTS, lagPct: 3, clipUsd: 50, minGainPct: 1, reentryMinutes: 15 };
const funded = () => { const b = freshCatchupBook(100); applyCatchupFunding(b, "USDT", 50); applyCatchupFunding(b, "USDC", 50); return b; };

test("KuCoin mid: usable book only", () => {
  assert.equal(kucoinMid({ bestBid: "0.002193", bestAsk: "0.00221" }), (0.002193 + 0.00221) / 2);
  assert.equal(kucoinMid({ bestBid: "0.0020", bestAsk: "0.0022" }), null); // ~9.5% spread: too thin
  assert.equal(kucoinMid({ bestBid: "0.0022", bestAsk: "0.0021" }), null); // crossed
  assert.equal(kucoinMid({}), null);
  assert.equal(kucoinMid(undefined), null);
});

test("buys in the cheapest pool it can pay for, once it lags by the threshold", () => {
  const b = funded();
  const lags = lagsPct({ USDT: 0.00209, USDC: 0.00212 }, 0.002202); // -5.1% / -3.7%
  assert.ok(Math.abs(lags.USDT + 5.086) < 0.01);
  const d = decideCatchupBuy(b, lags, cfg, Date.parse("2026-10-27T23:00:00Z"));
  assert.equal(d.stable, "USDT");
  assert.equal(d.usd, 50);
  assert.equal(decideCatchupBuy(b, { USDT: -2.5, USDC: -2.9 }, cfg), null); // not lagging enough
  b.cash.USDT = 20; // can't pay a clip in USDT -> falls to USDC, which also lags enough
  assert.equal(decideCatchupBuy(b, lags, cfg).stable, "USDC");
});

test("re-entry waits the configured minutes", () => {
  const b = funded();
  applyCatchupBuy(b, { stable: "USDT", usdSpent: 50, etnBought: 23900, at: "2026-10-27T23:00:00Z" });
  const lags = { USDT: -5, USDC: -5 };
  assert.equal(decideCatchupBuy(b, lags, cfg, Date.parse("2026-10-27T23:10:00Z")), null);
  assert.equal(decideCatchupBuy(b, lags, cfg, Date.parse("2026-10-27T23:16:00Z")).stable, "USDC");
});

test("closes only when the dollars come back for at least minGain% less ETN, best lot first", () => {
  const b = funded();
  applyCatchupBuy(b, { stable: "USDT", usdSpent: 50, etnBought: 23900, at: "t1" });
  applyCatchupBuy(b, { stable: "USDC", usdSpent: 50, etnBought: 23500, at: "t2" });
  assert.equal(decideCatchupClose(b, { 1: 23800, 2: 23400 }, cfg), null); // +0.4% each: not enough
  const c = decideCatchupClose(b, { 1: 23000, 2: 23200 }, cfg);
  assert.equal(c.lotId, 1);
  assert.equal(c.keepEtn, 900);
  applyCatchupClose(b, 1, { etnSold: 23000, usdReceived: 49.9 });
  assert.equal(b.gainEtn, 900);
  assert.equal(b.closed, 1);
  assert.equal(b.lots.length, 1);
  assert.ok(Math.abs(b.cash.USDT - 49.9) < 1e-9);
});

test("deposits fill the pot up to its target, the rest goes on", () => {
  const b = freshCatchupBook(100);
  assert.deepEqual(splitDeposit(b, "USDT", 60), { toCatchup: 60, rest: 0 });
  applyCatchupFunding(b, "USDT", 60);
  assert.deepEqual(splitDeposit(b, "USDC", 70), { toCatchup: 40, rest: 30 });
  applyCatchupFunding(b, "USDC", 40);
  assert.deepEqual(splitDeposit(b, "USDT", 10), { toCatchup: 0, rest: 10 });
  assert.deepEqual(splitDeposit(null, "USDT", 10), { toCatchup: 0, rest: 10 });
});

test("only closed lots' gain counts toward the bot's ETN", () => {
  const b = funded();
  applyCatchupBuy(b, { stable: "USDT", usdSpent: 50, etnBought: 23900 });
  applyCatchupBuy(b, { stable: "USDC", usdSpent: 50, etnBought: 23500 });
  applyCatchupClose(b, 1, { etnSold: 23000, usdReceived: 50 });
  const state = { budgetEtn: 100000, realizedGainEtn: 0, lots: [], cu: b };
  assert.equal(botEtnInventory(state), 100900);
  const s = summarize(state);
  assert.equal(s.cuGainEtn, 900);
  assert.equal(s.cuClosed, 1);
  assert.equal(s.cuOpenLots, 1);
});
