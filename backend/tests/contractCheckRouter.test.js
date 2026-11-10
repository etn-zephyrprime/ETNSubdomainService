// Contract Check API: input validation, the wallet-signature gate, and the rate limiter — offline (every
// request here is rejected before any analysis or Claude call).
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import contractCheckRouter from "../utils/contractCheckRouter.js";
import { createRateLimiter } from "../utils/rateLimit.js";

delete process.env.DATABASE_URL;

async function withServer(fn) {
  const app = express();
  app.use("/api", contractCheckRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test("facts + search are Core tier: no valid wallet signature -> 401 before anything is analysed", async () => {
  await withServer(async (base) => {
    const core = "0x309B916b3A90cb3E071697Ea9680e9217A30066f";
    assert.equal((await fetch(`${base}/contract-check/${core}`)).status, 401);
    assert.equal((await fetch(`${base}/contract-check/${core}?wallet=0x3Fd2e5B4AC0efF6DFDF2446abddAB3f66B425099&signature=0xdead&timestamp=${Date.now()}`)).status, 401);
    assert.equal((await fetch(`${base}/contract-check/search?q=core`)).status, 401);
  });
});

test("explain: no valid wallet signature -> 401 before anything is analysed or sent to Claude", async () => {
  await withServer(async (base) => {
    const post = (body) => fetch(`${base}/contract-check/explain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ address: "0x309B916b3A90cb3E071697Ea9680e9217A30066f" })).status, 401);
    const wallet = "0x3Fd2e5B4AC0efF6DFDF2446abddAB3f66B425099";
    assert.equal((await post({ wallet, signature: "0xdead", timestamp: Date.now(), address: "0x309B916b3A90cb3E071697Ea9680e9217A30066f" })).status, 401);
    assert.equal((await post({ wallet, signature: "0xdead", timestamp: Date.now() - 2 * 3600 * 1000, address: "x" })).status, 401); // expired
  });
});

test("rate limiter: max per window per key, then a retry-after", () => {
  const hit = createRateLimiter({ max: 2, windowMs: 60000 });
  assert.equal(hit("a").ok, true);
  assert.equal(hit("a").ok, true);
  const third = hit("a");
  assert.equal(third.ok, false);
  assert.ok(third.retryAfterSec > 0 && third.retryAfterSec <= 60);
  assert.equal(hit("b").ok, true); // per key
});
