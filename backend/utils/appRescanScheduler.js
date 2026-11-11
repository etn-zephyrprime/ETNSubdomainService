// App Check rescans and watched-app alerts (in-process, like the other schedulers started from index.js).
//
// Every RESCAN.tickMs (30 min):
//   1. registry host lists: an app whose hosts changed since last recorded gets a domain_changed event
//      (and its cached results invalidate themselves: the registry hash is part of the cache check);
//   2. registry apps are rescanned every 6h, watched apps every 24h (everything else only on demand, and
//      expires by TTL). "Due" is measured from the last OK scan, so a failed or partial scan never counts as
//      done — it's retried after RESCAN.retryFailedMs, and it produces no events (the previous good scan
//      stays the baseline). A scan is claimed by compare-and-set first, so two overlapping servers during
//      a deploy don't both scan (and double the events);
//   3. alerts: each member watching apps gets the new alertable events for them (contract_added at caution
//      or above, contract_changed, contract_removed, domain_changed — never frontend_redeployed), through
//      a per-member compare-and-set cursor: exactly one server sends each. /contractalerts off is respected.
import { getKnownApps, primaryHost } from "../services/appCheck/registry.js";
import { getAppResult } from "../services/appCheck/appCheckService.js";
import { ScanUnavailable } from "../services/appCheck/scanSite.js";
import { domainChangedEvent, hostsKey, isAlertable } from "../services/appCheck/changeEvents.js";
import { formatAppChangeAlert } from "../services/appCheck/telegramApp.js";
import { RESCAN, ALERT_TYPES, ADDED_ALERT_MIN_SEVERITY } from "../services/appCheck/appCheck.config.js";
import * as appDb from "../db/appCheck.js";
import { getAlertState, advanceAlertState } from "../db/contractAlerts.js";
import { alertsMutedKey } from "../services/contractCheck/telegramCheck.js";
import { getNotisLinkState } from "../state/notisLinkState.js";
import { sendNotisDirectMessage, notisConfigured } from "./notisLinkRouter.js";
import { hasCoreAccess } from "./premiumAccess.js";
import { runHeavy } from "./heavyWork.js";

const originOf = (app) => (primaryHost(app) ? `https://${primaryHost(app)}` : null);

/** Records each registry app's host list; a change becomes a domain_changed event. */
export async function checkRegistryHosts(apps, { store = appDb, state = { get: getAlertState, advance: advanceAlertState } } = {}) {
  const events = [];
  for (const app of apps) {
    const key = `apphosts:${app.slug}`;
    const recorded = await state.get(key).catch(() => undefined);
    if (recorded === undefined) continue; // database unreachable
    const now = hostsKey(app);
    if (recorded === now) continue;
    if (!(await state.advance(key, recorded, now).catch(() => false))) continue; // another server has it
    const e = domainChangedEvent(app, recorded, { origin: originOf(app) });
    if (e) events.push(e);
  }
  if (events.length) await store.insertAppChangeEvents(events);
  return events;
}

/** Whether an origin is due a rescan: no OK scan within `everyMs`, and no failed attempt in the last hour. */
export async function isDue(origin, everyMs, now, store = appDb) {
  const [latest] = await store.latestAppScans(origin, { limit: 1 });
  const [lastOk] = latest?.status === "ok" ? [latest] : await store.latestAppScans(origin, { status: "ok", limit: 1 });
  if (lastOk && now - Date.parse(lastOk.scannedAt) < everyMs) return false;
  if (latest && latest.status !== "ok" && now - Date.parse(latest.scannedAt) < RESCAN.retryFailedMs) return false;
  return true;
}

/** Claims an origin's scan for this server (compare-and-set), so overlapping servers don't both scan it. */
export async function claimScan(origin, now, state = { get: getAlertState, advance: advanceAlertState }) {
  const key = `appscan:${origin}`;
  const prev = await state.get(key).catch(() => undefined);
  if (prev === undefined) return false;
  if (prev && now - Number(prev.at || 0) < RESCAN.claimMs) return false;
  return state.advance(key, prev, { at: now }).catch(() => false);
}

