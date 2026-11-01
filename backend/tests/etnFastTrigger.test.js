// Pure tests for services/etnFastTrigger.js. Run from backend/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fastTriggerReason } from "../services/etnFastTrigger.js";

const last = { mids: { USDT: 0.002, USDC: 0.002 }, kMid: 0.002, acted: false };

test("nothing happening: no early check", () => {
  assert.equal(fastTriggerReason({ mids: { USDT: 0.002, USDC: 0.002001 }, kMid: 0.002, last }), null);
});

test("no full check yet, or a pool unreadable: leave it to the regular check", () => {
  assert.equal(fastTriggerReason({ mids: { USDT: 0.0025, USDC: 0.002 }, kMid: 0.002, last: null }), null);
  assert.equal(fastTriggerReason({ mids: { USDT: 0, USDC: 0.002 }, kMid: 0.002, last }), null);
});

test("a pool moving 1%+ since the last check wakes it at once (urgent)", () => {
  const r = fastTriggerReason({ mids: { USDT: 0.002, USDC: 0.0025 }, kMid: 0.002, last }); // the 1 Nov 20:00 kind of spike
  assert.equal(r.urgent, true);
  assert.match(r.reason, /moved 25\.0%/);
});

test("a standing gap or KuCoin lag only re-wakes it if the last check traded or something moved", () => {
  const apart = { USDT: 0.002, USDC: 0.002036 }; // 1.8% apart
  const before = { ...last, mids: apart };
  assert.equal(fastTriggerReason({ mids: apart, kMid: 0.002, last: before }), null); // same as last time, nothing done
  assert.match(fastTriggerReason({ mids: apart, kMid: 0.002, last: { ...before, acted: true } }).reason, /1\.8% apart/); // keep working it
  assert.equal(fastTriggerReason({ mids: { USDT: 0.002, USDC: 0.002040 }, kMid: 0.002, last: before }).urgent, false); // moved 0.2%
  const lagging = { USDT: 0.00194, USDC: 0.00194 }; // 3% under KuCoin
  const lagLast = { ...last, mids: lagging };
  assert.equal(fastTriggerReason({ mids: lagging, kMid: 0.002, last: lagLast }), null);
  assert.match(fastTriggerReason({ mids: lagging, kMid: 0.00201, last: lagLast }).reason, /off KuCoin/); // KuCoin moved 0.5%
  assert.equal(fastTriggerReason({ mids: lagging, kMid: null, last: lagLast }), null); // KuCoin unavailable: no lag reason
});
