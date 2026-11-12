// App Check phase 3: the cached, revalidated, change-tracked Core result, plus follows.
//
// Cache (app_check_cache, by normalised origin; TTL 6h for registry apps, 24h otherwise). Before a cached
// result is reused it's revalidated cheaply:
//   - contracts: each one's fingerprint (code hash + implementation + owner — Contract Check's cheap read) is
//     compared with the one stored with it. Only the contracts that differ are re-analysed; if none differ,
//     nothing is re-analysed. Reads go one at a time (RPC limits).
//   - frontend: a cached scan older than an hour gets ONE conditional request for its HTML. A 304, the same
//     HTML hash, or the same script URL list (bundlers put content hashes in script names) reuses the
//     stored address set; anything else triggers a full rescan.
//   - the matched app's registry entry (hosts + contracts) changing invalidates the cache.
// Every result carries cache: { hit, ageSeconds, revalidated } for "checked N min ago".
//
// Scans are stored (app_scans) and diffed against the previous ok scans (changeEvents.js); events go to
// app_change_events, and a registry app's scanned contracts to known_app_contracts (source 'scan').
// No Claude calls anywhere here.
import crypto from "crypto";
import { normaliseInput } from "./normaliseInput.js";
import { matchApp } from "./matchApp.js";
import { getKnownApps, findAppsByName, primaryHost } from "./registry.js";
import { checkApp } from "./appCheck.js";
import { computeOverall } from "./appResult.js";
import { pageScripts } from "./extractAddresses.js";
import { safeFetchText } from "./safeFetch.js";
import { diffScan, contractChangedEvents, hostsKey } from "./changeEvents.js";
import { CACHE, FOLLOW } from "./appCheck.config.js";
import { analyseContract, cachedFingerprint, fingerprintChanges } from "../contractCheck/analyseContract.js";
import { fetchFingerprint } from "../contractCheck/fetchContractData.js";
import * as db from "../../db/appCheck.js";

const DEFAULT_DEPS = { store: db, analyse: analyseContract, fingerprint: (a) => fetchFingerprint(a), cachedFingerprint, fetchText: safeFetchText, fetchImpl: undefined, getCode: undefined, apps: null };

const sha = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

/** What invalidates a cached result when the registry changes: the matched app's hosts and registry contracts. */
// Bumped when a fix changes what a stored result would say, so every cached result is rebuilt once.
// 2: scan-sourced registry rows no longer count as an app's own contracts (false "uses contracts belonging to").
const RESULT_VERSION = 2;

export const registryHashOf = (match) =>
  match.app
    ? sha([RESULT_VERSION, match.status, match.app.slug, hostsKey(match.app), match.app.contracts.filter((c) => c.source === "registry").map((c) => c.address).sort()])
    : `none:${match.status}:v${RESULT_VERSION}`;

const appIdOf = (match) => (match.status === "known" && match.app.id > 0 ? match.app.id : null);

/** A contract row refreshed from new facts, keeping where it came from (registry role, scan labels). */
function refreshedRow(row, facts) {
  const flags = facts.riskFlags || [];
  return { ...row, label: row.label || facts.identity?.known?.label || null, overall: facts.overall, flagCount: flags.length, topFlags: flags.slice(0, 3).map((f) => ({ id: f.id, severity: f.severity })), incomplete: !!facts.incomplete, note: undefined };
}

/** The badge again, after some contracts changed (same rules as assembleResult). */
function rebadge(result, match) {
  const badgeContracts = match.status === "known" ? result.contracts.filter((c) => c.source === "registry") : result.contracts;
  const { overall, overallReason } = computeOverall({ status: match.status, app: match.app, resembles: match.resembles, contracts: badgeContracts, domainFlags: result.flags || result.domain?.flags || [], scan: result.scan });
  result.overall = overall;
  result.overallReason = overallReason;
  result.fingerprint = sha([result.status, result.app?.slug || null, result.contracts.map((c) => [c.address, c.overall]), (result.flags || []).map((f) => f.id)]);
}

