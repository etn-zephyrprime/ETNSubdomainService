// Pure tests for recentActivityService.js's farm reward-claim detection. Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFarmRewardClaim } from "../services/recentActivityService.js";

test("a farm withdrawal that took no liquidity out is a reward claim", () => {
  assert.equal(isFarmRewardClaim({ event_type: "farm_withdraw", raw_args: { amount0Withdrawn: "0", amount1Withdrawn: "0" } }), true);
  assert.equal(isFarmRewardClaim({ event_type: "farm_withdraw", raw_args: { liquidityWithdrawn: "0", amount0Withdrawn: "0", amount1Withdrawn: "0" } }), true);
  assert.equal(isFarmRewardClaim({ event_type: "farm_withdraw", raw_args: { amount0Withdrawn: "5", amount1Withdrawn: "9" } }), false);
  assert.equal(isFarmRewardClaim({ event_type: "farm_withdraw", raw_args: { liquidityWithdrawn: "12" } }), false); // the recorded liquidity decides
  assert.equal(isFarmRewardClaim({ event_type: "farm_deposit", raw_args: {} }), false);
});
