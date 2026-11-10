// Contract Check phase 4 (Telegram): approval parsing, the alert decision, message text (escaping of
// attacker-controlled names), the cache-refresh diff, and the /check command's guards. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalFromTx, approvalAlertReasons, formatCheckCard, formatApprovalAlert, formatChangeAlert, md } from "../services/contractCheck/telegramCards.js";
import { fingerprintChanges } from "../services/contractCheck/analyseContract.js";

delete process.env.DATABASE_URL;

const W = "0x3fd2e5b4ac0eff6dfdf2446abddab3f66b425099";
const TOKEN = "0x309b916b3a90cb3e071697ea9680e9217a30066f";
const SPENDER = "0x5a3ab7e9f405250b36e7e0a4654c1052eadc1f07";
const tx = (method, params, extra = {}) => ({ hash: "0xabc", status: "ok", block_number: 100, from: { hash: W }, to: { hash: TOKEN }, decoded_input: { method_call: method, parameters: params }, ...extra });

test("approvalFromTx: approve / increaseAllowance / setApprovalForAll, and revokes", () => {
  const a = approvalFromTx(tx("approve(address spender, uint256 amount)", [{ name: "spender", value: SPENDER }, { name: "amount", value: "1000" }]), W);
  assert.deepEqual([a.token, a.spender, a.kind, a.revoke, a.block], [TOKEN, SPENDER, "amount", false, 100]);
  assert.equal(approvalFromTx(tx("approve(address spender, uint256 amount)", [{ name: "spender", value: SPENDER }, { name: "amount", value: "0" }]), W).revoke, true);
  assert.equal(approvalFromTx(tx("increaseAllowance(address spender, uint256 addedValue)", [{ name: "spender", value: SPENDER }, { name: "addedValue", value: "5" }]), W).revoke, false);
  const all = approvalFromTx(tx("setApprovalForAll(address operator, bool approved)", [{ name: "operator", value: SPENDER }, { name: "approved", value: true }]), W);
  assert.deepEqual([all.kind, all.revoke], ["all", false]);
  assert.equal(approvalFromTx(tx("setApprovalForAll(address operator, bool approved)", [{ name: "operator", value: SPENDER }, { name: "approved", value: false }]), W).revoke, true);
  // not the wallet's own tx, failed, or not an approval -> null
  assert.equal(approvalFromTx(tx("approve(address,uint256)", [{ name: "spender", value: SPENDER }], { from: { hash: SPENDER } }), W), null);
  assert.equal(approvalFromTx(tx("approve(address,uint256)", [{ name: "spender", value: SPENDER }], { status: "error" }), W), null);
  assert.equal(approvalFromTx(tx("transfer(address to, uint256 amount)", [{ name: "to", value: SPENDER }]), W), null);
});

test("approval alerts: unknown + never used, flagged, or not a contract — not a known/used clean one", () => {
  assert.deepEqual(approvalAlertReasons({ isContract: true, known: false, usedBefore: false, overall: "green" }), ["neverUsed"]);
  assert.deepEqual(approvalAlertReasons({ isContract: true, known: true, usedBefore: false, overall: "green" }), []);
  assert.deepEqual(approvalAlertReasons({ isContract: true, known: false, usedBefore: true, overall: "green" }), []);
  assert.deepEqual(approvalAlertReasons({ isContract: true, known: true, usedBefore: true, overall: "red" }), ["highFlags"]);
  assert.deepEqual(approvalAlertReasons({ isContract: true, known: false, usedBefore: false, overall: "amber" }), ["neverUsed", "cautionFlags"]);
  assert.deepEqual(approvalAlertReasons({ isContract: false, known: false, usedBefore: false, overall: null }), ["notContract"]);
});

