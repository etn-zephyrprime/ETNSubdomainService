// Pure-maths tests for services/scenarioBacktest.js. Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDailySeries, coverageOf, scheduleBuys, simulateBuys } from "../services/scenarioBacktest.js";

const d = (s) => new Date(`${s}T00:00:00Z`);

test("gap rule: missing and carry-forward days reuse the last real close, and are counted", () => {
  const pts = [
    { timestamp: d("2026-01-01"), price_usd: "1", source: "kucoin" },
    { timestamp: d("2026-01-03"), price_usd: "1", source: "carry-forward" },
    { timestamp: d("2026-01-04"), price_usd: "2", source: "kucoin" },
  ];
  const s = buildDailySeries(pts, d("2025-12-30"), d("2026-01-05"));
  assert.equal(s.has("2025-12-30"), false); // before the first real price: absent, never extrapolated
  assert.deepEqual(s.get("2026-01-02"), { price: 1, carried: true });
  assert.deepEqual(s.get("2026-01-04"), { price: 2, carried: false });
  assert.deepEqual(s.get("2026-01-05"), { price: 2, carried: true });
  assert.deepEqual(coverageOf(s), { days: 5, carriedDays: 3, longestCarried: 2 });
});

test("DCA schedules", () => {
  assert.equal(scheduleBuys(d("2026-01-01"), d("2026-01-29"), "weekly").length, 5);
  assert.deepEqual(scheduleBuys(d("2026-01-31"), d("2026-04-30"), "monthly").map((x) => x.toISOString().slice(0, 10)), ["2026-01-28", "2026-02-28", "2026-03-28", "2026-04-28"]);
  assert.equal(scheduleBuys(d("2026-01-01"), d("2026-06-01"), "lump").length, 1);
});

test("buys: USD amount, ETN cost, and the buy tax taken off the tokens received", () => {
  const tok = new Map([["2026-01-01", { price: 2, carried: false }]]);
  const etn = new Map([["2026-01-01", { price: 0.5, carried: false }]]);
  const [b] = simulateBuys({ buys: [d("2026-01-01")], amountType: "usd", amount: 100, tokenSeries: tok, etnSeries: etn, taxBpsFor: () => 400 });
  assert.equal(b.costUsd, 100);
  assert.equal(b.costEtn, 200);
  assert.ok(Math.abs(b.tokens - 48) < 1e-9); // 50 bought, 4% tax
  const [t] = simulateBuys({ buys: [d("2026-01-01")], amountType: "tokens", amount: 48, tokenSeries: tok, etnSeries: etn, taxBpsFor: () => 400 });
  assert.ok(Math.abs(t.costUsd - 100) < 1e-9); // ending up with 48 after tax costs $100
});
