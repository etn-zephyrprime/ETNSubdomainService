import test from "node:test";
import assert from "node:assert/strict";
import { fetchBlockscoutJson, rateLimitDelayMs, RATE_LIMIT_RETRIES } from "../utils/blockscoutClient.js";

const res = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

test("rateLimitDelayMs honors Retry-After, else backs off 5s→60s", () => {
  assert.equal(rateLimitDelayMs(res(429, null, { "retry-after": "7" }), 0), 7000);
  assert.equal(rateLimitDelayMs(res(429, null, { "retry-after": "999" }), 0), 120000);
  assert.equal(rateLimitDelayMs(res(429, null), 0), 5000);
  assert.equal(rateLimitDelayMs(res(429, null), 2), 20000);
  assert.equal(rateLimitDelayMs(res(429, null), 10), 60000);
});

test("a 429 is waited out (Retry-After) instead of failing", async (t) => {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  let calls = 0;
  globalThis.fetch = async () => (++calls <= 3 ? res(429, null, { "retry-after": "0.01" }) : res(200, { items: [{ address_hash: "0xA", holders_count: "1", decimals: "18" }] }));
  const json = await fetchBlockscoutJson("/tokens");
  assert.equal(calls, 4);
  assert.equal(json.items[0].address, "0xA", "still normalized");
});

test("persistent 429 eventually gives up", async (t) => {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  let calls = 0;
  globalThis.fetch = async () => (calls++, res(429, null, { "retry-after": "0.001" }));
  await assert.rejects(fetchBlockscoutJson("/tokens"), /HTTP 429/);
  assert.ok(calls >= RATE_LIMIT_RETRIES + 1);
});
