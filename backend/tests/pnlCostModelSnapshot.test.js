// services/pnlSnapshotService.js — the cost-model toggle's combine rules. A pooled wallet has no ETN
// figures, so a combined ETN total must be null rather than a silently-zero sum.
import { test } from "node:test";
import assert from "node:assert/strict";
import { combineLivePnlSnapshots, normalizeCostModel } from "../services/pnlSnapshotService.js";

const base = {
  holdings: [],
  realizedByToken: [],
  realizedByTokenEtn: [],
  currentValueUsd: "100",
  unrealizedPnlUsd: "10",
  realizedPnlUsd: "5",
  gasUsd: "1",
  gasEtn: "2",
  pricingIncomplete: false,
};

test("combined ETN realized P&L is the sum when every wallet has ETN figures", () => {
  const combined = combineLivePnlSnapshots([
    { ...base, costModel: "fifo", realizedPnlEtn: "3" },
    { ...base, costModel: "fifo", realizedPnlEtn: "4" },
  ]);
  assert.equal(combined.realizedPnlEtn, "7");
});

test("combined ETN realized P&L is null when any wallet is pooled (no ETN basis)", () => {
  const combined = combineLivePnlSnapshots([
    { ...base, costModel: "fifo", realizedPnlEtn: "3" },
    { ...base, costModel: "pooled", realizedPnlEtn: null, realizedByTokenEtn: null },
  ]);
  assert.equal(combined.realizedPnlEtn, null);
  assert.equal(combined.realizedByTokenEtn, null);
  assert.equal(combined.realizedPnlUsd, "10");
});

test("only the explicit pooled value selects pooled; anything else is FIFO", () => {
  assert.equal(normalizeCostModel("pooled"), "pooled");
  assert.equal(normalizeCostModel("fifo"), "fifo");
  assert.equal(normalizeCostModel("bogus"), "fifo");
  assert.equal(normalizeCostModel(undefined), "fifo");
});
