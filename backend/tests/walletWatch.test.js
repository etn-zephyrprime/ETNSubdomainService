// Wallet watch: the owner-action watch (walletWatch/ownerActions.js) and the daily wallet check's rules,
// message and Claude guard (walletWatch/walletDigest.js). Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privilegedNames, controllersOf, ownerActionsFromTxs } from "../services/walletWatch/ownerActions.js";
import { riskyApprovals, badgeWorsened, poisoning, scamAirdrops, bigTransfersOut, hasFindings, formatDigest, digestSummary, templateSummary } from "../services/walletWatch/walletDigest.js";
import { formatChangeAlert } from "../services/contractCheck/telegramCards.js";

delete process.env.DATABASE_URL;

const TOKEN = "0x309b916b3a90cb3e071697ea9680e9217a30066f";
const TAXW = "0x4eb4b9ce208711a0ea1beff57c83bd66bc563378";
const ZERO = "0x0000000000000000000000000000000000000000";

test("owner actions: privileged functions, live controllers, and their calls to the token", () => {
  const facts = {
    powers: { byCategory: { fees: [{ name: "toggleTaxesPaused", gated: true }], pause: [{ name: "enableTrading", gated: true }], withdraw: [{ name: "withdraw", gated: false }] } },
    ownership: { owner: ZERO, ownerStatus: "renounced", customRoles: [{ name: "taxWallet", holder: TAXW, status: "active" }], adminRoleHolders: null },
  };
  assert.deepEqual([...privilegedNames(facts)].sort(), ["enableTrading", "toggleTaxesPaused"]); // a public withdraw isn't a power
  assert.deepEqual(controllersOf(facts), [TAXW]); // renounced owner skipped, the live role kept
  const tx = (method, block, extra = {}) => ({ hash: `0x${block}`, status: "ok", block_number: block, from: { hash: TAXW }, to: { hash: TOKEN }, decoded_input: { method_call: `${method}()`, parameters: [] }, ...extra });
  const txs = [tx("toggleTaxesPaused", 105), tx("transfer", 104), tx("toggleTaxesPaused", 99), tx("toggleTaxesPaused", 106, { status: "error" }), tx("toggleTaxesPaused", 107, { to: { hash: "0xother" } })];
  const actions = ownerActionsFromTxs(txs, { token: TOKEN, by: TAXW, names: privilegedNames(facts), afterBlock: 100 });
  assert.deepEqual(actions.map((a) => [a.fn, a.block]), [["toggleTaxesPaused", 105]]); // only new, successful, privileged, to this token
  const text = formatChangeAlert({ label: "CORE", address: TOKEN, changes: [{ field: "action", fn: "toggleTaxesPaused", by: TAXW, role: "role", txHash: "0xabc", args: "" }], link: "L" });
  assert.match(text, /0x4eb4…3378 \(a role that controls it\) called \*toggleTaxesPaused\* — \[tx\]\(https:\/\/blockexplorer\.electroneum\.com\/tx\/0xabc\)/);
});

const W = "0x3fd2e5b4ac0eff6dfdf2446abddab3f66b425099";
const KUCOIN = "0xabcd1234567890aaaaaaaaaaaaaaaaaaaaaa9f2e";
const POISON = "0xabcd9999999999bbbbbbbbbbbbbbbbbbbbbb9f2e"; // same first 4 and last 4 as KUCOIN

test("daily check rules: approvals, badges, poisoning, bait airdrops, big sends", () => {
  const appr = [
    { unlimited: true, spender: "0x1", tokenSymbol: "USDT", spenderKnown: { label: "ElectroSwap Router" }, spenderOverall: "green" }, // known + clean
    { unlimited: true, spender: "0x2", tokenSymbol: "CORE", spenderKnown: null, spenderOverall: "green" }, // unknown
    { unlimited: true, spender: "0x3", tokenSymbol: "BOLT", spenderKnown: { label: "X" }, spenderOverall: "red" }, // flagged
    { unlimited: false, spender: "0x4", tokenSymbol: "DYNO", spenderKnown: null, spenderOverall: "red" }, // limited
  ];
  assert.deepEqual(riskyApprovals(appr).map((a) => a.spender), ["0x2", "0x3"]);
  assert.deepEqual(badgeWorsened({ a: "green", b: "amber", c: "red" }, { a: "red", b: "green", c: "red", d: "red" }), [{ token: "a", from: "green", to: "red" }]); // d: no history yet
  assert.deepEqual(poisoning([{ from: POISON, token: "USDT" }, { from: KUCOIN, token: "USDT" }], [KUCOIN]), [{ from: POISON, looksLike: KUCOIN, token: "USDT" }]);
  assert.deepEqual(scamAirdrops([{ tokenAddress: "0xAA", tokenName: "Visit claim-etn.com for 500 ETN" }, { tokenAddress: "0xBB", tokenName: "Planet Zephyros", tokenSymbol: "CORE" }]), [{ token: "0xaa" }]);
  const now = 1_800_000_000;
  const tx = (to, etn, ageSec, extra = {}) => ({ status: "ok", hash: "0xh", from: { hash: W }, to: { hash: to, is_contract: false }, value: (BigInt(etn) * 10n ** 18n).toString(), timestamp: new Date((now - ageSec) * 1000).toISOString(), ...extra });
  const big = bigTransfersOut([tx("0xnew0000000000000000000000000000000000001", 80000, 3600), tx(KUCOIN, 90000, 3600), tx("0xnew0000000000000000000000000000000000002", 1000, 3600), tx("0xnew0000000000000000000000000000000000003", 99000, 3 * 86400)], { wallet: W, sinceSec: now - 86400, earlierRecipients: [KUCOIN] });
  assert.deepEqual(big.map((b) => [b.to, b.etn]), [["0xnew0000000000000000000000000000000000001", 80000]]);
});

