// Contract Check phase 4 — Telegram alerts to Core Tier members, through the Planet Zephyros Notis bot
// (notisLinkRouter.js). Who gets them: every wallet linked on the Notis bot that has Core access and
// hasn't sent /contractalerts off. What they cover: the member's own wallet plus their tracked wallets.
//
// 1. Approvals (every few minutes): new approve / increaseAllowance / setApprovalForAll / NFT approve
//    transactions from a covered wallet, from the explorer's newest page of its transactions. A DM goes out
//    when the spender is a plain wallet (not a contract), or isn't in our registry and none of the member's
//    wallets has used it before, or its Contract Check has caution/high flags (telegramCards.js
//    approvalAlertReasons). Revokes never alert.
// 2. Watchlist (every few hours): the ERC-20s the covered wallets hold are re-checked with analyseContract,
//    whose cache-refresh diff records owner / implementation / code-hash changes in contract_changes — and
//    their controllers' recent transactions are read for calls to the token's privileged functions (owner
//    actions: a tax raised, trading paused, an address blacklisted, tokens minted; walletWatch/ownerActions.js),
//    recorded there too. Each member is told about the new ones for tokens they hold.
// 3. Daily wallet check (once a day, from WALLET_DIGEST_HOUR_UTC): risky open approvals, held tokens whose
//    badge got worse, address poisoning, bait airdrops, large sends to new addresses — rules in
//    walletWatch/walletDigest.js, worded by Claude, sent only when something was found.
//
// Cursors live in contract_alert_state and advance by compare-and-set (advanceAlertState): a new cursor
// starts at "now" (no alerts about history), and when two instances overlap during a deploy only the one
// that wins the update sends — no duplicate DMs.
import { getNotisLinkState } from "../state/notisLinkState.js";
import { sendNotisDirectMessage, notisConfigured, getNotisLinkedChatId } from "./notisLinkRouter.js";
import { botViewers } from "./etnAccumulatorBot.js";
import { llmUsageBetween, revenueSweptBetween, topQuestions } from "../db/contractCheckAi.js";
import { formatTopQuestions } from "../services/contractCheck/questionThemes.js";
import { getAllActiveMemberWallets } from "../db/premiumMemberships.js";
import { getEtnPriceCache } from "../state/etnPriceState.js";
import { formatCostReport, monthRange, previousMonth } from "../services/llmCost.js";
import { hasCoreAccess } from "./premiumAccess.js";
import { getCoveredWallets } from "../db/trackedWallets.js";
import { getTouchedAddresses } from "../db/contractCheckLists.js";
import { getAlertState, setAlertState, advanceAlertState, getChangesSince, latestChangeId, insertContractChange } from "../db/contractAlerts.js";
import { fetchBlockscoutJsonOrNull } from "./blockscoutClient.js";
import { createPrimaryNameResolver, shortAddress } from "./primaryNameResolver.js";
import { analyseContract } from "../services/contractCheck/analyseContract.js";
import { contractCheckProvider } from "../services/contractCheck/fetchContractData.js";
import { labelsFor, tokenMeta, activeApprovals } from "../services/contractCheck/lists.js";
import { getFactsSummaries } from "../db/contractCheckLists.js";
import { riskyApprovals, badgeWorsened, poisoning, scamAirdrops, bigTransfersOut, hasFindings, formatDigest, digestSummary } from "../services/walletWatch/walletDigest.js";
import { approvalFromTx, approvalAlertReasons, formatApprovalAlert, formatChangeAlert, feedbackButtons, md } from "../services/contractCheck/telegramCards.js";
import { alertsMutedKey, cardLink } from "../services/contractCheck/telegramCheck.js";
import { privilegedNames, controllersOf, ownerActionsFromTxs, selectorsOf, routedActionsFromTxs } from "../services/walletWatch/ownerActions.js";

