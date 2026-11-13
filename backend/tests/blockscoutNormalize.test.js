import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBlockscoutTokens } from "../utils/blockscoutNormalize.js";

const v12Token = { address_hash: "0xAbC", holders_count: "216", decimals: "18", symbol: "WETN", type: "ERC-20" };

test("aliases address/holders on a v12 token list", () => {
  const res = normalizeBlockscoutTokens({ items: [{ ...v12Token }], next_page_params: null });
  assert.equal(res.items[0].address, "0xAbC");
  assert.equal(res.items[0].holders, "216");
});

test("aliases nested token objects (token-balances / transfers)", () => {
  const res = normalizeBlockscoutTokens([{ token: { ...v12Token }, value: "1" }]);
  assert.equal(res[0].token.address, "0xAbC");
  const tr = normalizeBlockscoutTokens({ items: [{ from: { hash: "0x1" }, token: { ...v12Token }, total: { value: "5" } }] });
  assert.equal(tr.items[0].token.address, "0xAbC");
});

test("leaves old-shape tokens and non-token objects alone", () => {
  const old = normalizeBlockscoutTokens({ address: "0xOld", holders: "3", decimals: "18" });
  assert.deepEqual(old, { address: "0xOld", holders: "3", decimals: "18" });
  const sc = normalizeBlockscoutTokens({ verified_twin_address_hash: "0x2", creator_address_hash: "0x3" });
  assert.equal(sc.address, undefined);
  assert.equal(normalizeBlockscoutTokens(null), null);
});
