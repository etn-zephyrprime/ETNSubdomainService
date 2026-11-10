// Contract Check on Telegram (phase 4): the Planet Zephyros Notis bot's commands (notisLinkRouter.js).
//
//   /check <symbol | name.etn | address>   a compact contract card, from the same backend as the dashboard
//   /contractalerts on | off               the approval and watchlist alerts (contractAlertScheduler.js)
//
// Core Tier only, like the rest of Contract Check: the chat must be linked to a wallet (the dashboard's
// Telegram link) that has Core access. Private chats only — in a group it stays quiet.
import { ethers } from "ethers";
import { analyseContract } from "./analyseContract.js";
import { contractCheckProvider } from "./fetchContractData.js";
import { explainContract } from "./explain.js";
import { searchContracts } from "./lists.js";
import { formatCheckCard, md } from "./telegramCards.js";
import { resolveEtnName } from "../../utils/primaryNameResolver.js";
import { hasCoreAccess } from "../../utils/premiumAccess.js";
import { createRateLimiter } from "../../utils/rateLimit.js";
import { getAlertState, setAlertState } from "../../db/contractAlerts.js";

const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://dashboard.planetzephyros.xyz";
export const cardLink = (address) => `${DASHBOARD_URL}/premium?contract=${address}`;
const checksByChat = createRateLimiter({ max: 20, windowMs: 10 * 60 * 1000 });

export const alertsMutedKey = (owner) => `muted:${owner.toLowerCase()}`;

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

  if (!linkedAddress) {
    await sendDirectMessage(chatId, `Contract Check is part of Core Tier. Link this chat to your Core Tier wallet first: on the dashboard, Core Tier → Telegram Alerts → link Telegram.\n${DASHBOARD_URL}/premium`);
    return true;
  }
  if (!(await hasCoreAccess(linkedAddress))) {
    await sendDirectMessage(chatId, `Contract Check is part of Core Tier, and the wallet linked here doesn't have an active membership.\n${DASHBOARD_URL}/premium`);
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
  const r = checksByChat(`check:${chatId}`);
  if (!r.ok) {
    await sendDirectMessage(chatId, `That's a lot of checks — try again in ${r.retryAfterSec}s.`);
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
  // The shared, cached summary (the same one the dashboard shows); skipped if it can't be had.
  const oneLiner = facts.identity?.isContract === false ? null : (await explainContract(facts).catch(() => null))?.summary?.oneLiner || null;
  await sendDirectMessage(chatId, formatCheckCard({ facts, oneLiner, link: cardLink(facts.address), alternatives: target.alternatives }));
  return true;
}