/** Stores a scan and its change events; returns the events. */
export async function recordScan(n, match, scan, { store = db } = {}) {
  const origin = n.origin;
  const appId = appIdOf(match);
  const previousOk = await store.latestAppScans(origin, { status: "ok", limit: 2 });
  const events = diffScan(scan, previousOk, { origin, appId });
  await store.insertAppScan({ origin, appId, scan });
  if (events.length) await store.insertAppChangeEvents(events);
  if (appId && scan.status === "ok") {
    await store.upsertScanContracts(appId, scan.contracts.map((c) => c.address));
    for (const e of events) if (e.type === "contract_removed") await store.markScanContractRemoved(appId, e.details.address);
  }
  if (events.length) console.log(`🔎 App Check: ${origin} — ${events.map((e) => e.type).join(", ")}`);
  return events;
}

const scanMeta = (scan, now) => ({ htmlHash: scan.htmlHash, etag: scan.etag, lastModified: scan.lastModified, scriptUrls: scan.scriptUrls, scannedAt: scan.scannedAt, frontendCheckedAt: new Date(now).toISOString() });

async function withChanges(result, n, match, store) {
  result.changes = await store.recentAppChangeEvents({ origin: n.origin, appId: appIdOf(match), limit: CACHE.changesShown }).catch(() => []);
  return result;
}

/** A fresh Core result (scanning if asked), stored in the cache. */
async function freshResult(input, n, match, registry, { scan, deps, now }) {
  let full = null;
  const result = await checkApp(input, { core: true, scan, apps: registry, analyse: deps.analyse, fetchImpl: deps.fetchImpl, fetchText: deps.fetchText, getCode: deps.getCode, now, onScan: (s) => (full = s) });
  for (const c of result.contracts) if (!c.fingerprint && c.overall && c.overall !== "unknown") c.fingerprint = deps.cachedFingerprint(c.address);
  if (full) await recordScan(n, match, full, { store: deps.store }).catch((err) => console.warn(`⚠️  App Check: couldn't store the scan of ${n.origin}:`, err.message));
  const meta = { registryHash: registryHashOf(match), scan: full ? scanMeta(full, now) : null };
  const ttl = match.status === "known" ? CACHE.knownAppTtlMs : CACHE.otherTtlMs;
  await deps.store
    .putAppCache({ origin: n.origin, result, fingerprint: result.fingerprint, meta, checkedAt: result.checkedAt, expiresAt: new Date(now + ttl).toISOString() })
    .catch((err) => console.warn(`⚠️  App Check: couldn't cache ${n.origin}:`, err.message));
  result.scanRan = !!full;
  return withChanges(result, n, match, deps.store);
}

/** Cheap revalidation of a cached result (see the header). */
async function revalidated(cached, input, n, match, registry, { deps, now }) {
  const result = structuredClone(cached.result);
  const meta = structuredClone(cached.meta || {});
  let didCheck = false;

  // frontend: one conditional request for the HTML, at most hourly
  if (result.scan && meta.scan && now - Date.parse(meta.scan.frontendCheckedAt || meta.scan.scannedAt) > CACHE.frontendRecheckMs) {
    didCheck = true;
    let changed = false;
    try {
      const r = await deps.fetchText(n.url, { kind: "html", conditional: { etag: meta.scan.etag, lastModified: meta.scan.lastModified } });
      if (r.status === 304) changed = false;
      else if (r.status === 200 && r.body != null) {
        const sameHtml = r.sha256 === meta.scan.htmlHash;
        const sameScripts = JSON.stringify(pageScripts(r.body, r.url).scriptUrls) === JSON.stringify(meta.scan.scriptUrls || []);
        changed = !sameHtml && !sameScripts;
      }
      // any other status: unknown, never "changed"
    } catch {
      /* unknown: keep the stored scan */
    }
    if (changed) {
      const fresh = await freshResult(input, n, match, registry, { scan: true, deps, now });
      fresh.cache = { hit: false, ageSeconds: 0, revalidated: true };
      return fresh;
    }
    meta.scan.frontendCheckedAt = new Date(now).toISOString();
  }

  // contracts: fingerprint each one; re-analyse only those that changed
  const changedRows = [];
  for (const [i, row] of result.contracts.entries()) {
    if (!row.fingerprint) continue;
    let fp;
    try {
      fp = await deps.fingerprint(row.address);
    } catch {
      continue; // unknown: keep what we had
    }
    didCheck = true;
    const changes = fingerprintChanges(row.fingerprint, fp);
    if (!changes.length) continue;
    try {
      const facts = await deps.analyse(row.address);
      result.contracts[i] = { ...refreshedRow(row, facts), fingerprint: deps.cachedFingerprint(row.address) || fp };
      changedRows.push({ address: row.address, label: row.label, changes, facts });
    } catch {
      result.contracts[i] = { ...row, fingerprint: row.fingerprint }; // try again next time
    }
  }
  if (changedRows.length) {
    const events = contractChangedEvents(changedRows, { origin: n.origin, appId: appIdOf(match) });
    await deps.store.insertAppChangeEvents(events).catch((err) => console.warn("⚠️  App Check: couldn't record contract changes:", err.message));
    rebadge(result, match);
  }
  await deps.store.putAppCache({ origin: n.origin, result, fingerprint: result.fingerprint, meta, checkedAt: cached.checkedAt, expiresAt: cached.expiresAt }).catch(() => {});
  result.cache = { hit: true, ageSeconds: Math.max(0, Math.round((now - Date.parse(cached.checkedAt)) / 1000)), revalidated: didCheck };
  result.scanRan = false;
  return withChanges(result, n, match, deps.store);
}

