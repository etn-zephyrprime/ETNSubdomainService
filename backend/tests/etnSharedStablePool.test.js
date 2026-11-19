import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateSharedStable, sharedStableAvailable } from "../services/etnSharedStablePool.js";

test("gap and hedge can transfer shared stablecoin without changing the pool total", () => {
  const state = {
    gap: { stables: { USDT: 0, USDC: 90 } },
    hedgeLive: { stables: { USDT: 0, USDC: 0 } },
  };

  assert.equal(sharedStableAvailable(state, "USDC"), 90);
  assert.equal(allocateSharedStable(state, "hedge", "USDC", 45), true);
  assert.deepEqual(state.gap.stables, { USDT: 0, USDC: 45 });
  assert.deepEqual(state.hedgeLive.stables, { USDT: 0, USDC: 45 });
  state.hedgeLive.stables.USDC -= 45;
  assert.equal(sharedStableAvailable(state, "USDC"), 45);

  assert.equal(allocateSharedStable(state, "gap", "USDC", 45), true);
  assert.equal(state.gap.stables.USDC, 45);
  assert.equal(state.hedgeLive.stables.USDC, 0);
});

test("shared availability excludes stablecoin spent by an unfinished hedge leg", () => {
  const state = {
    gap: { stables: { USDT: 0, USDC: 90 } },
    hedgeLive: { stables: { USDT: 0, USDC: 0 } },
    hedgeLeg: { dir: "buyOnEs", stable: "USDC", esUsd: 45 },
  };

  assert.equal(sharedStableAvailable(state, "USDC"), 45);
  assert.equal(allocateSharedStable(state, "hedge", "USDC", 50), false);
  assert.equal(state.gap.stables.USDC, 90);
});

test("shared availability excludes an unfinished gap-book rebalance and protected catch-up cash", () => {
  const state = {
    gap: { stables: { USDT: 100, USDC: 0 } },
    hedgeLive: { stables: { USDT: 0, USDC: 0 } },
    cu: { cash: { USDT: 30, USDC: 0 } },
    gapRebalancePending: { from: "USDT", usdIn: 40 },
  };

  assert.equal(sharedStableAvailable(state, "USDT"), 60);
  assert.equal(sharedStableAvailable(state, "USDC"), 0);
});

test("insufficient shared funds are not reallocated", () => {
  const state = {
    gap: { stables: { USDT: 0, USDC: 20 } },
    hedgeLive: { stables: { USDT: 0, USDC: 5 } },
  };

  assert.equal(allocateSharedStable(state, "hedge", "USDC", 30), false);
  assert.equal(state.gap.stables.USDC, 20);
  assert.equal(state.hedgeLive.stables.USDC, 5);
});
