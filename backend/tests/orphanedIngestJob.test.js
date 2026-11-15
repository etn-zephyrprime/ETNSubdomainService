import test from "node:test";
import assert from "node:assert/strict";
import { isOrphanedIngestJob } from "../services/pnlIngestion.js";

const now = Date.parse("2026-11-15T12:00:00Z");
const ago = (min) => new Date(now - min * 60 * 1000).toISOString();

test("a RUNNING job untouched for over 15 min with no run in this process is orphaned", () => {
  assert.equal(isOrphanedIngestJob({ status: "RUNNING", updated_at: ago(16) }, { now }), true);
  assert.equal(isOrphanedIngestJob({ status: "RUNNING", updated_at: ago(600) }, { now }), true);
});

test("a recently updated RUNNING job is live (e.g. the old instance during a deploy overlap)", () => {
  assert.equal(isOrphanedIngestJob({ status: "RUNNING", updated_at: ago(3) }, { now }), false);
});

test("a run in this process is never orphaned, however quiet", () => {
  assert.equal(isOrphanedIngestJob({ status: "RUNNING", updated_at: ago(600) }, { now, runningHere: true }), false);
});

test("only RUNNING rows can be orphaned", () => {
  for (const status of ["COMPLETE", "FAILED"]) assert.equal(isOrphanedIngestJob({ status, updated_at: ago(600) }, { now }), false);
  assert.equal(isOrphanedIngestJob(null, { now }), false);
});