/**
 * The App Check result for what someone typed. Free = the lookalike check (never cached, never external).
 * Core = cached + revalidated; `scan` scans the site when there's no stored scan yet (or `force` = Rescan).
 * `result.scanRan` says whether a scan actually ran (what the daily limit counts).
 */
export async function getAppResult(input, { core = false, scan = false, force = false, now = Date.now(), ...overrides } = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  if (!core) return checkApp(input, { core: false, apps: deps.apps });
  const n = normaliseInput(input);
  if (!n.ok || n.kind !== "url") return checkApp(input, { core: true, apps: deps.apps });
  const registry = deps.apps || (await getKnownApps());
  const match = matchApp(n, registry);

  const cached = await deps.store.getAppCache(n.origin).catch(() => null);
  const usable = cached && cached.result?.tier === "core" && Date.parse(cached.expiresAt) > now && cached.meta?.registryHash === registryHashOf(match);
  const needScan = scan && (force || !cached?.result?.scan);
  if (usable && !needScan) return revalidated(cached, input, n, match, registry, { deps, now });
  return freshResult(input, n, match, registry, { scan: needScan || (scan && !usable), deps, now });
}

// ── follows ────────────────────────────────────────────────────────────────────────────────────────────
/** Follow (watch) an app for a member: `{ ok, origin, app }` or `{ ok: false, error }`. */
export async function followApp(wallet, input, { store = db, apps = null } = {}) {
  const n = normaliseInput(input);
  const registry = apps || (await getKnownApps());
  let origin;
  let app = null;
  if (n.ok && n.kind === "url") {
    origin = n.origin;
    const m = matchApp(n, registry);
    if (m.status === "lookalike") return { ok: false, error: `That site resembles ${m.resembles} but isn't a listed site for it — not something to watch.` };
    if (m.status === "known") app = m.app;
  } else if (n.ok && n.kind === "name") {
    app = findAppsByName(n.query, registry)[0] || null;
    if (!app) return { ok: false, error: "No app with that name in our registry — use its website address." };
    origin = `https://${primaryHost(app)}`;
  } else {
    return { ok: false, error: n.message || "Enter a website address or an app name." };
  }
  const existing = await store.listAppFollows(wallet);
  if (!existing.some((f) => f.origin === origin) && existing.length >= FOLLOW.maxPerMember) return { ok: false, error: `You're already watching ${FOLLOW.maxPerMember} apps — unwatch one first.` };
  await store.addAppFollow(wallet, origin, app && app.id > 0 ? app.id : null);
  return { ok: true, origin, app: app ? { slug: app.slug, name: app.name } : null };
}

/** Unfollow by URL, domain or app name: `{ ok, origin }`. */
export async function unfollowApp(wallet, input, { store = db, apps = null } = {}) {
  const n = normaliseInput(input);
  let origin = n.ok && n.kind === "url" ? n.origin : null;
  if (n.ok && n.kind === "name") {
    const app = findAppsByName(n.query, apps || (await getKnownApps()))[0];
    if (app) origin = `https://${primaryHost(app)}`;
  }
  if (!origin) return { ok: false, error: "Enter the website address you're watching." };
  return { ok: await store.removeAppFollow(wallet, origin), origin };
}
