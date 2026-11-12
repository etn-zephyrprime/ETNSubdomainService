// "Contracts you've used": a contract whose latest activity was a revoke is tagged lastAction "revoked".
import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { isRevokeInput, _tagRevokes } from "../services/contractCheck/lists.js";

const SPENDER = "0x012ff228Aa9Fec4dBEE6Cd704072749AF077b617";
const TOKEN = "0x043fAa1b5C5FC9a7dc35171f290c29ECDE0cCff1";
const I = new ethers.Interface([
  "function approve(address spender, uint256 amount)",
  "function setApprovalForAll(address operator, bool approved)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function lockdown((address token, address spender)[] approvals)",
  "function transfer(address to, uint256 amount)",
]);
const enc = (sig, args) => I.encodeFunctionData(sig, args);

test("revokes are recognised; grants and other calls aren't", () => {
  assert.equal(isRevokeInput(enc("approve(address,uint256)", [SPENDER, 0n])), true);
  assert.equal(isRevokeInput(enc("approve(address,uint256)", [ethers.ZeroAddress, 5n])), true); // one NFT
  assert.equal(isRevokeInput(enc("setApprovalForAll", [SPENDER, false])), true);
  assert.equal(isRevokeInput(enc("approve(address,address,uint160,uint48)", [TOKEN, SPENDER, 0n, 0n])), true); // Permit2
  assert.equal(isRevokeInput(enc("lockdown", [[[TOKEN, SPENDER]]])), true);
  assert.equal(isRevokeInput(enc("approve(address,uint256)", [SPENDER, 10n ** 30n])), false);
  assert.equal(isRevokeInput(enc("setApprovalForAll", [SPENDER, true])), false);
  assert.equal(isRevokeInput(enc("transfer", [SPENDER, 1n])), false);
  assert.equal(isRevokeInput("0x"), false);
  assert.equal(isRevokeInput(null), false);
});

test("a row is tagged only when the revoke IS its latest activity", async () => {
  const revokeTx = { data: enc("approve(address,uint256)", [SPENDER, 0n]) };
  const grantTx = { data: enc("approve(address,uint256)", [SPENDER, 1n]) };
  const rows = [
    { address: "0xa", lastAt: "2026-11-12T00:15:00Z" }, // revoked, nothing since
    { address: "0xb", lastAt: "2026-11-12T09:00:00Z" }, // revoked at 00:15, but tokens moved at 09:00
    { address: "0xc", lastAt: "2026-11-12T00:15:00Z" }, // last sent tx was a grant
    { address: "0xd", lastAt: "2026-11-12T00:15:00Z" }, // no sent tx at all
  ];
  const sent = { "0xa": { txHash: "h1", at: "2026-11-12T00:15:00Z" }, "0xb": { txHash: "h2", at: "2026-11-12T00:15:00Z" }, "0xc": { txHash: "h3", at: "2026-11-12T00:15:00Z" } };
  const txs = { h1: revokeTx, h2: revokeTx, h3: grantTx };
  const reads = [];
  await _tagRevokes(rows, ["0xwallet"], { latestSent: async () => sent, provider: { getTransaction: async (h) => (reads.push(h), txs[h]) } });
  assert.deepEqual(rows.map((r) => r.lastAction || null), ["revoked", null, null, null]);
  assert.deepEqual(reads, ["h1", "h3"]); // no read for the row with later activity
});