const findings = {
  wallets: [{ name: "jb.etn", approvals: [{ token: "CORE", spender: "0x2222222222222222222222222222222222222222", spenderLabel: null, overall: null }], poisoning: [{ from: POISON, looksLike: KUCOIN, token: "USDT" }], airdrops: [{ token: "0x00000000000000000000000000000000000000aa" }], bigOut: [] }],
  worsened: [{ token: TOKEN, from: "green", to: "red", label: "PDY" }],
};

test("digest message: every section, full lookalike addresses, and no bait names or links from tokens", () => {
  assert.equal(hasFindings(findings), true);
  assert.equal(hasFindings({ wallets: [{ approvals: [], poisoning: [], airdrops: [], bigOut: [] }], worsened: [] }), false);
  const text = formatDigest(findings, templateSummary(findings), { dashboardUrl: "https://dash", date: "2026-11-11" });
  for (const re of [/Daily wallet check\* — 2026-11-11/, /Open approvals to review/, /unlimited CORE → 0x2222…2222 \(not in our registry\)/, /Tokens you hold that got riskier/, /PDY: 🟢 no caution flags → 🔴 high risk flags/, /Possible address poisoning/, new RegExp(POISON), new RegExp(KUCOIN), /Suspicious airdrops/, /not financial advice/]) assert.match(text, re);
  assert.ok(!/claim-etn\.com/.test(text)); // the bait name is never shown
  assert.match(templateSummary(findings).summary, /1 open unlimited approval to review, 1 held token got riskier, a possible address-poisoning attempt, a suspicious airdrop/);
});

test("digest summary: Claude's answer is checked — a link or an invented number falls back to the template", async () => {
  const fakeApi = (outputs) => {
    let i = 0;
    return { messages: { create: async () => ({ stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: JSON.stringify(outputs[Math.min(i++, outputs.length - 1)]) }] }) } };
  };
  const good = { summary: "Your wallet jb.etn has an unlimited CORE approval to a contract we don't know, and a held token got riskier.", actions: ["Revoke the CORE approval in Core Tier → Contract Check → Approvals."] };
  assert.equal((await digestSummary(findings, { api: fakeApi([good]) })).source, "claude");
  const withLink = { summary: "Claim your reward at claim-etn.com to stay protected.", actions: [] };
  assert.equal((await digestSummary(findings, { api: fakeApi([withLink, withLink]) })).source, "template");
  const invented = { summary: "You lost 4,250 ETN today.", actions: [] };
  assert.equal((await digestSummary(findings, { api: fakeApi([invented, good]) })).source, "claude"); // retried, then fine
  const verdict = { summary: "Everything is safe.", actions: [] };
  assert.equal((await digestSummary(findings, { api: fakeApi([verdict, verdict]) })).source, "template");
  assert.equal((await digestSummary(findings, { api: null })).source, "template"); // no key
});

test("daily check: no alarms for the member's own contracts or transfers between their own wallets", () => {
  const appr = [{ unlimited: true, spender: "0xF5C848BEF16B1690B22992344D25DE8FDF49AB6A", tokenSymbol: "VKIN", spenderKnown: null, spenderOverall: "amber" }];
  assert.equal(riskyApprovals(appr).length, 1);
  assert.equal(riskyApprovals(appr, { ownDeployed: new Set(["0xf5c848bef16b1690b22992344d25de8fdf49ab6a"]) }).length, 0);
  const now = 1_800_000_000;
  const bot = "0xa48bc549a329eed01e491c7cd950857a8ae56e73";
  const tx = { status: "ok", hash: "0xh", from: { hash: W }, to: { hash: bot, is_contract: false }, value: (100000n * 10n ** 18n).toString(), timestamp: new Date((now - 60) * 1000).toISOString() };
  assert.equal(bigTransfersOut([tx], { wallet: W, sinceSec: now - 86400, earlierRecipients: [W, bot] }).length, 0); // bot wallet is one of theirs
});