const APPROVALS_EVERY_MS = Number(process.env.CONTRACT_ALERTS_APPROVALS_MS) || 5 * 60 * 1000;
const WATCH_EVERY_MS = Number(process.env.CONTRACT_ALERTS_WATCH_MS) || 6 * 3600 * 1000;
const MAX_TOKENS_PER_MEMBER = 60;
const DIGEST_HOUR_UTC = Number(process.env.WALLET_DIGEST_HOUR_UTC ?? 8);
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://dashboard.planetzephyros.xyz";
const REVERSE_REGISTRAR_ADDRESS = process.env.REVERSE_REGISTRAR_ADDRESS || "0xFBB14eDBD8D3f6E7BB240bFA388f6582df0d8E7A";

let resolveName = null;
/** A wallet's .etn name, or its short address. */
async function nameOf(address) {
  resolveName ??= createPrimaryNameResolver(contractCheckProvider(), REVERSE_REGISTRAR_ADDRESS);
  const n = await resolveName(address).catch(() => null);
  return n || shortAddress(address);
}

/** Linked Notis wallets with Core access and contract alerts on: [{ owner, chatId, wallets }]. */
async function members() {
  const subs = (await getNotisLinkState().catch(() => null))?.subscriptions || {};
  const out = [];
  for (const [owner, sub] of Object.entries(subs)) {
    if (sub?.chatId == null) continue;
    if ((await getAlertState(alertsMutedKey(owner)).catch(() => null)) === true) continue;
    if (!(await hasCoreAccess(owner).catch(() => false))) continue;
    const wallets = (await getCoveredWallets(owner).catch(() => [{ address: owner }])).map((w) => w.address.toLowerCase());
    out.push({ owner: owner.toLowerCase(), chatId: sub.chatId, wallets });
  }
  return out;
}

// ---- 1. approvals ----------------------------------------------------------------------------------
async function checkApprovals(member) {
  let touched = null; // the member's used contracts, loaded only when an approval needs it
  for (const wallet of member.wallets) {
    const page = await fetchBlockscoutJsonOrNull(`/addresses/${wallet}/transactions`).catch(() => null);
    const items = page?.items || [];
    const newest = items.reduce((m, t) => Math.max(m, Number(t.block_number ?? t.block ?? 0)), 0);
    if (!newest) continue;
    const key = `appr:${member.owner}:${wallet}`;
    const cursor = await getAlertState(key).catch(() => undefined);
    if (cursor === undefined) continue; // database unreachable: try next time
    if (newest <= (cursor ?? 0) && cursor !== null) continue;
    if (!(await advanceAlertState(key, cursor, newest).catch(() => false))) continue; // another instance has it
    if (cursor === null) continue; // first look at this wallet: start from now

    const fresh = items
      .filter((t) => Number(t.block_number ?? t.block ?? 0) > cursor)
      .map((t) => approvalFromTx(t, wallet))
      .filter((a) => a && !a.revoke)
      .reverse(); // oldest first
    for (const a of fresh) {
      const facts = await analyseContract(a.spender).catch(() => null);
      const known = (await labelsFor([a.spender]).catch(() => ({})))[a.spender] || null;
      touched ??= new Set((await getTouchedAddresses(member.wallets, 300).catch(() => [])).map((t) => t.address.toLowerCase()));
      const reasons = approvalAlertReasons({ isContract: facts?.identity?.isContract, known: Boolean(known), usedBefore: touched.has(a.spender), overall: facts?.overall });
      if (!reasons.length) continue;
      const tk = await tokenMeta(a.token).catch(() => null);
      const text = formatApprovalAlert({
        walletName: await nameOf(wallet),
        tokenLabel: tk?.symbol || tk?.name || shortAddress(a.token),
        spenderName: known?.label || facts?.identity?.contractName || null,
        spender: a.spender,
        reasons,
        overall: facts?.overall || null,
        kind: a.kind,
        link: cardLink(a.spender),
      });
      await sendNotisDirectMessage(member.chatId, text, feedbackButtons("approval", a.spender));
      console.log(`🔔 Contract alerts: approval alert to ${member.owner} (${reasons.join(", ")}) — ${a.token} -> ${a.spender}`);
    }
  }
}

