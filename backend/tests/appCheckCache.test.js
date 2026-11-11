// Argus App Check, phase 3: cache + cheap revalidation, stored scans and change events, alerts, follows,
// Telegram. An in-memory store stands in for the database; fixture sites only.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getAppResult, followApp, registryHashOf } from "../services/appCheck/appCheckService.js";
import { diffScan, changeSeverity, isAlertable } from "../services/appCheck/changeEvents.js";
import { sendAppAlerts, checkRegistryHosts, claimScan, isDue } from "../utils/appRescanScheduler.js";
import { formatAppCard, formatAppChangeAlert, handleAppCommand } from "../services/appCheck/telegramApp.js";
import { _resetScanGate } from "../services/appCheck/scanSite.js";
import { seedApps, validateApps } from "../services/appCheck/registry.js";
import { ALERT_TYPES, ADDED_ALERT_MIN_SEVERITY, FOLLOW } from "../services/appCheck/appCheck.config.js";

const APPS = validateApps(seedApps(), () => {}).map((a, i) => ({ ...a, id: i + 1 }));

// ── an in-memory store with the db/appCheck.js API ─────────────────────────────────────────────────────
function memoryStore() {
  const s = { cache: new Map(), scans: [], events: [], follows: [], scanContracts: [] };
  let scanId = 0, eventId = 0;
  return {
    s,
    getAppCache: async (o) => structuredClone(s.cache.get(o) || null),
    putAppCache: async (row) => void s.cache.set(row.origin, structuredClone(row)),
    insertAppScan: async ({ origin, appId, scan }) => {
      s.scans.push({ id: ++scanId, origin, appId, scannedAt: scan.scannedAt, status: scan.status, htmlHash: scan.htmlHash, scriptHashes: scan.scriptHashes, scriptUrls: scan.scriptUrls, contracts: scan.contracts.map((c) => c.address) });
      return scanId;
    },
    latestAppScans: async (origin, { status = null, limit = 2 } = {}) =>
      s.scans.filter((x) => x.origin === origin && (!status || x.status === status)).sort((a, b) => b.id - a.id).slice(0, limit),
    insertAppChangeEvents: async (events) => events.map((e) => (s.events.push({ ...e, id: ++eventId, detectedAt: new Date().toISOString() }), eventId)),
    recentAppChangeEvents: async ({ origin, appId }) => s.events.filter((e) => e.origin === origin || (appId && e.appId === appId)).reverse(),
    appChangeEventsSince: async (after) => s.events.filter((e) => e.id > after),
    latestAppChangeEventId: async () => eventId,
    upsertScanContracts: async (appId, addrs) => void s.scanContracts.push(...addrs.map((a) => ({ appId, a }))),
    markScanContractRemoved: async () => {},
    addAppFollow: async (wallet, origin, appId) => {
      s.follows = s.follows.filter((f) => !(f.wallet === wallet && f.origin === origin));
      s.follows.push({ wallet, origin, appId });
    },
    removeAppFollow: async (wallet, origin) => {
      const n = s.follows.length;
      s.follows = s.follows.filter((f) => !(f.wallet === wallet && f.origin === origin));
      return s.follows.length < n;
    },
    listAppFollows: async (wallet) => s.follows.filter((f) => f.wallet === wallet),
    allAppFollows: async () => s.follows,
  };
}

/** contract_alert_state with compare-and-set, shared by "two servers". */
function memoryState() {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null),
    advance: async (k, from, to) => {
      const cur = m.has(k) ? m.get(k) : null;
      if (JSON.stringify(cur) !== JSON.stringify(from)) return false;
      m.set(k, structuredClone(to));
      return true;
    },
  };
}

// ── a fixture site and chain ───────────────────────────────────────────────────────────────────────────
const SITE = "https://some-dapp.com/";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const page = (addrs, tag = "v1") => ({ status: 200, url: SITE, headers: { etag: `"${tag}"`, lastModified: null }, body: `<html data-v="${tag}"><script>${addrs.map((a) => `"${a}"`).join(",")}</script></html>`, sha256: `html-${tag}-${addrs.join("")}` });