test("digest summary asks Haiku for low effort (thinking is billed as output)", async () => {
  let sent = null;
  const api = { messages: { create: async (p) => ((sent = p), { stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: JSON.stringify({ summary: "Your wallet jb.etn has an open approval to review.", actions: [] }) }] }) } };
  await digestSummary(findings, { api });
  assert.equal(sent.output_config.effort, "low");
  assert.equal(sent.output_config.format.type, "json_schema");
});

test("feedback buttons: fit Telegram's 64 bytes and round-trip", async () => {
  const { feedbackButtons, parseFeedback } = await import("../services/contractCheck/telegramCards.js");
  const btns = feedbackButtons("approval", "0x012FF228AA9FEC4DBEE6CD704072749AF077B617").reply_markup.inline_keyboard[0];
  for (const b of btns) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
  assert.deepEqual(parseFeedback(btns[1].callback_data), { kind: "approval", verdict: "wrong", ref: "0x012ff228aa9fec4dbee6cd704072749af077b617" });
  assert.deepEqual(parseFeedback(feedbackButtons("change", 42).reply_markup.inline_keyboard[0][0].callback_data), { kind: "change", verdict: "right", ref: "42" });
  assert.deepEqual(parseFeedback(feedbackButtons("digest", "2026-11-11").reply_markup.inline_keyboard[0][0].callback_data), { kind: "digest", verdict: "right", ref: "2026-11-11" });
  for (const bad of ["fb:x:r:1", "fb:a:r:nothex", "hello", "fb:k:w:" + "a".repeat(41)]) assert.equal(parseFeedback(bad), null, bad);
});

test("multisig / timelock owners: routed calls to the token's privileged functions are found", async () => {
  const { ethers } = await import("ethers");
  const { selectorsOf, routedActionsFromTxs } = await import("../services/walletWatch/ownerActions.js");
  const SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe";
  const TL = "0x7111111111111111111111111111111111111111";
  const facts = { powers: { byCategory: { fees: [{ name: "setFees", signature: "setFees(uint256,uint256)", gated: true }], mint: [{ name: "mint", signature: "mint(address,uint256)", gated: true }] } } };
  const sel = selectorsOf(facts);
  const token = new ethers.Interface(["function setFees(uint256,uint256)", "function mint(address,uint256)", "function transfer(address,uint256)"]);
  const r = new ethers.Interface([
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)",
    "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
    "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)",
  ]);
  const Z = ethers.ZeroAddress, H = ethers.ZeroHash;
  const setFees = token.encodeFunctionData("setFees", [5, 5]);
  const tx = (to, raw, block, extra = {}) => ({ status: "ok", hash: `0x${block}`, block_number: block, to: { hash: to }, raw_input: raw, ...extra });
  const safeTxs = [
    tx(SAFE, r.encodeFunctionData("execTransaction", [TOKEN, 0, setFees, 0, 0, 0, 0, Z, Z, "0x"]), 201),
    tx(SAFE, r.encodeFunctionData("execTransaction", [TOKEN, 0, token.encodeFunctionData("transfer", [Z, 1]), 0, 0, 0, 0, Z, Z, "0x"]), 202), // not a power
    tx(SAFE, r.encodeFunctionData("execTransaction", ["0x9999999999999999999999999999999999999999", 0, setFees, 0, 0, 0, 0, Z, Z, "0x"]), 203), // other contract
    tx(SAFE, r.encodeFunctionData("execTransaction", [TOKEN, 0, setFees, 0, 0, 0, 0, Z, Z, "0x"]), 150), // before the cursor
  ];
  assert.deepEqual(routedActionsFromTxs(safeTxs, { token: TOKEN, controller: SAFE, selectors: sel, afterBlock: 199 }).map((a) => [a.fn, a.via, a.stage, a.block]), [["setFees", "multisig", "executed", 201]]);
  const tlTxs = [
    tx(TL, r.encodeFunctionData("schedule", [TOKEN, 0, token.encodeFunctionData("mint", [Z, 10n ** 24n]), H, H, 172800]), 301),
    tx(TL, r.encodeFunctionData("executeBatch", [[TOKEN, TOKEN], [0, 0], [setFees, token.encodeFunctionData("transfer", [Z, 1])], H, H]), 302),
  ];
  const tl = routedActionsFromTxs(tlTxs, { token: TOKEN, controller: TL, selectors: sel, afterBlock: 0 });
  assert.deepEqual(tl.map((a) => [a.fn, a.via, a.stage, a.delaySec]), [["mint", "timelock", "scheduled", 172800], ["setFees", "timelock", "executed", null]]);
  const text = formatChangeAlert({ label: "XYZ", address: TOKEN, changes: [{ field: "action", fn: "mint", by: TL, role: "owner", txHash: "0x1", via: "timelock", stage: "scheduled", delaySec: 172800 }], link: "L" });
  assert.match(text, /⏳ 0x7111…1111 \(the owner, a timelock\) \*scheduled\* \*mint\* — it can run in about 2 days/);
});
