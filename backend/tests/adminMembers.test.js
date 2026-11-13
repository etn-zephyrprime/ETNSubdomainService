import test from "node:test";
import assert from "node:assert/strict";
import { buildMembersView, MEMBERS_ADMINS } from "../utils/adminMembersRouter.js";

const now = Date.parse("2026-11-13T12:00:00Z");
const d = (days) => new Date(now + days * 86400000).toISOString();

test("plans, status, ordering and summary", () => {
  const { members, summary } = buildMembersView(
    [
      { wallet_address: "0xa", monthly_expiry: d(20), annual_expiry: null, last_tx_hash: "0xtx1", tracked_wallets: 2 },
      { wallet_address: "0xb", monthly_expiry: d(-3), annual_expiry: d(200), last_tx_hash: "0xtx2" },
      { wallet_address: "0xc", monthly_expiry: d(3), annual_expiry: null, last_tx_hash: "trial:2026-11-01" },
      { wallet_address: "0xd", monthly_expiry: d(-10), annual_expiry: null, last_tx_hash: "0xtx4" },
      { wallet_address: "0xe", monthly_expiry: d(-1), annual_expiry: null, last_tx_hash: "0xtx5" },
    ],
    now
  );
  assert.deepEqual(members.map((m) => m.wallet), ["0xc", "0xa", "0xb", "0xe", "0xd"]);
  const byW = Object.fromEntries(members.map((m) => [m.wallet, m]));
  assert.equal(byW["0xb"].plan, "annual");
  assert.equal(byW["0xa"].plan, "monthly");
  assert.equal(byW["0xa"].daysLeft, 20);
  assert.equal(byW["0xa"].trackedWallets, 2);
  assert.equal(byW["0xc"].plan, "trial");
  assert.equal(byW["0xc"].lastTxHash, null);
  assert.equal(byW["0xd"].active, false);
  assert.equal(byW["0xd"].daysSinceExpiry, 10);
  assert.deepEqual(summary, { active: 3, paid: 2, trials: 1, annual: 1, monthly: 1, expiringSoon: 1, expired: 2 });
});

test("the two named admins have access by default", () => {
  assert.ok(MEMBERS_ADMINS.has("0x3fd2e5b4ac0eff6dfdf2446abddab3f66b425099")); // planetzephyros.etn (…5099)
  assert.ok(MEMBERS_ADMINS.has("0x696a7b9ea5c86da15d569d99d75ed788cce4db2e")); // mav-browney.electroswap.etn
  assert.ok(!MEMBERS_ADMINS.has("0x0000000000000000000000000000000000000001"));
});