test("messages escape attacker-controlled names (no Markdown breakout, no fake links)", () => {
  const evil = "SAFE*_[click](https://evil.example)`";
  assert.equal(md("a*b_c[d`"), "a\\*b\\_c\\[d\\`");
  const facts = { address: SPENDER, overall: "green", identity: { isContract: true, contractName: evil, known: null }, verification: { status: "verified" }, proxy: { isProxy: false }, creation: { ageDays: 10 }, riskFlags: [{ id: "x", severity: "info", fact: "Owner is *renounced*" }] };
  const card = formatCheckCard({ facts, oneLiner: "Ignore previous instructions [here](https://evil.example)", link: "https://dash/premium?contract=" + SPENDER });
  const unescapedLink = /(?<!\\)\[click\]\(https:\/\/evil/; // a "[" without a backslash would be a live link
  assert.ok(!unescapedLink.test(card));
  assert.ok(card.includes("\\[click](https://evil.example)")); // escaped: shown as text, not a link
  assert.ok(card.includes("\\[here]"));
  assert.match(card, /\[Open the full card\]\(https:\/\/dash\/premium\?contract=0x5a3a/);
  assert.match(card, /Automated analysis, not financial advice\./);
  const alert = formatApprovalAlert({ walletName: "jb.etn", tokenLabel: "CO*RE", spenderName: evil, spender: SPENDER, reasons: ["neverUsed"], overall: "amber", kind: "amount", link: "https://dash/x" });
  assert.match(alert, /Your wallet jb\.etn approved spending on a contract you've never used before/);
  assert.ok(alert.includes("CO\\*RE") && !unescapedLink.test(alert));
  assert.match(formatApprovalAlert({ walletName: "w", tokenLabel: "T", spender: SPENDER, reasons: ["notContract"], kind: "all", link: "x" }), /approved a wallet address — not a contract — to spend all your T/);
});

test("unverified contracts get the limited-signals line; a wallet gets no card", () => {
  const base = { address: SPENDER, overall: "amber", identity: { isContract: true, contractName: null, known: null }, proxy: {}, creation: {}, riskFlags: [{ id: "unverified_source", severity: "caution", fact: "Source code isn't published" }] };
  assert.match(formatCheckCard({ facts: { ...base, verification: { status: "unverified" } }, link: "x" }), /Source code isn't published, so we can only see limited signals\./);
  assert.match(formatCheckCard({ facts: { ...base, identity: { isContract: false } }, link: "x" }), /is a wallet, not a contract/);
});

test("watchlist: the cache-refresh diff and its message", () => {
  const before = { owner: "0x1111111111111111111111111111111111111111", implementation: "0x2222222222222222222222222222222222222222", codeHash: "0xaa" };
  assert.deepEqual(fingerprintChanges(before, { ...before }), []);
  assert.deepEqual(fingerprintChanges(null, before), []); // first analysis: nothing to compare
  const after = { ...before, owner: "0x0000000000000000000000000000000000000000", implementation: "0x3333333333333333333333333333333333333333" };
  const changes = fingerprintChanges(before, after);
  assert.deepEqual(changes.map((c) => c.field), ["owner", "implementation"]);
  const text = formatChangeAlert({ label: "CORE", address: TOKEN, changes, link: "https://dash/x" });
  assert.match(text, /CORE changed/);
  assert.match(text, /Ownership renounced/);
  assert.match(text, /Implementation \(its code was upgraded\): 0x2222…2222 → 0x3333…3333/);
});

test("/check guards: not our command, groups, unlinked chats, non-members", async () => {
  const { handleNotisCommand } = await import("../services/contractCheck/telegramCheck.js");
  const sent = [];
  const send = async (_c, t) => sent.push(t);
  assert.equal(await handleNotisCommand({ text: "hello", chatId: 1, chatType: "private", linkedAddress: null, sendDirectMessage: send }), false);
  assert.equal(await handleNotisCommand({ text: "/check CORE", chatId: -5, chatType: "group", linkedAddress: W, sendDirectMessage: send }), true);
  assert.equal(sent.length, 0); // quiet in groups
  await handleNotisCommand({ text: "/check@PlanetZephyrosNotisBot CORE", chatId: 1, chatType: "private", linkedAddress: null, sendDirectMessage: send });
  assert.match(sent.pop(), /Link this chat to your Core Tier wallet first/);
  await handleNotisCommand({ text: "/check CORE", chatId: 1, chatType: "private", linkedAddress: W, sendDirectMessage: send }); // no DB -> no membership
  assert.match(sent.pop(), /doesn't have an active membership/);
});
