// Contract Check on Telegram (phase 4): the Planet Zephyros Notis bot's commands (notisLinkRouter.js).
//
//   /check <symbol | name.etn | address>   a compact contract card, from the same backend as the dashboard
//   /contractalerts on | off               the approval and watchlist alerts (contractAlertScheduler.js)
//
// Core Tier only, like the rest of Contract Check: the chat must be linked to a wallet (the dashboard's
// Telegram link) that has Core access. Private chats only — in a group it stays quiet.
//
// Spam: every command counts against per-chat limits (6 a minute, 40 an hour); /check also against 30 an
// hour and 100 a day per chat, and 300 per 10 minutes across all chats (explorer / RPC load). Going over
// gets ONE "slow down" reply per window and then silence, so flooding the bot gets one answer, not one per
// message. Unlinked or non-member chats get the "link your wallet" reply at most every 10 minutes.
// /check never spends a Claude call: it shows a summary only if one is already cached.
import { ethers } from "ethers";
import { analyseContract } from "./analyseContract.js";
import { contractCheckProvider } from "./fetchContractData.js";
import { explainContract } from "./explain.js";
import { searchContracts } from "./lists.js";
import { formatCheckCard, md, feedbackButtons, parseFeedback } from "./telegramCards.js";
import { saveFeedback } from "../../db/watchFeedback.js";
import { resolveEtnName } from "../../utils/primaryNameResolver.js";
import { hasCoreAccess } from "../../utils/premiumAccess.js";
import { createRateLimiter } from "../../utils/rateLimit.js";
import { getAlertState, setAlertState } from "../../db/contractAlerts.js";

const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://dashboard.planetzephyros.xyz";
export const cardLink = (address) => `${DASHBOARD_URL}/premium?contract=${address}`;

const MIN = 60 * 1000;
const commandsPerMinute = createRateLimiter({ max: 6, windowMs: MIN });
const commandsPerHour = createRateLimiter({ max: 40, windowMs: 60 * MIN });
const checksPerHour = createRateLimiter({ max: 30, windowMs: 60 * MIN });
const checksPerDay = createRateLimiter({ max: 100, windowMs: 24 * 60 * MIN });
const checksAllChats = createRateLimiter({ max: 300, windowMs: 10 * MIN });

export const alertsMutedKey = (owner) => `muted:${owner.toLowerCase()}`;

// chat|kind -> time until which that notice isn't repeated
const noticeUntil = new Map();
/** Sends `text` unless the same kind of notice already went to this chat in the last `forMs`. */
async function noticeOnce(chatId, kind, forMs, text, send) {
  const k = `${chatId}|${kind}`;
  const now = Date.now();
  if ((noticeUntil.get(k) || 0) > now) return;
  if (noticeUntil.size > 5000) for (const [key, until] of noticeUntil) if (until <= now) noticeUntil.delete(key);
  noticeUntil.set(k, now + forMs);
  await send(chatId, text);
}

/** The first limit `chatId` is over, as { retryAfterSec, kind }, or null. Every call counts against each. */
function overLimit(limiters, chatId) {
  for (const [kind, limiter] of limiters) {
    const r = limiter(`${kind}:${chatId}`);
    if (!r.ok) return { retryAfterSec: r.retryAfterSec, kind };
  }
  return null;
}

const inWords = (sec) => (sec >= 120 ? `${Math.ceil(sec / 60)} minutes` : `${sec}s`);

/** `{ address, alternatives }` for what someone typed after /check, or null. */
async function resolveTarget(q) {
  const t = q.trim();
  if (ethers.isAddress(t)) return { address: ethers.getAddress(t), alternatives: [] };
  if (t.toLowerCase().endsWith(".etn")) {
    const a = await resolveEtnName(contractCheckProvider(), t).catch(() => null);
    return a ? { address: a, alternatives: [] } : null;
  }
  const results = await searchContracts(t).catch(() => []);
  if (!results.length) return null;
  return { address: results[0].address, alternatives: results.slice(1, 4).map((r) => r.label).filter(Boolean) };
}