// ---- 2. watchlist ----------------------------------------------------------------------------------
/** ERC-20s the member's wallets hold (non-zero), up to MAX_TOKENS_PER_MEMBER. */
async function heldTokens(member) {
  const set = new Set();
  for (const wallet of member.wallets) {
    const page = await fetchBlockscoutJsonOrNull(`/addresses/${wallet}/tokens?type=ERC-20`).catch(() => null);
    for (const it of page?.items || []) {
      const a = (it.token?.address_hash || it.token?.address || "").toLowerCase();
      if (a && BigInt(it.value || 0) > 0n) set.add(a);
    }
  }
  return [...set].slice(0, MAX_TOKENS_PER_MEMBER);
}

/** Controllers' calls to their tokens' privileged functions since the last run -> contract_changes rows. One
 * explorer page per controller; each controller's cursor (newest block seen) advances by compare-and-set. */
async function scanOwnerActions(factsByToken) {
  const byController = new Map(); // controller -> [{ token, facts, names, selectors }]
  for (const [token, facts] of factsByToken) {
    if (!facts) continue;
    const names = privilegedNames(facts);
    if (!names.size) continue;
    const selectors = selectorsOf(facts);
    for (const c of controllersOf(facts)) byController.set(c, [...(byController.get(c) || []), { token, facts, names, selectors }]);
  }
  for (const [controller, targets] of byController) {
    const items = (await fetchBlockscoutJsonOrNull(`/addresses/${controller}/transactions`).catch(() => null))?.items || [];
    const newest = items.reduce((m, t) => Math.max(m, Number(t.block_number ?? t.block ?? 0)), 0);
    if (!newest) continue;
    const key = `ownact:${controller}`;
    const cursor = await getAlertState(key).catch(() => undefined);
    if (cursor === undefined || (cursor !== null && newest <= cursor)) continue;
    if (!(await advanceAlertState(key, cursor, newest).catch(() => false))) continue;
    if (cursor === null) continue; // first look at this controller: from now on
    for (const { token, facts, names, selectors } of targets) {
      const label = facts.identity?.known?.label || facts.token?.symbol || facts.identity?.contractName || null;
      const role = facts.ownership?.owner === controller ? "owner" : "role";
      // direct calls (a wallet owner) and calls routed through a multisig / timelock owner
      const actions = [...ownerActionsFromTxs(items, { token, by: controller, names, afterBlock: cursor }), ...routedActionsFromTxs(items, { token, controller, selectors, afterBlock: cursor })];
      for (const a of actions) {
        await insertContractChange(token, [{ field: "action", fn: a.fn, by: a.by, role, txHash: a.txHash, args: a.args, ...(a.via ? { via: a.via, stage: a.stage, delaySec: a.delaySec } : {}) }], label).catch((err) => console.warn(`⚠️  Contract alerts: couldn't record an owner action on ${token}:`, err.message));
        console.log(`🔎 Contract alerts: ${label || token} — ${role} ${controller} ${a.via ? `(${a.via}) ${a.stage}` : "called"} ${a.fn}`);
      }
    }
  }
}

async function checkWatchlist(list) {
  const held = new Map(); // owner -> tokens
  for (const m of list) held.set(m.owner, await heldTokens(m));
  // Re-check every held token once: analyseContract's diff records any change in contract_changes.
  const factsByToken = new Map();
  for (const token of new Set([...held.values()].flat())) factsByToken.set(token, await analyseContract(token).catch(() => null));
  await scanOwnerActions(factsByToken);
  const latest = await latestChangeId().catch(() => null);
  if (latest === null) return;
  for (const m of list) {
    const key = `chg:${m.owner}`;
    const cursor = await getAlertState(key).catch(() => undefined);
    if (cursor === undefined) continue;
    if (cursor !== null && latest <= cursor) continue;
    if (!(await advanceAlertState(key, cursor, latest).catch(() => false))) continue;
    if (cursor === null) continue; // new member: from now on
    for (const c of await getChangesSince(cursor, held.get(m.owner)).catch(() => [])) {
      if (c.id > latest) continue; // belongs to the next run's range
      await sendNotisDirectMessage(m.chatId, formatChangeAlert({ label: c.label, address: c.address, changes: c.changes, link: cardLink(c.address) }), feedbackButtons("change", c.id));
      console.log(`🔔 Contract alerts: change alert to ${m.owner} — ${c.label || c.address} (${c.changes.map((x) => x.field).join(", ")})`);
    }
  }
}