async function rescan(origin, now) {
  if (!(await isDue(origin.origin, origin.everyMs, now))) return;
  if (!(await claimScan(origin.origin, now))) return;
  try {
    const r = await runHeavy("appRescan", () => getAppResult(origin.origin, { core: true, scan: true, force: true }));
    console.log(`🔎 App Check rescan: ${origin.origin} — ${r.scan?.status || "no scan"} (${r.overall})`);
  } catch (err) {
    if (err instanceof ScanUnavailable) console.log(`ℹ️  App Check rescan of ${origin.origin} skipped (${err.code}) — next run`);
    else console.warn(`⚠️  App Check rescan of ${origin.origin} failed:`, err.message);
  }
}

/** Linked Notis wallets with Core access and alerts on: Map(wallet -> chatId). */
async function alertRecipients() {
  const subs = (await getNotisLinkState().catch(() => null))?.subscriptions || {};
  const out = new Map();
  for (const [owner, sub] of Object.entries(subs)) {
    if (sub?.chatId == null) continue;
    if ((await getAlertState(alertsMutedKey(owner)).catch(() => null)) === true) continue;
    if (!(await hasCoreAccess(owner).catch(() => false))) continue;
    out.set(owner.toLowerCase(), sub.chatId);
  }
  return out;
}

/**
 * Sends each watching member their new alertable events. Injectable for tests.
 * @returns [{ wallet, eventId }] sent
 */
export async function sendAppAlerts({ store = appDb, state = { get: getAlertState, advance: advanceAlertState }, recipients = alertRecipients, send = sendNotisDirectMessage, apps = null } = {}) {
  const follows = await store.allAppFollows();
  if (!follows.length) return [];
  const latest = await store.latestAppChangeEventId();
  const who = await recipients();
  const registry = apps || (await getKnownApps());
  const appName = (id) => registry.find((a) => a.id === id)?.name || null;
  const byWallet = new Map();
  for (const f of follows) byWallet.set(f.wallet, [...(byWallet.get(f.wallet) || []), f]);
  const sent = [];
  for (const [wallet, mine] of byWallet) {
    const chatId = who.get(wallet);
    if (chatId == null) continue; // not linked, not Core, or alerts off
    const key = `appev:${wallet}`;
    const cursor = await state.get(key).catch(() => undefined);
    if (cursor === undefined) continue;
    if (cursor !== null && latest <= cursor) continue;
    if (!(await state.advance(key, cursor, latest).catch(() => false))) continue; // another server sends these
    if (cursor === null) continue; // a new watcher: from now on
    for (const e of await store.appChangeEventsSince(cursor)) {
      if (e.id > latest) continue;
      if (!isAlertable(e, { types: ALERT_TYPES, addedMinSeverity: ADDED_ALERT_MIN_SEVERITY })) continue;
      if (!mine.some((f) => f.origin === e.origin || (f.appId && f.appId === e.appId))) continue;
      await send(chatId, formatAppChangeAlert(e, { appName: appName(e.appId) }));
      sent.push({ wallet, eventId: e.id });
    }
  }
  return sent;
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const apps = await getKnownApps();
    await checkRegistryHosts(apps);
    const targets = new Map();
    for (const app of apps) {
      const origin = originOf(app);
      if (origin) targets.set(origin, { origin, everyMs: RESCAN.registryEveryMs });
    }
    for (const f of await appDb.allAppFollows().catch(() => [])) if (!targets.has(f.origin)) targets.set(f.origin, { origin: f.origin, everyMs: RESCAN.followedEveryMs });
    for (const t of targets.values()) await rescan(t, now); // one at a time
    if (notisConfigured()) {
      const sent = await sendAppAlerts();
      if (sent.length) console.log(`🔔 App Check alerts: ${sent.length} sent`);
    }
  } catch (err) {
    console.error("⚠️  App Check rescan job failed:", err.message);
  } finally {
    running = false;
  }
}

export function startAppRescans() {
  if (!process.env.DATABASE_URL) {
    console.log("ℹ️  Database not configured — App Check rescans disabled");
    return;
  }
  console.log(`🔎 App Check rescans started (registry apps every ${RESCAN.registryEveryMs / 3600000}h, watched apps every ${RESCAN.followedEveryMs / 3600000}h)`);
  setTimeout(tick, 15 * 60 * 1000);
  setInterval(tick, RESCAN.tickMs);
}
