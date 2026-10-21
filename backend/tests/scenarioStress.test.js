// Pure-maths tests for the scenario stress test (services/scenarioStressTest.js).
// Run from backend/: npm test   (node --test discovers tests/*.test.js)
import { test } from "node:test";
import assert from "node:assert/strict";
import { stressComponents, normalizeShocks, usdMultiplier, PEGGED_USD } from "../services/scenarioStressTest.js";

const BOLT = "0x043faa1b5c5fc9a7dc35171f290c29ecde0ccff1";
const DYNO = "0xee432c220273e4f949007b4c1946562826efa055";
const USDT = [...PEGGED_USD.keys()][0];
const components = [
  { kind: "token", key: "NATIVE", tokens: ["NATIVE"], baselineUsd: "1000" },
  { kind: "token", key: BOLT, tokens: [BOLT], baselineUsd: "500" },
  { kind: "token", key: USDT, tokens: [USDT], baselineUsd: "200" },
  { kind: "lp", key: "pair", tokens: ["NATIVE", BOLT], baselineUsd: "300" },
  { kind: "farm", key: "farm", tokens: [BOLT, DYNO], baselineUsd: "400" },
  { kind: "staking", key: "stake", tokens: [BOLT], baselineUsd: "100" },
];
const total = (rows, f) => rows.reduce((s, r) => s + Number(r[f]), 0);

test("zero shocks reproduce the baseline exactly", () => {
  const rows = stressComponents(components, normalizeShocks({}));
  for (const r of rows) assert.equal(r.scenarioUsd, String(Number(r.baselineUsd)));
  assert.equal(total(rows, "scenarioUsd"), total(components, "baselineUsd"));
});

test("two-layer model: a token flat against ETN falls with ETN; pegged tokens hold $1", () => {
  const s = normalizeShocks({ etnPct: -30 });
  assert.equal(usdMultiplier("NATIVE", s), 0.7);
  assert.equal(usdMultiplier(BOLT, s), 0.7);
  assert.equal(usdMultiplier(USDT, s), 1);
  const s2 = normalizeShocks({ etnPct: -30, tokenPct: { [BOLT]: 50 } });
  assert.ok(Math.abs(usdMultiplier(BOLT, s2) - 1.05) < 1e-12); // 0.7 x 1.5
});

test("LP / farm follow the constant-product curve: sqrt(m0 x m1)", () => {
  const s = normalizeShocks({ tokenPct: { [BOLT]: 300 } }); // BOLT x4 vs ETN, ETN flat
  const [, , , lp] = stressComponents(components, s);
  assert.ok(Math.abs(Number(lp.scenarioUsd) - 300 * 2) < 1e-9); // sqrt(1 x 4) = 2
  // ...which is less than holding the two tokens 50/50 (150 x 1 + 150 x 4 = 750): that gap is IL.
  assert.ok(Number(lp.scenarioUsd) < 750);
});

test("shocks at or below -100% are rejected", () => {
  assert.throws(() => normalizeShocks({ etnPct: -100 }));
  assert.throws(() => normalizeShocks({ tokenPct: { [BOLT]: -150 } }));
});
