// Monthly AI cost summary (services/llmCost.js): token -> dollar maths, totals, and the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowCostUsd, summarizeCosts, formatCostReport, monthRange, previousMonth } from "../services/llmCost.js";

test("cost per usage row, from the price table", () => {
  // Haiku 5.5: 2,000 in + 300 out = $0.0002 + $0.00015
  assert.ok(Math.abs(rowCostUsd({ model: "claude-haiku-5-5", inputTokens: 2000, outputTokens: 300 }) - 0.00035) < 1e-12);
  // Sonnet 5.5 with cache: 1k in, 2k out, 25k cache write, 25k cache read
  const s = rowCostUsd({ model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 2000, cacheWriteTokens: 25000, cacheReadTokens: 25000 });
  assert.ok(Math.abs(s - (0.002 + 0.02 + 0.0625 + 0.005)) < 1e-12);
  assert.equal(rowCostUsd({ model: "some-other-model", inputTokens: 5 }), null); // shown, not guessed
});

test("monthly report: per kind, per member, and whether revenue covers it", () => {
  const rows = [
    { kind: "summary", model: "claude-sonnet-5-5", calls: 10, inputTokens: 300000, outputTokens: 15000 }, // $0.60 + $0.15
    { kind: "question", model: "claude-haiku-5-5", calls: 40, inputTokens: 1_000_000, outputTokens: 20000 }, // $0.10 + $0.01
    { kind: "digest", model: "claude-haiku-5-5", calls: 30, inputTokens: 60000, outputTokens: 9000 }, // $0.006 + $0.0045
  ];
  const s = summarizeCosts(rows);
  assert.equal(s.calls, 80);
  assert.ok(Math.abs(s.total - 0.8705) < 1e-9);
  const covered = formatCostReport({ month: "2026-11", rows, revenueEtn: 100000, etnUsd: 0.0012, activeMembers: 5 });
  assert.match(covered, /Contract summaries: 10 calls · \$0\.75 \(sonnet-5-5\)/);
  assert.match(covered, /Daily wallet checks: 30 calls · \$0\.01/);
  assert.match(covered, /\*Total: \$0\.87\*/);
  assert.match(covered, /Per active member \(5\): \$0\.17/);
  assert.match(covered, /100,000 ETN \(≈ \$120\.00\)/);
  assert.match(covered, /AI costs are 0\.7% of that — covered\./);
  assert.match(formatCostReport({ month: "2026-11", rows, revenueEtn: 0, etnUsd: 0.0012, activeMembers: 0 }), /swept this month: 0 ETN/);
  assert.match(formatCostReport({ month: "2026-12", rows: [], revenueEtn: null, etnUsd: null, activeMembers: 0 }), /No Claude calls this month/);
});

test("month bounds", () => {
  assert.deepEqual(monthRange("2026-11"), { from: "2026-11-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" });
  assert.deepEqual(monthRange("2026-12"), { from: "2026-12-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" });
  assert.throws(() => monthRange("2026-13"));
  assert.equal(previousMonth(new Date("2026-12-01T09:00:00Z")), "2026-11");
  assert.equal(previousMonth(new Date("2027-01-01T09:00:00Z")), "2026-12");
});
