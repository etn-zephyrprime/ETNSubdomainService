// The block explorer's Apps list as a registry source (services/appCheck/explorerApps.js): what's added,
// updated, removed and left alone — seed and Argus-managed apps are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { explorerHosts, explorerToApp, planExplorerSync, syncExplorerApps } from "../services/appCheck/explorerApps.js";
import { lookalikeTargets, matchApp } from "../services/appCheck/matchApp.js";
import { normaliseInput } from "../services/appCheck/normaliseInput.js";
import { seedApps, validateApps } from "../services/appCheck/registry.js";

const SEED = validateApps(seedApps(), () => {});
const entry = (id, title, url, site = url, categories = ["Platform"]) => ({ id, title, url, site, categories });
const LIST = [
  entry("electroswap", "ElectroSwap", "https://app.electroswap.io/swap", "https://electroswap.io/", ["Swaps"]),
  entry("ninjars", "NinJars", "https://ninjars.club/", "https://ninjars.club/", ["Platform", "NFT"]),
  entry("etnradar", "ETN Radar", "https://etn-radar.galacticsl.com/#board"),
  entry("decentroneum", "Decentroneum", "https://www.decentroneum.com/"),
  entry("broken", "Broken", "javascript:alert(1)"),
];

test("hosts: a whole (or www.) domain covers its subdomains; someone else's subdomain stays exact", () => {
  assert.deepEqual(explorerHosts({ url: "https://www.decentroneum.com/" }), [{ host: "decentroneum.com", registrableDomain: true, primary: true }]);
  assert.deepEqual(explorerHosts({ url: "https://etn-radar.galacticsl.com/#board" }), [{ host: "etn-radar.galacticsl.com", registrableDomain: false, primary: true }]);
  assert.deepEqual(explorerHosts({ url: "https://ramp.alchemypay.org/?x", site: "https://alchemypay.org/" }), [
    { host: "ramp.alchemypay.org", registrableDomain: false, primary: true },
    { host: "alchemypay.org", registrableDomain: true, primary: false },
  ]);
  assert.deepEqual(explorerHosts({ url: "https://someapp.vercel.app/" }), [{ host: "someapp.vercel.app", registrableDomain: false, primary: true }]);
  assert.equal(explorerToApp({ id: "x", title: "X", url: "http://localhost/" }), null);
  assert.equal(explorerToApp(LIST[1]).category, "dapp");
  assert.equal(explorerToApp(entry("d", "D", "https://d.io", "https://d.io", ["Swaps"])).category, "dex");
  assert.equal(explorerToApp(LIST[1]).autoRescan, false);
});

test("first sync: adds what we don't list, skips what we do, ignores unusable entries", () => {
  const p = planExplorerSync(LIST, SEED);
  assert.deepEqual(p.add.map((a) => a.slug), ["ninjars", "etnradar"]);
  assert.ok(p.add.every((a) => a.source === "explorer" && a.contracts.length === 0));
  assert.deepEqual(p.skipped.map((s) => s.id).sort(), ["broken", "decentroneum", "electroswap"]);
  assert.deepEqual(p.update, []);
  assert.deepEqual(p.remove, []);
});

test("later syncs: unchanged -> nothing; changed -> update; gone from the list -> removed", () => {
  const first = planExplorerSync(LIST, SEED);
  const registry = [...SEED, ...first.add.map((a, i) => ({ ...a, id: 900 + i }))];
  const same = planExplorerSync(LIST, registry);
  assert.deepEqual([same.add.length, same.update.length, same.remove.length], [0, 0, 0]);
  const renamed = LIST.map((x) => (x.id === "ninjars" ? { ...x, title: "NinJars Club" } : x)).filter((x) => x.id !== "etnradar");
  const later = planExplorerSync(renamed, registry);
  assert.deepEqual(later.update.map((a) => [a.slug, a.name]), [["ninjars", "NinJars Club"]]);
  assert.deepEqual(later.remove, ["etnradar"]);
});

test("an explorer app an admin edited in Argus is theirs: never updated or removed by the sync", () => {
  const first = planExplorerSync(LIST, SEED);
  const takenOver = { ...first.add[0], id: 900, source: "admin", name: "NinJars (checked by us)" };
  const p = planExplorerSync(LIST.filter((x) => x.id !== "ninjars"), [...SEED, takenOver]);
  assert.deepEqual(p.remove, []);
  const p2 = planExplorerSync(LIST, [...SEED, takenOver]);
  assert.deepEqual(p2.add.map((a) => a.slug), ["etnradar"]);
  assert.match(p2.skipped.find((s) => s.id === "ninjars").reason, /managed in Argus/);
});

test("a slug already used by one of ours gets a suffix instead of overwriting it", () => {
  const p = planExplorerSync([entry("argus", "Some Other Argus", "https://some-other-argus.io/")], SEED);
  assert.equal(p.add[0].slug, "argus-explorer");
});

test("an empty or failed list changes nothing", async () => {
  let writes = 0;
  const opts = { registry: SEED, upsert: async () => writes++, remove: async () => writes++ };
  await assert.rejects(syncExplorerApps({ ...opts, fetchList: async () => [] }), /empty/);
  await assert.rejects(syncExplorerApps({ ...opts, fetchList: async () => { throw new Error("HTTP 503"); } }), /503/);
  assert.equal(writes, 0);
});

test("an explorer-listed app is never a free green, and isn't described as checked by us", async () => {
  const { computeOverall } = await import("../services/appCheck/appResult.js");
  const app = { name: "NinJars", source: "explorer" };
  const unscanned = computeOverall({ status: "known", app, contracts: [], fromScan: true });
  assert.equal(unscanned.overall, "unassessed");
  assert.match(unscanned.overallReason, /^On the Electroneum block explorer's app list as NinJars/);
  assert.equal(computeOverall({ status: "known", app, contracts: [{ overall: "red" }], scan: { status: "ok" }, fromScan: true }).overall, "red");
  assert.doesNotMatch(unscanned.overallReason, /Listed site/);
});

test("lookalike targets only come from domains an app owns", () => {
  const radar = { ...explorerToApp(LIST[2]), id: 901 };
  const labels = lookalikeTargets([...SEED, radar]).map((t) => t.label);
  assert.ok(!labels.includes("galacticsl"));
  assert.equal(matchApp(normaliseInput("galactic.com"), [...SEED, radar]).status, "unknown");
  assert.equal(matchApp(normaliseInput("https://etn-radar.galacticsl.com/"), [...SEED, radar]).status, "known");
  // subdomain words of a domain still count as keyword stuffing of its owner
  assert.equal(matchApp(normaliseInput("nameservice-planetzephyros.com"), SEED).status, "lookalike");
});