function world() {
  const fp = new Map([[A, { codeHash: "ca", implementation: null, owner: "0xowner" }], [B, { codeHash: "cb", implementation: null, owner: "0xowner" }], [C, { codeHash: "cc", implementation: null, owner: "0xowner" }]]);
  const facts = new Map([[A, "green"], [B, "green"], [C, "red"]]);
  const calls = { analyse: [], fingerprint: [], fetch: [] };
  let site = page([A, B]);
  const deps = {
    apps: APPS,
    analyse: async (a) => {
      calls.analyse.push(a);
      const overall = facts.get(a) || "green";
      return { identity: { isContract: true }, overall, riskFlags: overall === "red" ? [{ id: "owner_can_mint", severity: "high" }] : [], proxy: { upgradeController: null } };
    },
    fingerprint: async (a) => (calls.fingerprint.push(a), structuredClone(fp.get(a))),
    cachedFingerprint: (a) => structuredClone(fp.get(a)),
    getCode: async () => "0x60",
    fetchText: async (u, { conditional } = {}) => {
      calls.fetch.push({ u, conditional });
      if (site.error) throw Object.assign(new Error(site.error), { code: site.error });
      if (conditional?.etag && conditional.etag === site.headers.etag) return { status: 304, url: u, headers: site.headers, body: null };
      return structuredClone(site);
    },
    fetchImpl: async () => {
      throw new Error("offline");
    },
  };
  return { fp, facts, calls, deps, setSite: (p) => (site = p) };
}

const HOUR = 3600 * 1000;
let T0;
beforeEach(() => {
  _resetScanGate();
  T0 = Date.parse("2026-11-12T10:00:00Z");
});
const reset = (calls) => {
  calls.analyse.length = 0;
  calls.fingerprint.length = 0;
  calls.fetch.length = 0;
  _resetScanGate();
};

// ── cache + revalidation ───────────────────────────────────────────────────────────────────────────────
test("unchanged contracts and HTML: the cached result is reused, nothing re-analysed", async () => {
  const w = world();
  const store = memoryStore();
  const first = await getAppResult(SITE, { core: true, scan: true, now: T0, store, ...w.deps });
  assert.equal(first.cache.hit, false);
  assert.equal(first.scanRan, true);
  reset(w.calls);
  const again = await getAppResult(SITE, { core: true, now: T0 + 2 * HOUR, store, ...w.deps });
  assert.equal(again.cache.hit, true);
  assert.equal(again.cache.revalidated, true);
  assert.equal(again.cache.ageSeconds, 7200);
  assert.deepEqual(w.calls.analyse, []); // no re-analysis
  assert.deepEqual(w.calls.fingerprint.sort(), [A, B].sort()); // the cheap reads only
  assert.equal(w.calls.fetch.length, 1); // one conditional HTML request
  assert.equal(w.calls.fetch[0].conditional.etag, '"v1"');
  assert.equal(again.scanRan, false);
});

test("within the hour, no frontend request at all", async () => {
  const w = world();
  const store = memoryStore();
  await getAppResult(SITE, { core: true, scan: true, now: T0, store, ...w.deps });
  reset(w.calls);
  await getAppResult(SITE, { core: true, now: T0 + 20 * 60 * 1000, store, ...w.deps });
  assert.equal(w.calls.fetch.length, 0);
});

test("one contract's owner changed: only that contract is re-analysed, and a contract_changed event recorded", async () => {
  const w = world();
  const store = memoryStore();
  await getAppResult(SITE, { core: true, scan: true, now: T0, store, ...w.deps });
  reset(w.calls);
  w.fp.get(B).owner = "0xnewowner";
  w.facts.set(B, "amber");
  const r = await getAppResult(SITE, { core: true, now: T0 + 10 * 60 * 1000, store, ...w.deps });
  assert.deepEqual(w.calls.analyse, [B]);
  assert.equal(r.contracts.find((c) => c.address === B).overall, "amber");
  assert.equal(r.overall, "amber"); // recomputed
  const ev = store.s.events.filter((e) => e.type === "contract_changed");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].details.address, B);
  assert.deepEqual(ev[0].details.changes, [{ field: "owner", from: "0xowner", to: "0xnewowner" }]);
  // and next time it's unchanged again: nothing re-analysed
  reset(w.calls);
  await getAppResult(SITE, { core: true, now: T0 + 20 * 60 * 1000, store, ...w.deps });
  assert.deepEqual(w.calls.analyse, []);
});

test("a changed page with a different script list triggers a full rescan", async () => {
  const w = world();
  const store = memoryStore();
  await getAppResult(SITE, { core: true, scan: true, now: T0, store, ...w.deps });
  reset(w.calls);
  w.setSite({ ...page([A, B, C], "v2"), body: `<html><script src="/assets/new-1.js"></script><script>"${A}","${B}","${C}"</script></html>` });
  const r = await getAppResult(SITE, { core: true, now: T0 + 2 * HOUR, store, ...w.deps });
  assert.equal(r.cache.revalidated, true);
  assert.equal(r.scanRan, true);
  assert.ok(r.contracts.some((c) => c.address === C));
  assert.equal(store.s.events.filter((e) => e.type === "contract_added").length, 1);
});

