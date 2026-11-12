// Team wallets: a wallet whose fetch fails in one refresh must not drop out of the combined balance or the
// history totals (2026-11-12 19:47 UTC: 18 of 23 wallets got HTTP 429 during a deploy and the 5 that loaded
// were published on their own — the combined balance showed 20m ETN instead of ~2.5bn).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeWithPrevious } from "../utils/teamWalletsCache.js";
import { previousWalletSeries } from "../utils/teamWalletsBalanceHistory.js";

const A = "0xAAAA000000000000000000000000000000000001";
const B = "0xBBBB000000000000000000000000000000000002";
const C = "0xCCCC000000000000000000000000000000000003";
const E = (n) => (BigInt(n) * 10n ** 18n).toString();

test("failed wallets are carried over from the last snapshot, with their movements", () => {
  const previous = {
    wallets: [
      { address: A, balance: E(10), ensName: null },
      { address: B, balance: E(2_400_000_000), ensName: "big.etn" },
      { address: C, balance: E(5), ensName: null },
    ],
    movements: [{ hash: "0x1", from: B.toLowerCase(), to: "0xdead", value: E(1_000_000) }, { hash: "0x2", from: A, to: C, value: E(1_000_000) }],
  };
  const results = [{ address: A, balance: E(11), ensName: null, movements: [] }, null, { address: C, balance: E(5), ensName: null, movements: [] }];
  const m = mergeWithPrevious([A, B, C], results, previous);
  assert.deepEqual(m.stale, [B]);
  assert.deepEqual(m.wallets.map((w) => w.balance), [E(11), E(2_400_000_000), E(5)]);
  assert.equal(m.wallets[1].ensName, "big.etn");
  assert.deepEqual(m.extraMovements.map((x) => x.hash), ["0x1"]);
  const total = m.wallets.reduce((s, w) => s + BigInt(w.balance), 0n);
  assert.equal(total, BigInt(E(2_400_000_016)));
});

test("a failed wallet with no earlier figure means nothing is published", () => {
  assert.equal(mergeWithPrevious([A, B], [{ address: A, balance: "1", movements: [] }, null], { wallets: [{ address: A, balance: "1" }], movements: [] }), null);
  assert.equal(mergeWithPrevious([A, B], [{ address: A, balance: "1", movements: [] }, null], { wallets: [], movements: [] }), null);
});

test("history: a failed wallet's last published series is reused, carried forward to new days", () => {
  const previous = { series: [{ date: "2026-11-10" }, { date: "2026-11-11" }], wallets: { [B.toLowerCase()]: [2_400_000_000, 2_399_000_000] } };
  const s = previousWalletSeries(previous, B, ["2026-11-10", "2026-11-11", "2026-11-12"]);
  assert.equal(s.get("2026-11-10"), BigInt(E(2_400_000_000)));
  assert.equal(s.get("2026-11-12"), BigInt(E(2_399_000_000)));
  assert.equal(previousWalletSeries(previous, A, ["2026-11-12"]), null);
  assert.equal(previousWalletSeries({ series: [{ date: "2026-11-10" }], wallets: { [B.toLowerCase()]: [1, 2] } }, B, ["2026-11-10"]), null); // misaligned
});
