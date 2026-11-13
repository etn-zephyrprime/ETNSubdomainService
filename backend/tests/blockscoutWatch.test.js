import test from "node:test";
import assert from "node:assert/strict";
import { runSchemaChecks, runBlockscoutWatch, getIngestionPauseReason, missingFields } from "../utils/blockscoutWatch.js";
import { normalizeBlockscoutTokens } from "../utils/blockscoutNormalize.js";

const v12Token = { address_hash: "0xT", holders_count: "5", symbol: "T", decimals: "18", type: "ERC-20", name: "Tok", total_supply: "1" };
const party = { hash: "0xA" };
const raw = {
  "/config/backend-version": { backend_version: "v12.0.4" },
  "/tokens?type=ERC-20": { items: [{ ...v12Token }] },
  token: { ...v12Token },
  "token-balances": [{ token: { ...v12Token }, value: "1" }],
  "token-transfers": { items: [{ block_number: 1, transaction_hash: "0x1", timestamp: "t", log_index: 0, from: party, to: party, token: { ...v12Token }, total: { value: "1" } }] },
  transactions: { items: [{ hash: "0x1", block_number: 1, timestamp: "t", from: party, to: party, value: "0", status: "ok", result: "success", fee: { value: "1" }, gas_used: "1", gas_price: "1" }] },
  "internal-transactions": { items: [{ transaction_hash: "0x1", block_number: 1, timestamp: "t", from: party, to: party, value: "0", success: true, type: "call" }] },
};
function fakeFetch({ normalize = true, version = "v12.0.4" } = {}) {
  return async (path) => {
    const key = path === "/config/backend-version" || path.startsWith("/tokens?") ? path : path.startsWith("/tokens/") ? "token" : path.split("/").pop();
    let json = structuredClone(raw[key]);
    if (key === "/config/backend-version") json = { backend_version: version };
    return normalize ? normalizeBlockscoutTokens(json) : json;
  };
}
function memState(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null),
    advance: async (k, from, to) => {
      const cur = m.has(k) ? m.get(k) : null;
      if (JSON.stringify(cur) !== JSON.stringify(from)) return false;
      m.set(k, structuredClone(to));
      return true;
    },
  };
}

test("normalized v12 responses pass every check", async () => {
  const r = await runSchemaChecks({ fetchJson: fakeFetch() });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test("raw v12 responses (this incident) fail, with replacement hints", async () => {
  const r = await runSchemaChecks({ fetchJson: fakeFetch({ normalize: false }) });
  assert.equal(r.ok, false);
  const list = r.failures.find((f) => f.name === "token list");
  assert.deepEqual(list.missing, ["address (now address_hash?)", "holders (now holders_count?)"]);
  assert.ok(r.failures.find((f) => f.name === "token transfers").missing[0].startsWith("token.address (now token.address_hash?)"));
});

test("unreachable endpoints are skipped, not failures", async () => {
  const r = await runSchemaChecks({ fetchJson: async () => { throw new Error("timeout"); } });
  assert.equal(r.ok, true);
  assert.equal(r.skipped.length, 6);
});

test("missingFields handles nesting", () => {
  assert.deepEqual(missingFields({ a: { b: 1 } }, ["a.b", "a.c", "d"]), ["a.c", "d"]);
});

test("version: first run records a baseline silently, a change alerts once", async () => {
  const state = memState();
  const sent = [];
  const send = async (_c, t) => sent.push(t);
  process.env.BLOCKSCOUT_WATCH_CHAT_ID = "1";
  await runBlockscoutWatch({ fetchJson: fakeFetch({ version: "v12.0.4" }), state, send });
  assert.equal(sent.length, 0);
  const s = await runBlockscoutWatch({ fetchJson: fakeFetch({ version: "v12.1.0" }), state, send });
  assert.equal(s.versionChanged, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /v12\.0\.4 → \*v12\.1\.0\*/);
  await runBlockscoutWatch({ fetchJson: fakeFetch({ version: "v12.1.0" }), state, send });
  assert.equal(sent.length, 1);
});

test("field failure pauses ingestion, alerts once, and recovery clears it", async () => {
  const state = memState();
  const sent = [];
  const send = async (_c, t) => sent.push(t);
  process.env.BLOCKSCOUT_WATCH_CHAT_ID = "1";
  delete process.env.BLOCKSCOUT_WATCH_PAUSE;

  await runBlockscoutWatch({ fetchJson: fakeFetch({ normalize: false }), state, send });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /paused/);
  const reason = await getIngestionPauseReason({ getState: state.get });
  assert.match(reason, /token list: address \(now address_hash\?\)/);

  await runBlockscoutWatch({ fetchJson: fakeFetch({ normalize: false }), state, send });
  assert.equal(sent.length, 1, "same failure doesn't re-alert");

  process.env.BLOCKSCOUT_WATCH_PAUSE = "off";
  assert.equal(await getIngestionPauseReason({ getState: state.get }), null);
  delete process.env.BLOCKSCOUT_WATCH_PAUSE;

  await runBlockscoutWatch({ fetchJson: fakeFetch(), state, send });
  assert.equal(sent.length, 2);
  assert.match(sent[1], /passing again/);
  assert.equal(await getIngestionPauseReason({ getState: state.get }), null);
});

test("a lost compare-and-set race sends nothing (another server has it)", async () => {
  const state = memState();
  state.advance = async () => false;
  const sent = [];
  await runBlockscoutWatch({ fetchJson: fakeFetch({ normalize: false }), state, send: async (_c, t) => sent.push(t) });
  assert.equal(sent.length, 0);
});
