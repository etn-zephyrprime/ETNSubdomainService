// App Check on Telegram (the Planet Zephyros Notis bot, via contractCheck/telegramCheck.js):
//
//   /checkapp <url | name>     a compact card: status, badge, contract count, top flags, link to the full card.
//                              Anyone gets the lookalike check; Core members get the full (cached) result.
//                              Never scans — scanning is a dashboard action (it has its own daily limit).
//   /watchapp <url | name>     Core: watch an app (alerts on contract changes; respects /contractalerts off)
//   /unwatchapp <url | name>   Core: stop watching it
//
// Escaping: every value that isn't our own fixed text goes through md() (legacy Markdown), including the
// host the member typed and registry names. Nothing a scanned site controls is ever put in a message.
import { md } from "../contractCheck/telegramCards.js";
import { getAppResult, followApp, unfollowApp } from "./appCheckService.js";
import { listAppFollows } from "../../db/appCheck.js";
import { FOLLOW } from "./appCheck.config.js";

const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://dashboard.planetzephyros.xyz";
export const appCardLink = (origin) => `${DASHBOARD_URL}/premium?app=${encodeURIComponent(origin)}`;

const BADGE = { red: "🔴", amber: "🟡", green: "🟢", unassessed: "⚪" };
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const flagWords = (id) => String(id).replace(/_/g, " ");

/** The /checkapp card for an App Check result (free or Core). */
export function formatAppCard(r) {
  if (r.status === "invalid") return `Can't check that: ${md(r.error?.message || "not a website address")}`;
  if (r.status === "name") {
    if (!r.apps?.length) return "No app with that name in our registry. Send `/checkapp` with the website address instead.";
    return ["Which app?", ...r.apps.map((a) => `• ${md(a.name)}: /checkapp ${md(a.primaryHost)}`)].join("\n");
  }
  const host = md(r.normalised?.displayHost || r.normalised?.host || "");
  const lines = [`${BADGE[r.overall] || "🔎"} *App Check:* ${host}`];
  if (r.status === "known") lines.push(`✅ Listed site for ${md(r.app.name)}`);
  else if (r.status === "lookalike") lines.push(`⚠️ *Resembles ${md(r.resembles)} (${md(r.app.name)}) but isn't a listed site for it*`);
  else lines.push("Not in our registry");
  if (r.overallReason) lines.push(md(r.overallReason));
  if (r.status === "lookalike") for (const reason of (r.lookalikeReasons || []).slice(0, 3)) lines.push(`• ${md(reason)}`);

  if (r.tier === "core") {
    const contracts = r.contracts || [];
    if (contracts.length) {
      const red = contracts.filter((c) => c.overall === "red").length;
      const amber = contracts.filter((c) => c.overall === "amber").length;
      lines.push(`Contracts: ${contracts.length}${red || amber ? ` (${[red && `${red} 🔴`, amber && `${amber} 🟡`].filter(Boolean).join(", ")})` : ""}`);
      const flagged = contracts.filter((c) => c.overall === "red" || c.overall === "amber").sort((a, b) => (a.overall === "red" ? -1 : 0) - (b.overall === "red" ? -1 : 0));
      for (const c of flagged.slice(0, 3)) lines.push(`• ${BADGE[c.overall]} ${md(c.label || c.role || short(c.address))}: ${md((c.topFlags || []).filter((f) => f.severity !== "info").map((f) => flagWords(f.id)).join(", "))}`);
    }
    if (r.domain) lines.push(`Domain: ${typeof r.domain.ageDays === "number" ? `registered ${r.domain.ageDays} days ago` : "age unknown"}${r.domain.https === false ? ", not https" : ""}`);
    if (r.status !== "known" && !r.scan) lines.push("Not scanned yet — scan it from the card on the dashboard.");
    if (r.cache?.hit) lines.push(`_Checked ${Math.max(1, Math.round(r.cache.ageSeconds / 60))} min ago_`);
  } else if (r.status !== "lookalike") {
    lines.push("Core Tier checks its contracts and domain, and can scan and watch it.");
  }
  lines.push(appCardLink(r.normalised.origin));
  return lines.join("\n");
}

