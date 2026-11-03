// Pure tests for services/cexArbStrategy.js. Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { planArb, arbChecks, buyLegOrder, sellLegOrder, netFill, walk, roundDown, roundUp, freshArbBook, ARB_DEFAULTS } from "../services/cexArbStrategy.js";

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
const now = 1_800_000_000_000;
const deep = (p, side) => (side === "asks" ? [[p, 1e6]] : [[p, 1e6]]);
const book = (bid, ask) => ({ bids: deep(bid, "bids"), asks: deep(ask, "asks"), ts: now - 1000 });
const fees = { kucoin: 0.1, htx: 0.2 };
const okStatus = { trading: true, etn: { deposit: true, withdraw: true }, usdt: { deposit: true, withdraw: true } };

test("rounding and book walking", () => {
  assert.equal(roundDown(12345.67, 1), 12345);
  assert.equal(roundUp(0.00194301, 1e-7), 0.0019431);
  assert.equal(roundDown(0.00194309, 1e-7), 0.001943);
  const w = walk([[0.002, 1000], [0.0021, 1000]], 1500);
  close(w.usd, 2 + 1.05);
  assert.equal(w.worstPrice, 0.0021);
  assert.equal(walk([[0.002, 1000]], 1500), null);
});

test("plan: buys on the cheap venue, sells on the dear one, only past the edge after both fees", () => {
  // KuCoin ask 0.001940, HTX bid 0.001970 -> +1.55% gross, ~+1.24% after 0.1% + 0.2%
  const p = planArb({ kucoin: book(0.001935, 0.00194), htx: book(0.00197, 0.001975) }, fees);
  assert.equal(p.buyVenue, "kucoin");
  assert.equal(p.sellVenue, "htx");
  assert.equal(p.etn, Math.floor(90 / 0.00194)); // the larger size wins (more profit)
  close(p.edgePct, ((p.sellUsd * 0.998) / (p.buyUsd * 1.001) - 1) * 100);
  // 0.3% gross: fees eat it
  assert.equal(planArb({ kucoin: book(0.001935, 0.00194), htx: book(0.0019458, 0.00196) }, fees), null);
});

test("pre-trade checks: all clear, then each failure is reported", () => {
  const books = { kucoin: book(0.001935, 0.00194), htx: book(0.00197, 0.001975) };
  const plan = planArb(books, fees);
  const ctx = { plan, books, nowMs: now, status: { kucoin: okStatus, htx: okStatus }, balances: { kucoin: { USDT: 500, ETN: 0 }, htx: { USDT: 0, ETN: 100000 } }, book: freshArbBook() };
  assert.deepEqual(arbChecks(ctx), []);
  const failing = (over) => arbChecks({ ...ctx, ...over }).join(" | ");
  assert.match(failing({ nowMs: now + 10000 }), /stale/);
  assert.match(failing({ status: { kucoin: okStatus, htx: { ...okStatus, etn: { deposit: false, withdraw: true } } } }), /htx ETN deposits\/withdrawals/);
  assert.match(failing({ status: { kucoin: { ...okStatus, trading: false }, htx: okStatus } }), /kucoin ETN-USDT isn't trading/);
  assert.match(failing({ balances: { kucoin: { USDT: 10 }, htx: { ETN: 100000 } } }), /kucoin USDT/);
  assert.match(failing({ balances: { kucoin: { USDT: 500 }, htx: { ETN: 100 } } }), /htx ETN/);
  assert.match(failing({ book: { ...freshArbBook(), lastTradeAt: new Date(now - 5000).toISOString() } }), /too soon/);
  assert.match(failing({ book: { ...freshArbBook(), today: { trades: ARB_DEFAULTS.maxTradesPerDay, usd: 0 } } }), /daily trade limit/);
  assert.match(failing({ book: { ...freshArbBook(), recent: [{ gainEtn: -1500 }, { gainEtn: -900 }] } }), /lost 2400 ETN/);
  assert.match(failing({ paused: "KuCoin leg failed" }), /paused/);
  const wild = { kucoin: book(0.001935, 0.00194), htx: book(0.0021, 0.00211) }; // ~8% apart
  assert.match(arbChecks({ ...ctx, books: wild, plan: planArb(wild, fees) }).join(), /bad data/);
  const wide = { kucoin: { ...book(0.0019, 0.00194), bids: [[0.0018, 1e6]] }, htx: book(0.00197, 0.001975) };
  assert.match(arbChecks({ ...ctx, books: wide }).join(), /kucoin spread/);
});

test("second leg (buy): never pays more than break-even, never spends more than the budget", () => {
  const rules = { priceStep: 1e-6, sizeStep: 1, minSize: 100, minFunds: 0.1 };
  // sold 46,000 ETN on the other venue for $90 net; KuCoin asks at 0.00194
  const o = buyLegOrder({ asks: [[0.00194, 1e6]], budgetUsd: 90, breakEvenEtn: 46000, feePct: 0.1, rules });
  assert.equal(o.price, 0.00194);
  assert.ok(o.size >= 46000); // more ETN back than sold
  assert.ok(o.size * o.price * 1.001 <= 90 + 1e-9); // within the budget even if it all fills at the limit
  // the market has moved against us: asks above break-even -> the limit stays at break-even (no loss)
  const o2 = buyLegOrder({ asks: [[0.0021, 1e6]], budgetUsd: 90, breakEvenEtn: 46000, feePct: 0.1, rules });
  assert.ok(o2.price <= 90 / (1.001 * 46000));
  assert.ok(o2.size >= 46000);
});

test("second leg (sell): never sells below break-even, never sells more than it has", () => {
  const rules = { priceStep: 1e-6, sizeStep: 1, minSize: 100, minFunds: 0.1 };
  // bought 47,000 ETN for $90 on the other venue; get $90 back from KuCoin bids at 0.00197
  const o = sellLegOrder({ bids: [[0.00197, 1e6]], targetUsd: 90, availableEtn: 47000, feePct: 0.1, rules });
  assert.ok(o.size < 47000); // ETN left over = the profit
  assert.ok(o.size * o.price * 0.999 >= 90 - 1e-9);
  // bids collapsed below break-even -> the floor holds
  const o2 = sellLegOrder({ bids: [[0.0015, 1e6]], targetUsd: 90, availableEtn: 47000, feePct: 0.1, rules });
  assert.ok(o2.price >= 90 / (0.999 * 47000));
  assert.ok(o2.size <= 47000);
});

test("fills in net terms: KuCoin fees in USDT, HTX buy fees in ETN", () => {
  assert.deepEqual(netFill("buy", { dealSize: 1000, dealFunds: 2, fee: 0.002, feeCurrency: "USDT" }), { etn: 1000, usd: 2.002 });
  assert.deepEqual(netFill("buy", { dealSize: 1000, dealFunds: 2, fee: 2, feeCurrency: "ETN" }), { etn: 998, usd: 2 });
  assert.deepEqual(netFill("sell", { dealSize: 1000, dealFunds: 2, fee: 0.004, feeCurrency: "USDT" }), { etn: 1000, usd: 1.996 });
});