test("a registry change invalidates the cache", async () => {
  const w = world();
  const store = memoryStore();
  const url = "https://app.electroswap.io/";
  await getAppResult(url, { core: true, now: T0, store, ...w.deps });
  reset(w.calls);
  const changed = APPS.map((a) => (a.slug === "electroswap" ? { ...a, hosts: [...a.hosts, { host: "swap.electroswap.io", registrableDomain: false, primary: false }] } : a));
  const r = await getAppResult(url, { core: true, now: T0 + 60000, store, ...w.deps, apps: changed });
  assert.equal(r.cache.hit, false);
  assert.ok(w.calls.analyse.length > 0);
  assert.notEqual(registryHashOf({ status: "known", app: APPS.find((a) => a.slug === "electroswap") }), registryHashOf({ status: "known", app: changed.find((a) => a.slug === "electroswap") }));
});

test("an expired cache is rebuilt", async () => {
  const w = world();
  const store = memoryStore();
  await getAppResult(SITE, { core: true, now: T0, store, ...w.deps });
  const r = await getAppResult(SITE, { core: true, now: T0 + 25 * HOUR, store, ...w.deps });
  assert.equal(r.cache.hit, false);
});

test("a stored scan is reused by 'scan' unless it's a rescan", async () => {
  const w = world();
  const store = memoryStore();
  await getAppResult(SITE, { core: true, scan: true, now: T0, store, ...w.deps });
  _resetScanGate();
  const reuse = await getAppResult(SITE, { core: true, scan: true, now: T0 + 60000, store, ...w.deps });
  assert.equal(reuse.scanRan, false);
  _resetScanGate();
  const rescan = await getAppResult(SITE, { core: true, scan: true, force: true, now: T0 + 120000, store, ...w.deps });
  assert.equal(rescan.scanRan, true);
});

// ── change events ──────────────────────────────────────────────────────────────────────────────────────
const okScan = (addrs, html = "h1", scripts = { s: "1" }) => ({ status: "ok", htmlHash: html, scriptHashes: scripts, contracts: addrs.map((address) => ({ address, overall: address === C ? "red" : "green", flagCount: address === C ? 1 : 0 })) });
const stored = (scan) => ({ ...scan, contracts: scan.contracts.map((c) => c.address) });

test("same addresses, new HTML: frontend_redeployed (info), never alerted", () => {
  const events = diffScan(okScan([A, B], "h2"), [stored(okScan([A, B], "h1"))], { origin: SITE });
  assert.deepEqual(events.map((e) => [e.type, e.severity]), [["frontend_redeployed", "info"]]);
  assert.equal(isAlertable(events[0], { types: ALERT_TYPES, addedMinSeverity: ADDED_ALERT_MIN_SEVERITY }), false);
});

test("a new address: contract_added with the new contract's own severity", () => {
  const events = diffScan(okScan([A, B, C]), [stored(okScan([A, B]))], { origin: SITE });
  assert.deepEqual(events.map((e) => [e.type, e.severity, e.details.address]), [["contract_added", "high", C]]);
  const green = diffScan(okScan([A, B]), [stored(okScan([A]))], { origin: SITE });
  assert.equal(green[0].severity, "info");
  assert.equal(isAlertable(green[0], { types: ALERT_TYPES, addedMinSeverity: ADDED_ALERT_MIN_SEVERITY }), false); // below caution
});

test("missing from one ok scan: nothing; missing from two consecutive: contract_removed", () => {
  const s1 = stored(okScan([A, B]));
  const once = diffScan(okScan([A]), [s1], { origin: SITE });
  assert.equal(once.filter((e) => e.type === "contract_removed").length, 0);
  const twice = diffScan(okScan([A]), [stored(okScan([A])), s1], { origin: SITE });
  assert.deepEqual(twice.map((e) => [e.type, e.details.address]), [["contract_removed", B]]);
});