const CHANGE_TEXT = {
  contract_added: (d) => `a new contract was added${d.label ? ` (${md(d.label)})` : ""}.${d.flagCount ? ` It has ${d.flagCount} flag${d.flagCount === 1 ? "" : "s"}.` : ""}`,
  contract_removed: (d) => `a contract it used (${md(short(d.address))}) is no longer in its code.`,
  contract_changed: (d) => `a contract it uses${d.label ? ` (${md(d.label)})` : ""} changed its ${md((d.changes || []).map((c) => ({ codeHash: "code", implementation: "implementation", owner: "owner" })[c.field] || c.field).join(" and "))}.`,
  domain_changed: (d) => `its list of websites in our registry changed${d.added?.length ? ` — added ${md(d.added.join(", "))}` : ""}${d.removed?.length ? ` — removed ${md(d.removed.join(", "))}` : ""}.`,
};

/** The alert for one change event on a watched app. */
export function formatAppChangeAlert(e, { appName = null } = {}) {
  const icon = e.severity === "high" ? "🔴" : e.severity === "caution" ? "🟡" : "🔔";
  const who = md(appName || e.origin.replace(/^https?:\/\//, ""));
  return `${icon} *An app you're watching changed* — ${who}: ${(CHANGE_TEXT[e.type] || (() => "something changed."))(e.details || {})} See the card.\n${appCardLink(e.origin)}`;
}

/**
 * Handles /checkapp, /watchapp, /unwatchapp (the caller has already applied the flood limits).
 * Returns true if it handled the message.
 */
export async function handleAppCommand({ text, chatId, linkedAddress, core, sendDirectMessage, getResult = getAppResult, follow = followApp, unfollow = unfollowApp, listFollows = listAppFollows }) {
  const m = text.match(/^\/(checkapp|watchapp|unwatchapp)(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || "").trim().slice(0, 300);

  if (cmd === "checkapp") {
    if (!arg) return sendDirectMessage(chatId, "Send `/checkapp` followed by a website address or an app name — e.g. `/checkapp app.electroswap.io`.").then(() => true);
    const r = await getResult(arg, { core: !!core }).catch(() => null);
    await sendDirectMessage(chatId, r ? formatAppCard(r) : "Couldn't check that right now — try again shortly.");
    return true;
  }

  if (!linkedAddress || !core) {
    await sendDirectMessage(chatId, `Watching apps is part of Core Tier.\n${DASHBOARD_URL}/premium`);
    return true;
  }
  if (!arg) {
    const list = await listFollows(linkedAddress).catch(() => []);
    await sendDirectMessage(
      chatId,
      cmd === "watchapp"
        ? `Send \`/watchapp\` followed by a website address or an app name. You're watching ${list.length} of ${FOLLOW.maxPerMember}${list.length ? `:\n${list.map((f) => `• ${md(f.origin.replace(/^https?:\/\//, ""))}`).join("\n")}` : "."}`
        : "Send `/unwatchapp` followed by the website address you're watching."
    );
    return true;
  }
  if (cmd === "watchapp") {
    const r = await follow(linkedAddress, arg).catch((err) => ({ ok: false, error: err.message }));
    await sendDirectMessage(chatId, r.ok ? `👀 Watching ${md(r.app?.name || r.origin.replace(/^https?:\/\//, ""))}. You'll hear here when its contracts change. (/contractalerts off pauses all alerts.)` : `Couldn't watch that: ${md(r.error)}`);
    return true;
  }
  const r = await unfollow(linkedAddress, arg).catch(() => ({ ok: false }));
  await sendDirectMessage(chatId, r.ok ? `Stopped watching ${md(r.origin.replace(/^https?:\/\//, ""))}.` : "You weren't watching that site.");
  return true;
}
