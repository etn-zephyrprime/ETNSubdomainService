import test from "node:test";
import assert from "node:assert/strict";
import { dropChance } from "../utils/tapHunt.js";

test("drop chance steps down through the four stages by leader's distinct words", () => {
  assert.equal(dropChance(0), 1 / 500);
  assert.equal(dropChance(5), 1 / 500);
  assert.equal(dropChance(6), 1 / 750);
  assert.equal(dropChance(11), 1 / 750);
  assert.equal(dropChance(12), 1 / 1000);
  assert.equal(dropChance(17), 1 / 1000);
  assert.equal(dropChance(18), 1 / 1500);
  assert.equal(dropChance(24), 1 / 1500);
});
