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
//    whose cache-refresh diff records owner / implementation / code-hash changes in contract_changes; each
//    member is told about the new ones for tokens they hold.
//
// Cursors live in contract_alert_state and advance by compare-and-set (advanceAlertState): a new cursor
// starts at "now" (no alerts about history), and when two instances overlap during a deploy only the one
// that wins the update sends — no duplicate DMs.
import { getNotisLinkState } from "../state/notisLinkState.js";
import { sendNotisDirectMessage, notisConfigured } from "./notisLinkRouter.js";
import { hasCoreAccess } from "./premiumAccess.js";
import { getCoveredWallets } from "../db/trackedWallets.js";
import { getTouchedAddresses } from "../db/contractCheckLists.js";
import { getAlertState, advanceAlertState, getChangesSince, latestChangeId } from "../db/contractAlerts.js";
import { fetchBlockscoutJsonOrNull } from "./blockscoutClient.js";
import { createPrimaryNameResolver, shortAddress } from "./primaryNameResolver.js";
import { analyseContract } from "../services/contractCheck/analyseContract.js";
import { contractCheckProvider } from "../services/contractCheck/fetchContractData.js";
import { labelsFor, tokenMeta } from "../services/contractCheck/lists.js";
import { approvalFromTx, approvalAlertReasons, formatApprovalAlert, formatChangeAlert } from "../services/contractCheck/telegramCards.js";
import { alertsMutedKey, cardLink } from "../services/contractCheck/telegramCheck.js";

const APPROVALS_EVERY_MS = Number(process.env.CONTRACT_ALERTS_APPROVALS_MS) || 5 * 60 * 1000;
const WATCH_EVERY_MS = Number(process.env.CONTRACT_ALERTS_WATCH_MS) || 6 * 3600 * 1000;
const MAX_TOKENS_PER_MEMBER = 60;
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
      await sendNotisDirectMessage(member.chatId, text);
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

async function checkWatchlist(list) {
  const held = new Map(); // owner -> tokens
  for (const m of list) held.set(m.owner, await heldTokens(m));
  // Re-check every held token once: analyseContract's diff records any change in contract_changes.
  for (const token of new Set([...held.values()].flat())) await analyseContract(token).catch(() => null);
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
      await sendNotisDirectMessage(m.chatId, formatChangeAlert({ label: c.label, address: c.address, changes: c.changes, link: cardLink(c.address) }));
      console.log(`🔔 Contract alerts: change alert to ${m.owner} — ${c.label || c.address} (${c.changes.map((x) => x.field).join(", ")})`);
    }
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
  console.log(`🔔 Contract alerts started (approvals every ${APPROVALS_EVERY_MS / 60000} min, watchlist every ${WATCH_EVERY_MS / 3600000}h)`);
  setTimeout(approvalsTick, 2 * 60 * 1000);
  setInterval(approvalsTick, APPROVALS_EVERY_MS);
  setTimeout(watchTick, 10 * 60 * 1000);
  setInterval(watchTick, WATCH_EVERY_MS);
}
