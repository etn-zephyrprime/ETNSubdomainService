// Pure decision tests for services/etnCatchupStrategy.js. Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATCHUP_DEFAULTS, freshCatchupBook, kucoinMid, lagsPct, decideCatchupBuy, decideCatchupClose, decideCatchupSell, decideCatchupBuyBack, applyCatchupBuy, applyCatchupClose, applyCatchupSell, applyCatchupBuyBack, applyCatchupFunding, splitDeposit, openSellEtn, openSellUsd } from "../services/etnCatchupStrategy.js";
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

test("sell side: sells in the dearest pool once it's lagPct above KuCoin, within the ETN cap", () => {
  const b = funded();
  const mids = { USDT: 0.00228, USDC: 0.00226 };
  const lags = lagsPct(mids, 0.00220); // +3.6% / +2.7%
  const d = decideCatchupSell(b, lags, mids, { ...cfg, maxSellEtn: 40000 }, Date.parse("2026-10-28T10:00:00Z"));
  assert.equal(d.stable, "USDT");
  assert.ok(Math.abs(d.etn - 50 / 0.00228) < 1e-6); // ~21,930 ETN
  assert.equal(decideCatchupSell(b, { USDT: 2.5, USDC: 2.9 }, mids, cfg), null);
  assert.equal(decideCatchupSell(b, lags, mids, { ...cfg, maxSellEtn: 20000 }), null); // over the cap
  assert.equal(decideCatchupSell(b, lags, mids, cfg, Date.now(), () => false), null); // can't spend the ETN
  applyCatchupSell(b, { stable: "USDT", etnSold: 21930, usdReceived: 49.85, at: "2026-10-28T10:00:00Z", lagPct: 3.6 });
  assert.equal(openSellEtn(b), 21930);
  assert.equal(openSellUsd(b, "USDT"), 49.85);
  assert.equal(openSellUsd(b, "USDC"), 0);
  assert.equal(decideCatchupSell(b, lags, mids, { ...cfg, maxSellEtn: 40000 }, Date.parse("2026-10-28T10:05:00Z")), null); // re-entry wait
  assert.equal(decideCatchupSell(b, lags, mids, { ...cfg, maxSellEtn: 40000 }, Date.parse("2026-10-28T10:16:00Z")), null); // a second clip would pass 40k
});

test("sell side: buys back only for minGain% more ETN; never mixed up with buy-first lots", () => {
  const b = funded();
  applyCatchupBuy(b, { stable: "USDC", usdSpent: 50, etnBought: 23500, at: "t0" }); // buy-first lot #1
  applyCatchupSell(b, { stable: "USDT", etnSold: 21930, usdReceived: 49.85, at: "t1" }); // sell-first lot #2
  assert.equal(decideCatchupBuyBack(b, { 2: 22100 }, cfg), null); // +0.8% < 1%
  const d = decideCatchupBuyBack(b, { 1: 99999, 2: 22500 }, cfg); // lot 1 isn't a sell-first lot — ignored
  assert.equal(d.lotId, 2);
  assert.equal(Math.round(d.gainEtn), 570);
  assert.equal(decideCatchupClose(b, { 2: 1 }, cfg), null); // the buy-first close never touches lot 2
  applyCatchupBuyBack(b, 2, { usdSpent: 49.85, etnBought: 22500 });
  assert.equal(b.gainEtn, 570);
  assert.equal(b.lots.length, 1);
  assert.equal(openSellEtn(b), 0);
});

test("inventory: sold-first ETN is out until bought back", () => {
  const b = funded();
  applyCatchupSell(b, { stable: "USDT", etnSold: 20000, usdReceived: 45 });
  const state = { budgetEtn: 100000, realizedGainEtn: 0, lots: [], cu: b };
  assert.equal(botEtnInventory(state), 80000);
  applyCatchupBuyBack(b, 1, { usdSpent: 45, etnBought: 20500 });
  assert.equal(botEtnInventory(state), 100500);
});
