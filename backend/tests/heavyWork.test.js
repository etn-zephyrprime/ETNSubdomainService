// utils/heavyWork.js — the gate for memory-heavy work (the 2026-11-11 heap OOM): a concurrency cap, FIFO
// queueing, re-entrancy (nested heavy work must not deadlock) and slots freed even when a job throws.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runHeavy, heavyWorkStats, _resetHeavyWork } from "../utils/heavyWork.js";

beforeEach(() => _resetHeavyWork());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("at most 2 run at once; the rest wait their turn, in order", async () => {
  let now = 0, peak = 0;
  const order = [];
  const job = (id) => runHeavy(`job${id}`, async () => {
    now++;
    peak = Math.max(peak, now);
    order.push(id);
    await sleep(20);
    now--;
    return id;
  });
  const results = await Promise.all([1, 2, 3, 4, 5].map(job));
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
  assert.deepEqual(heavyWorkStats(), { running: 0, waiting: 0, peakWaiting: 3 });
});

test("nested heavy work runs in its parent's slot (no deadlock with both slots taken)", async () => {
  // two parents take both slots; each starts a child — waiting for a third slot would hang forever
  const parent = (id) => runHeavy("parent", async () => {
    await sleep(5);
    return runHeavy("child", async () => `child of ${id}`);
  });
  const out = await Promise.race([Promise.all([parent(1), parent(2)]), sleep(2000).then(() => "deadlock")]);
  assert.deepEqual(out, ["child of 1", "child of 2"]);
});

test("a job that throws still frees its slot", async () => {
  await assert.rejects(runHeavy("bad", async () => { throw new Error("boom"); }), /boom/);
  await assert.rejects(runHeavy("bad", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await runHeavy("after", async () => "ran"), "ran");
  assert.equal(heavyWorkStats().running, 0);
});
