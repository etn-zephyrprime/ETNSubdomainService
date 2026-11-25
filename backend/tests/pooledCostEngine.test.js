// services/pooledCostEngine.js — pooled average-cost (Section 104) replay. Covers the two places it
// must differ from FIFO (the average, and a single pooled realized event per disposal), plus the
// zero-cost shortfall and farm lock/unlock behavior it must share with FIFO.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replayPooled, replayPooledCheckpoints } from "../services/pooledCostEngine.js";
import { replayFifo } from "../services/fifoLotEngine.js";

const START = new Date("2025-01-01T00:00:00Z");
const END = new Date("2026-01-01T00:00:00Z");
const at = (day) => new Date(Date.UTC(2025, 0, day));
const TOKEN = "0xtoken";

// Buy 10 @ $1, buy 10 @ $3 (average $2), sell 5 for $20.
const averageExample = [
  { kind: "in", tokenAddress: TOKEN, txHash: "a", timestamp: at(2), quantity: "10", unitCostUsd: "1" },
  { kind: "in", tokenAddress: TOKEN, txHash: "b", timestamp: at(3), quantity: "10", unitCostUsd: "3" },
  { kind: "out", tokenAddress: TOKEN, txHash: "c", timestamp: at(4), quantity: "5", proceedsUsd: "20" },
];

test("a sale is costed at the pool's average unit cost, not the oldest lot", () => {
  const { closing } = replayPooled(averageExample, START, END);
  const [event] = closing.realizedEvents;
  assert.equal(event.costBasisUsd.toString(), "10");
  assert.equal(event.realizedPnlUsd.toString(), "10");
  assert.equal(event.lotId, null);
});

test("FIFO costs the same sale at the oldest lot, so the two models genuinely differ", () => {
  const fifo = replayFifo(averageExample, START, END).closing.realizedEvents;
  assert.equal(fifo.reduce((sum, e) => sum + Number(e.costBasisUsd), 0), 5);
});

test("remaining holdings keep the pool's average unit cost after a partial sale", () => {
  const { closing } = replayPooled(averageExample, START, END);
  const [lot] = closing.lots;
  assert.equal(lot.quantityRemaining.toString(), "15");
  assert.equal(lot.unitCostUsd.toString(), "2");
});

test("buying after a sale moves the average for later sales", () => {
  const events = [
    ...averageExample,
    { kind: "in", tokenAddress: TOKEN, txHash: "d", timestamp: at(5), quantity: "15", unitCostUsd: "4" },
    { kind: "out", tokenAddress: TOKEN, txHash: "e", timestamp: at(6), quantity: "10", proceedsUsd: "0" },
  ];
  const { closing } = replayPooled(events, START, END);
  // Pool before the last sale: 15 @ $2 + 15 @ $4 = 90 for 30 units, average $3; 10 sold = $30 basis.
  assert.equal(closing.realizedEvents[1].costBasisUsd.toString(), "30");
});

test("a sale beyond the held quantity is zero-cost for the shortfall, but keeps all proceeds", () => {
  const events = [
    { kind: "in", tokenAddress: TOKEN, txHash: "a", timestamp: at(2), quantity: "4", unitCostUsd: "5" },
    { kind: "out", tokenAddress: TOKEN, txHash: "b", timestamp: at(3), quantity: "10", proceedsUsd: "100" },
  ];
  const [event] = replayPooled(events, START, END).closing.realizedEvents;
  assert.equal(event.costBasisUsd.toString(), "20");
  assert.equal(event.proceedsUsd.toString(), "100");
  assert.equal(event.realizedPnlUsd.toString(), "80");
});

test("a self-transfer removes cost at the average without a realized event", () => {
  const events = [
    ...averageExample.slice(0, 2),
    { kind: "self_out", tokenAddress: TOKEN, txHash: "s", timestamp: at(4), quantity: "5" },
  ];
  const { closing } = replayPooled(events, START, END);
  assert.equal(closing.realizedEvents.length, 0);
  assert.equal(closing.lots[0].quantityRemaining.toString(), "15");
  assert.equal(closing.lots[0].unitCostUsd.toString(), "2");
});

test("a farm lock/unlock keeps the pool's cost basis intact and records no realized event", () => {
  const events = [
    ...averageExample.slice(0, 2),
    { kind: "lock", tokenAddress: TOKEN, txHash: "l", timestamp: at(4), quantity: "10" },
    { kind: "unlock", tokenAddress: TOKEN, txHash: "u", timestamp: at(5), quantity: "10", fallbackUnitCostUsd: "0" },
  ];
  const { closing } = replayPooled(events, START, END);
  assert.equal(closing.realizedEvents.length, 0);
  assert.equal(closing.lots[0].quantityRemaining.toString(), "20");
  assert.equal(closing.lots[0].unitCostUsd.toString(), "2");
});

test("opening inventory reflects only events before periodStart", () => {
  const { opening, closing } = replayPooled(averageExample, at(4), END);
  assert.equal(opening.lots[0].quantityRemaining.toString(), "20");
  assert.equal(closing.lots[0].quantityRemaining.toString(), "15");
});

test("checkpoint replay matches a point-in-time replay at each day end", () => {
  const snapshots = replayPooledCheckpoints(averageExample, [at(4), at(5)]);
  assert.equal(snapshots[0].lots[0].quantityRemaining.toString(), "20");
  assert.equal(snapshots[0].newRealizedEvents.length, 0);
  assert.equal(snapshots[1].lots[0].quantityRemaining.toString(), "15");
  assert.equal(snapshots[1].newRealizedEvents.length, 1);
  assert.equal(snapshots[1].realizedPnlUsdCumulative.toString(), "10");
});

test("checkpoints past the last event still get a snapshot of the final state", () => {
  const snapshots = replayPooledCheckpoints(averageExample, [at(10)]);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].lots[0].quantityRemaining.toString(), "15");
});
