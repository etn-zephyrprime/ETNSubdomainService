// Pure contract-maths tests for services/scenarioRewards.js. Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { durationMultiplier, blocksServedAfterTopUp, projectFarmRewards, projectStakingRewards, MAX_BLOCKS_FOR_BONUS } from "../services/scenarioRewards.js";

test("duration multiplier matches the contract's calculateDurationMultiplier", () => {
  // Values read live from YieldFarm.calculateDurationMultiplier: 0 -> 10000, 1e6 -> 12378,
  // 3,153,600 -> 17500, 6,307,200 -> 25000, 9e6 -> 25000.
  assert.equal(durationMultiplier(0), 1);
  assert.equal(durationMultiplier(1_000_000), 1.2378);
  assert.equal(durationMultiplier(3_153_600), 1.75);
  assert.equal(durationMultiplier(MAX_BLOCKS_FOR_BONUS), 2.5);
  assert.equal(durationMultiplier(9_000_000), 2.5);
});

test("top-up dilutes blocks served by the old share of the position", () => {
  assert.equal(blocksServedAfterTopUp(1000, 100, 100), 500); // doubling halves it
  assert.equal(blocksServedAfterTopUp(1000, 300, 100), 750);
  assert.equal(blocksServedAfterTopUp(1000, 100, 0), 1000);
});

test("farm projection: share, multiplier at collection, partner rewards without multipliers", () => {
  const r = projectFarmRewards({ farmLiquidity: 1000, farmerLiquidity: 100, farmRewardPerBlock: 1, pendingBase: 5, blocksServed: 0, boltMultiplier: 1.15, horizonBlocks: 100, partnerPerBlock: 2, partnerBlocksLeft: 50, pendingPartner: 1 });
  assert.equal(r.share, 0.1);
  const mult = durationMultiplier(100);
  assert.ok(Math.abs(r.rewardTokens - (5 + 0.1 * 100) * 1.15 * mult) < 1e-9);
  assert.ok(Math.abs(r.partnerTokens - (1 + 2 * 0.1 * 50)) < 1e-9); // capped at the 50 blocks left, no multipliers
  const doubled = projectFarmRewards({ farmLiquidity: 1000, farmerLiquidity: 100, farmRewardPerBlock: 1, blocksServed: 0, boltMultiplier: 1, horizonBlocks: 100, othersScale: 2 });
  assert.ok(Math.abs(doubled.share - 100 / 1900) < 1e-12); // everyone else doubles
});

test("staking projection stops at the funded end block", () => {
  const r = projectStakingRewards({ rewardPerBlock: 1, blocksLeftFunded: 10, weight: 50, totalWeight: 100, horizonBlocks: 100 });
  assert.equal(r.share, 0.5);
  assert.equal(r.coreTokens, 5);
});