// ---- 3. daily wallet check ----------------------------------------------------------------------------
const lc = (a) => String(a || "").toLowerCase();
const items = async (path) => (await fetchBlockscoutJsonOrNull(path).catch(() => null))?.items || [];

/** Today's findings for a member, and the badges of what they hold (for tomorrow's comparison). */
async function walletFindings(member, previousOverall) {
  const sinceSec = Math.floor(Date.now() / 1000) - 86400;
  const touched = (await getTouchedAddresses(member.wallets, 300).catch(() => [])).map((t) => lc(t.address));
  const wallets = [];
  for (const w of member.wallets) {
    const [txs, tIn, tOut] = [await items(`/addresses/${w}/transactions`), await items(`/addresses/${w}/token-transfers?filter=to`), await items(`/addresses/${w}/token-transfers?filter=from`)];
    const recentIn = tIn
      .filter((t) => Date.parse(t.timestamp) / 1000 >= sinceSec)
      .map((t) => ({ from: t.from?.hash, token: t.token?.symbol || null, tokenAddress: t.token?.address_hash || t.token?.address, tokenName: t.token?.name, tokenSymbol: t.token?.symbol }));
    const sentTo = [...txs.filter((t) => lc(t.from?.hash) === w).map((t) => t.to?.hash), ...tOut.map((t) => t.to?.hash)].filter(Boolean);
    const older = (list) => list.filter((t) => Date.parse(t.timestamp) / 1000 < sinceSec).map((t) => t.to?.hash).filter(Boolean);
    const approvals = (await activeApprovals(w).catch(() => null))?.approvals || [];
    // unregistered spenders the member deployed themselves aren't a risk to them
    const ownDeployed = new Set();
    for (const a of approvals.filter((x) => x.unlimited && !x.spenderKnown)) {
      const deployer = (await analyseContract(a.spender).catch(() => null))?.creation?.deployer;
      if (deployer && member.wallets.includes(lc(deployer))) ownDeployed.add(lc(a.spender));
    }
    wallets.push({
      name: await nameOf(w),
      approvals: riskyApprovals(approvals, { ownDeployed }).slice(0, 5),
      poisoning: poisoning(recentIn, sentTo).slice(0, 3),
      airdrops: scamAirdrops(recentIn).slice(0, 5),
      bigOut: bigTransfersOut(txs, { wallet: w, sinceSec, earlierRecipients: [...older(txs), ...older(tOut), ...touched, ...member.wallets] }).slice(0, 3),
    });
  }
  const held = await heldTokens(member);
  const summaries = await getFactsSummaries(held).catch(() => ({}));
  const overall = Object.fromEntries(held.filter((t) => summaries[t]?.overall).map((t) => [t, summaries[t].overall]));
  const worsened = badgeWorsened(previousOverall, overall).map((x) => ({ ...x, label: summaries[x.token]?.symbol || summaries[x.token]?.name || null }));
  return { findings: { wallets, worsened }, overall };
}

async function digestFor(member, today) {
  const key = `dig:${member.owner}`;
  const prev = await getAlertState(key).catch(() => undefined);
  if (prev === undefined || prev?.date === today) return;
  // claim today's run first (compare-and-set): an overlapping instance skips it
  if (!(await advanceAlertState(key, prev, { date: today, overall: prev?.overall || {} }).catch(() => false))) return;
  const { findings, overall } = await walletFindings(member, prev?.overall || null);
  await setAlertState(key, { date: today, overall }).catch(() => {});
  if (!hasFindings(findings)) return; // quiet day: no message, no Claude call
  const summary = await digestSummary(findings, { wallet: member.owner });
  await sendNotisDirectMessage(member.chatId, formatDigest(findings, summary, { dashboardUrl: DASHBOARD_URL, date: today }), feedbackButtons("digest", today));
  console.log(`🛡️ Wallet check sent to ${member.owner} (${summary.source})`);
}

