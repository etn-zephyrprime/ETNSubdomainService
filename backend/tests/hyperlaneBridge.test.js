// The Hyperlane tracker's cursor and self-heal (utils/hyperlaneBridge.js), with a stubbed explorer and chain:
// it must not skip blocks the explorer hasn't indexed yet, and must rebuild when events stop adding up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { refreshHyperlaneBridge, driftedTokens, HYPERLANE_TOKENS } from "../utils/hyperlaneBridge.js";

const IFACE = new ethers.Interface(["function totalSupply() view returns (uint256)", "function domains() view returns (uint32[])"]);
const SENT = ethers.id("SentTransferRemote(uint32,bytes32,uint256)");
const usd = (n) => ethers.toBeHex(ethers.parseUnits(String(n), 6), 32);
const log = (block, amountHex, domain = 1) => ({ topics: ["0x", ethers.toBeHex(domain, 32)], data: amountHex, timeStamp: ethers.toBeHex(1762800000 + block), blockNumber: ethers.toBeHex(block) });

/** Chain at `head`; USDT has `received` transfers in (supply = their sum); the explorer has indexed up to `indexedTo`. */
function world({ head, indexedTo, received }) {
  const supply = received.reduce((s, r) => s + r.usd, 0);
  const provider = {
    getBlockNumber: async () => head,
    getBalance: async () => 0n,
    call: async ({ to, data }) => {
      const fn = IFACE.parseTransaction({ data }).name;
      const isUsdt = to.toLowerCase() === HYPERLANE_TOKENS[0].address.toLowerCase();
      if (fn === "totalSupply") return IFACE.encodeFunctionResult(fn, [isUsdt ? ethers.parseUnits(String(supply), 6) : 0n]);
      return IFACE.encodeFunctionResult(fn, [[1]]);
    },
  };
  const fetchImpl = async (url) => {
    const q = new URL(url).searchParams;
    const from = Number(q.get("fromBlock")), to = Math.min(Number(q.get("toBlock")), indexedTo);
    const isUsdt = q.get("address").toLowerCase() === HYPERLANE_TOKENS[0].address.toLowerCase();
    const isReceived = q.get("topic0") !== SENT;
    const result = isUsdt && isReceived ? received.filter((r) => r.block >= from && r.block <= to).map((r) => log(r.block, usd(r.usd))) : [];
    return { ok: true, json: async () => (result.length ? { result } : { message: "No logs found", result: [] }) };
  };
  return { provider, fetchImpl };
}

test("cursor stays CONFIRM_LAG blocks below the head, so a not-yet-indexed transfer isn't skipped", async () => {
  let store = { events: [], cursors: {}, current: {} };
  const io = { getData: async () => store, setData: async (d) => { store = d; } };
  // a transfer at block 995, head 1000, explorer only indexed to 990
  const received = [{ block: 500, usd: 100 }, { block: 995, usd: 50 }];
  await refreshHyperlaneBridge({ ...world({ head: 1000, indexedTo: 990, received }), ...io, now: Date.parse("2026-11-11T00:00:00Z") });
  assert.equal(store.cursors.USDT, 940); // 1000 - 60
  // later the explorer catches up and the head moves on: the transfer at 995 is picked up, not skipped
  await refreshHyperlaneBridge({ ...world({ head: 1200, indexedTo: 1200, received }), ...io, now: Date.parse("2026-11-11T00:10:00Z") });
  assert.deepEqual(store.events.filter((e) => e[1] === 0).map((e) => e[5]), [500, 995]);
  assert.deepEqual(driftedTokens(store.events, store.current), []);
});

test("self-heal: events that don't add up to the supply are rebuilt from the full history", async () => {
  // stored data that already missed the transfer at 700 (the old bug): cursor past it, net 100 vs supply 130
  const received = [{ block: 500, usd: 100 }, { block: 700, usd: 30 }];
  let store = { events: [[1762800500, 0, 1, 0, 100, 500]], cursors: { USDT: 900, USDC: 900, ETN: 900 }, current: {} };
  const io = { getData: async () => store, setData: async (d) => { store = d; } };
  await refreshHyperlaneBridge({ ...world({ head: 1000, indexedTo: 1000, received }), ...io, now: Date.parse("2026-11-12T00:00:00Z") });
  assert.deepEqual(store.events.filter((e) => e[1] === 0).map((e) => [e[5], e[4]]), [[500, 100], [700, 30]]);
  assert.deepEqual(driftedTokens(store.events, store.current), []);
});

test("supply is read at the same block the events stop at (a brand-new transfer isn't drift)", async () => {
  const seen = [];
  const w = world({ head: 1000, indexedTo: 1000, received: [{ block: 500, usd: 100 }] });
  const provider = { ...w.provider, call: async (tx) => { seen.push(tx.blockTag); return w.provider.call(tx); } };
  let store = { events: [], cursors: {}, current: {} };
  await refreshHyperlaneBridge({ provider, fetchImpl: w.fetchImpl, getData: async () => store, setData: async (d) => { store = d; }, now: Date.parse("2026-11-13T00:00:00Z") });
  assert.ok(seen.includes(940) || seen.includes("0x3ac")); // totalSupply at head - 60
});