/** createTelegramLinkRouter's onCommand for the Notis bot. Returns true if it handled the message. */
export async function handleNotisCommand({ text, chatId, chatType, linkedAddress, sendDirectMessage }) {
  const check = text.match(/^\/check(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  const alerts = text.match(/^\/contractalerts(?:@\w+)?(?:\s+(on|off))?\s*$/i);
  if (!check && !alerts) return false;
  if (chatType && chatType !== "private") return true; // groups: stay quiet

  const flood = overLimit([["cmdMin", commandsPerMinute], ["cmdHour", commandsPerHour]], chatId);
  if (flood) {
    await noticeOnce(chatId, flood.kind, flood.retryAfterSec * 1000, `⏳ Slow down — try again in ${inWords(flood.retryAfterSec)}.`, sendDirectMessage);
    return true;
  }

  if (!linkedAddress) {
    await noticeOnce(chatId, "link", 10 * MIN, `Contract Check is part of Core Tier. Link this chat to your Core Tier wallet first: on the dashboard, Core Tier → Telegram Alerts → link Telegram.\n${DASHBOARD_URL}/premium`, sendDirectMessage);
    return true;
  }
  if (!(await hasCoreAccess(linkedAddress))) {
    await noticeOnce(chatId, "member", 10 * MIN, `Contract Check is part of Core Tier, and the wallet linked here doesn't have an active membership.\n${DASHBOARD_URL}/premium`, sendDirectMessage);
    return true;
  }

  if (alerts) {
    const key = alertsMutedKey(linkedAddress);
    if (alerts[1]) await setAlertState(key, alerts[1].toLowerCase() === "off");
    const muted = (await getAlertState(key).catch(() => null)) === true;
    await sendDirectMessage(
      chatId,
      muted
        ? "🔕 Contract alerts are *off*: no approval or watchlist alerts. Send /contractalerts on to turn them back on."
        : "🔔 Contract alerts are *on*: you'll hear about new approvals to unknown or flagged contracts, and owner, implementation or code changes on tokens you hold. Send /contractalerts off to stop them."
    );
    return true;
  }

  const q = (check[1] || "").trim().slice(0, 80);
  if (!q) {
    await sendDirectMessage(chatId, "Send `/check` followed by a token symbol, a name.etn or a contract address — e.g. `/check CORE`.");
    return true;
  }
  const limited = overLimit([["checkHour", checksPerHour], ["checkDay", checksPerDay]], chatId);
  if (limited) {
    const daily = limited.kind === "checkDay";
    await noticeOnce(chatId, limited.kind, limited.retryAfterSec * 1000, `That's the limit for /check (${daily ? "100 a day" : "30 an hour"}) — more ${daily ? "tomorrow" : `in ${inWords(limited.retryAfterSec)}`}. The dashboard has no limit on looking contracts up.`, sendDirectMessage);
    return true;
  }
  if (!checksAllChats("all").ok) {
    await noticeOnce(chatId, "busy", 2 * MIN, "Contract Check is busy right now — try again in a couple of minutes.", sendDirectMessage);
    return true;
  }

  const target = await resolveTarget(q);
  if (!target) {
    await sendDirectMessage(chatId, `Couldn't find a contract for "${md(q)}". Try its symbol, a name.etn or the contract address.`);
    return true;
  }
  const facts = await analyseContract(target.address).catch(() => null);
  if (!facts) {
    await sendDirectMessage(chatId, "Couldn't check that contract right now — try again shortly.");
    return true;
  }
  // The shared summary, only if it's already cached (the dashboard writes it) — /check never spends a Claude call.
  const oneLiner = facts.identity?.isContract === false ? null : (await explainContract(facts, { cachedOnly: true }).catch(() => null))?.summary?.oneLiner || null;
  await sendDirectMessage(chatId, formatCheckCard({ facts, oneLiner, link: cardLink(facts.address), alternatives: target.alternatives }), facts.identity?.isContract === false ? {} : feedbackButtons("card", facts.address));
  return true;
}

/** createTelegramLinkRouter's onCallback for the Notis bot: "Was this right?" taps. */
export async function handleNotisCallback({ data, chatId, linkedAddress, answer }) {
  const fb = parseFeedback(data);
  if (!fb) return answer("");
  // what was judged, for the labelled data: a contract's badge and flags as they are now
  let snapshot = null;
  if (fb.kind === "approval" || fb.kind === "card") {
    const facts = await analyseContract(fb.ref).catch(() => null);
    if (facts) snapshot = { overall: facts.overall, flags: (facts.riskFlags || []).map((f) => `${f.id}:${f.severity}`) };
  }
  await saveFeedback({ source: "telegram", owner: linkedAddress, kind: fb.kind, ref: fb.ref, verdict: fb.verdict, snapshot: { ...(snapshot || {}), chat: String(chatId) } });
  await answer(fb.verdict === "right" ? "Thanks — noted 👍" : "Thanks — we'll look into it 👀");
}