// ---- 4. monthly AI cost note to the admins ----------------------------------------------------------------
/** On the 1st (from DIGEST_HOUR_UTC), last month's Claude spend vs Core Tier revenue, to the admin wallets (the
 * ETN Bot viewers) that are linked on the Notis bot. Once per month (compare-and-set). */
async function costReportTick(now) {
  if (now.getUTCDate() !== 1) return;
  const month = previousMonth(now);
  if (!(await advanceAlertState(`cost:${month}`, null, true).catch(() => false))) return;
  const { from, to } = monthRange(month);
  const [rows, revenueEtn, members, etn] = await Promise.all([llmUsageBetween(from, to), revenueSweptBetween(from, to).catch(() => null), getAllActiveMemberWallets().catch(() => []), getEtnPriceCache().catch(() => null)]);
  // plus what members asked that month, to decide on new quick questions
  const asked = await topQuestions(from, 20).catch(() => null);
  const askedText = asked ? ["", "", "*Members' own questions*", ...formatTopQuestions(asked, { md })].join("\n") : "";
  const text = formatCostReport({ month, rows, revenueEtn, etnUsd: etn?.usd ?? null, activeMembers: members.length }) + askedText;
  for (const admin of botViewers()) {
    const chatId = await getNotisLinkedChatId(admin).catch(() => null);
    if (chatId != null) await sendNotisDirectMessage(chatId, text);
  }
  console.log(`💸 AI cost report for ${month} sent`);
}

let digestRunning = false;
async function digestTick() {
  const now = new Date();
  if (digestRunning || now.getUTCHours() < DIGEST_HOUR_UTC) return;
  digestRunning = true;
  try {
    const today = now.toISOString().slice(0, 10);
    for (const m of await members()) await digestFor(m, today).catch((err) => console.error(`⚠️  Wallet check failed for ${m.owner}:`, err.message));
    await costReportTick(now).catch((err) => console.error("⚠️  AI cost report failed:", err.message));
  } finally {
    digestRunning = false;
  }
}

let approvalsRunning = false;
let watchRunning = false;
async function approvalsTick() {
  if (approvalsRunning) return;
  approvalsRunning = true;
  try {
    for (const m of await members()) await checkApprovals(m);
  } catch (err) {
    console.error("⚠️  Contract alerts (approvals) failed:", err.message);
  } finally {
    approvalsRunning = false;
  }
}
async function watchTick() {
  if (watchRunning) return;
  watchRunning = true;
  try {
    const list = await members();
    if (list.length) await checkWatchlist(list);
  } catch (err) {
    console.error("⚠️  Contract alerts (watchlist) failed:", err.message);
  } finally {
    watchRunning = false;
  }
}

export function startContractAlerts() {
  if (!notisConfigured() || !process.env.DATABASE_URL) {
    console.log("ℹ️  Notis bot or database not configured — contract alerts disabled");
    return;
  }
  console.log(`🔔 Contract alerts started (approvals every ${APPROVALS_EVERY_MS / 60000} min, watchlist + owner actions every ${WATCH_EVERY_MS / 3600000}h, wallet check daily from ${DIGEST_HOUR_UTC}:00 UTC)`);
  setTimeout(approvalsTick, 2 * 60 * 1000);
  setInterval(approvalsTick, APPROVALS_EVERY_MS);
  setTimeout(watchTick, 10 * 60 * 1000);
  setInterval(watchTick, WATCH_EVERY_MS);
  setInterval(digestTick, 30 * 60 * 1000); // runs once per member per day, from WALLET_DIGEST_HOUR_UTC
}