test("a partial or failed scan: no events, and the previous good scan stays the baseline", async () => {
  assert.deepEqual(diffScan({ ...okScan([C]), status: "partial" }, [stored(okScan([A]))], { origin: SITE }), []);
  assert.deepEqual(diffScan({ status: "failed", contracts: [] }, [stored(okScan([A]))], { origin: SITE }), []);
  assert.deepEqual(diffScan(okScan([A]), [], { origin: SITE }), []); // first good scan = baseline

  // end to end: ok baseline -> failed (5xx) -> ok with the same set => still no events
  const w = world();
  const store = memoryStore();
  await getAppResult(SITE, { core: true, scan: true, force: true, now: T0, store, ...w.deps });
  _resetScanGate();
  w.setSite({ status: 503, url: SITE, headers: {}, body: null });
  const failed = await getAppResult(SITE, { core: true, scan: true, force: true, now: T0 + HOUR, store, ...w.deps });
  assert.equal(failed.scan.status, "failed");
  assert.notEqual(failed.overall, "green");
  _resetScanGate();
  w.setSite(page([A, B]));
  await getAppResult(SITE, { core: true, scan: true, force: true, now: T0 + 2 * HOUR, store, ...w.deps });
  assert.deepEqual(store.s.events, []);
  assert.deepEqual(store.s.scans.map((x) => x.status), ["ok", "failed", "ok"]);
});

test("change severity: a proxy upgraded by a plain wallet is high", () => {
  assert.equal(changeSeverity([{ field: "implementation" }], { proxy: { upgradeController: { type: "eoa" } } }), "high");
  assert.equal(changeSeverity([{ field: "implementation" }], { proxy: { upgradeController: { type: "contract" } } }), "caution");
  assert.equal(changeSeverity([{ field: "codeHash" }], {}), "high");
  assert.equal(changeSeverity([{ field: "owner" }], {}), "caution");
});

// ── rescan job ─────────────────────────────────────────────────────────────────────────────────────────
test("due is measured from the last OK scan; a failed attempt waits an hour; a scan is claimed once", async () => {
  const store = memoryStore();
  assert.equal(await isDue(SITE, 6 * HOUR, T0, store), true);
  store.s.scans.push({ id: 1, origin: SITE, scannedAt: new Date(T0 - 7 * HOUR).toISOString(), status: "ok", contracts: [] });
  store.s.scans.push({ id: 2, origin: SITE, scannedAt: new Date(T0 - 10 * 60 * 1000).toISOString(), status: "failed", contracts: [] });
  assert.equal(await isDue(SITE, 6 * HOUR, T0, store), false); // failed 10 min ago
  assert.equal(await isDue(SITE, 6 * HOUR, T0 + HOUR, store), true); // the OK scan is still 7h+ old
  const state = memoryState();
  assert.equal(await claimScan(SITE, T0, state), true);
  assert.equal(await claimScan(SITE, T0 + 1000, state), false); // the other server
});

test("registry host changes become domain_changed, recorded once", async () => {
  const store = memoryStore();
  const state = memoryState();
  const es = APPS.find((a) => a.slug === "electroswap");
  assert.deepEqual(await checkRegistryHosts([es], { store, state }), []); // first look: recorded, no event
  const changed = { ...es, hosts: [...es.hosts, { host: "swap.electroswap.io", registrableDomain: false }] };
  const [e] = await checkRegistryHosts([changed], { store, state });
  assert.equal(e.type, "domain_changed");
  assert.deepEqual(e.details.added, ["swap.electroswap.io"]);
  assert.deepEqual(await checkRegistryHosts([changed], { store, state }), []);
});

// ── alerts ─────────────────────────────────────────────────────────────────────────────────────────────
async function alertSetup() {
  const store = memoryStore();
  const state = memoryState();
  const alice = "0xaaaa000000000000000000000000000000000001";
  const bob = "0xbbbb000000000000000000000000000000000002";
  await store.addAppFollow(alice, SITE, null);
  const sent = [];
  const opts = { store, state, apps: APPS, recipients: async () => new Map([[alice, 101], [bob, 202]]), send: async (chat, text) => sent.push({ chat, text }) };
  await sendAppAlerts(opts); // cursors start at "now"
  return { store, state, alice, bob, sent, opts };
}

test("alerts: sent once even with two servers, only to followers, never for frontend_redeployed", async () => {
  const { store, sent, opts } = await alertSetup();
  await store.insertAppChangeEvents([
    { origin: SITE, type: "contract_added", severity: "high", details: { address: C, label: "Fake_*Token*", flagCount: 2 } },
    { origin: SITE, type: "frontend_redeployed", severity: "info", details: {} },
    { origin: "https://other-site.com", type: "contract_added", severity: "high", details: { address: C } },
  ]);
  const [one, two] = await Promise.all([sendAppAlerts(opts), sendAppAlerts(opts)]); // two servers
  assert.equal(one.length + two.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, 101); // alice follows SITE; bob follows nothing
  assert.match(sent[0].text, /a new contract was added/);
  assert.match(sent[0].text, /It has 2 flags/);
  assert.ok(sent[0].text.includes("Fake\\_\\*Token\\*")); // escaped
});

test("alerts respect /contractalerts off (not a recipient) and start from 'now' for a new watcher", async () => {
  const { store, sent, opts, alice } = await alertSetup();
  await store.insertAppChangeEvents([{ origin: SITE, type: "contract_changed", severity: "high", details: { address: A, changes: [{ field: "owner" }] } }]);
  await sendAppAlerts({ ...opts, recipients: async () => new Map() }); // alice muted
  assert.equal(sent.length, 0);
  const carol = "0xcccc000000000000000000000000000000000003";
  await store.addAppFollow(carol, SITE, null);
  await sendAppAlerts({ ...opts, recipients: async () => new Map([[alice, 101], [carol, 303]]) });
  assert.deepEqual(sent.map((s) => s.chat), [101]); // carol's cursor started now
});

test("a watched registry app's events reach its followers by app, whatever the origin", async () => {
  const { store, sent, opts } = await alertSetup();
  const es = APPS.find((a) => a.slug === "electroswap");
  const dave = "0xdddd000000000000000000000000000000000004";
  await store.addAppFollow(dave, "https://app.electroswap.io", es.id);
  await sendAppAlerts({ ...opts, recipients: async () => new Map([[dave, 404]]) });
  await store.insertAppChangeEvents([{ origin: "https://electroswap.io", appId: es.id, type: "domain_changed", severity: "caution", details: { added: ["swap.electroswap.io"], removed: [] } }]);
  await sendAppAlerts({ ...opts, recipients: async () => new Map([[dave, 404]]) });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /ElectroSwap/);
  assert.match(sent[0].text, /websites in our registry changed/);
});

// ── follows + Telegram ─────────────────────────────────────────────────────────────────────────────────
test("follows: by URL or name, lookalikes refused, a per-member cap", async () => {
  const store = memoryStore();
  const w = "0xeeee000000000000000000000000000000000005";
  assert.equal((await followApp(w, "electroswap", { store, apps: APPS })).origin, "https://app.electroswap.io");
  assert.equal((await followApp(w, "electroswap-claim.com", { store, apps: APPS })).ok, false);
  for (let i = 0; i < FOLLOW.maxPerMember - 1; i++) assert.equal((await followApp(w, `site-${i}.com`, { store, apps: APPS })).ok, true);
  const over = await followApp(w, "one-more.com", { store, apps: APPS });
  assert.equal(over.ok, false);
  assert.match(over.error, /already watching/);
});

test("/checkapp: free gets the lookalike check; names, hosts and reasons are escaped", async () => {
  const sent = [];
  const send = async (chat, text) => sent.push(text);
  const { getAppResult: real } = await import("../services/appCheck/appCheckService.js");
  await handleAppCommand({ text: "/checkapp electroswap_claim.com", chatId: 1, linkedAddress: null, core: false, sendDirectMessage: send, getResult: (i, o) => real(i, { ...o, apps: APPS }) });
  assert.match(sent[0], /Resembles/);
  assert.ok(sent[0].includes("electroswap\\_claim.com"));
  await handleAppCommand({ text: "/watchapp electroswap", chatId: 1, linkedAddress: null, core: false, sendDirectMessage: send });
  assert.match(sent[1], /part of Core Tier/);
});

test("the Core card shows the contract count and top flags, escaped", () => {
  const text = formatAppCard({
    status: "unknown",
    tier: "core",
    overall: "red",
    overallReason: "Not in our registry, and we found 1 contract with high-severity flags.",
    normalised: { origin: "https://x-site.com", displayHost: "x-site.com" },
    contracts: [{ address: C, overall: "red", label: "Evil_Token", topFlags: [{ id: "owner_can_mint", severity: "high" }] }, { address: A, overall: "green" }],
    domain: { ageDays: 3, https: true },
    scan: { status: "ok" },
  });
  assert.match(text, /Contracts: 2 \(1 🔴\)/);
  assert.ok(text.includes("Evil\\_Token: owner can mint"));
  assert.match(text, /registered 3 days ago/);
  assert.match(formatAppChangeAlert({ origin: "https://x.com", type: "contract_removed", severity: "caution", details: { address: C } }), /no longer in its code/);
});
