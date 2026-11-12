// Argus App Check, phase 1: input handling (the first SSRF layer), registry matching, lookalike detection,
// domain signals and the overall badge. Fixture domains only — nothing here touches the network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "fs";
import { normaliseInput } from "../services/appCheck/normaliseInput.js";
import { matchApp } from "../services/appCheck/matchApp.js";
import { seedApps, validateApps, findAppsByName } from "../services/appCheck/registry.js";
import { domainFlags, getDomainSignals, _resetDomainSignals } from "../services/appCheck/domainSignals.js";
import { computeOverall } from "../services/appCheck/appResult.js";
import { checkApp } from "../services/appCheck/appCheck.js";
import { skeleton, editDistance } from "../services/appCheck/confusables.js";

const APPS = validateApps(seedApps(), () => {});
const match = (input, apps = APPS) => {
  const n = normaliseInput(input);
  assert.ok(n.ok && n.kind === "url", `${input} should parse`);
  return matchApp(n, apps);
};
const noFetch = async () => {
  throw new Error("no network in tests");
};
beforeEach(() => _resetDomainSignals());

// ── input / SSRF layer 1 ───────────────────────────────────────────────────────────────────────────────
test("IP literals are rejected in every spelling", () => {
  for (const i of ["http://127.0.0.1", "http://2130706433", "http://0x7f.1", "http://0x7f000001", "http://0177.0.0.1", "http://017700000001", "http://127.1", "http://[::1]", "http://[::ffff:127.0.0.1]", "https://169.254.169.254/latest/meta-data", "10.0.0.1", "[fe80::1]"]) {
    const n = normaliseInput(i);
    assert.equal(n.ok, false, i);
    assert.equal(n.reason, "invalid_input", i);
  }
});

test("localhost, credentials, other schemes, odd ports and non-public suffixes are rejected", () => {
  const cases = {
    "http://localhost": "localhost",
    localhost: "localhost",
    "https://app.localhost": "localhost",
    "https://user:pass@electroswap.io": "credentials",
    "https://user@electroswap.io": "credentials",
    "javascript:alert(1)": "scheme",
    "file:///etc/passwd": "scheme",
    "ftp://electroswap.io": "scheme",
    "gopher://x.com": "scheme",
    "data:text/html,hi": "scheme",
    "https://electroswap.io:8443": "port",
    "http://electroswap.io:22": "port",
    "https://electroswap.io:80": "port",
    "foo.local": "no_public_suffix",
    "https://metadata.internal": "no_public_suffix",
    "https://intranet": "no_public_suffix",
  };
  for (const [i, detail] of Object.entries(cases)) assert.equal(normaliseInput(i).detail, detail, i);
});

test("URLs are normalised: tracking params and fragments stripped, host lowercased, IDN kept in both forms", () => {
  const n = normaliseInput("  HTTPS://App.ElectroSwap.io/swap?utm_source=tg&fbclid=1&chain=etn#top ");
  assert.equal(n.url, "https://app.electroswap.io/swap?chain=etn");
  assert.equal(n.origin, "https://app.electroswap.io");
  assert.equal(n.https, true);
  assert.equal(n.registrableDomain, "electroswap.io");
  const idn = normaliseInput("https://еlectroswap.io"); // Cyrillic е
  assert.equal(idn.host, "xn--lectroswap-jsi.io");
  assert.equal(idn.displayHost, "еlectroswap.io");
  assert.ok(idn.punycode && idn.mixedScript);
  assert.equal(normaliseInput("electroswap.io").https, null); // bare domain: unknown, not "not https"
  assert.equal(normaliseInput("http://electroswap.io").https, false);
});

test("a word with no dot is an app name, searched with typo tolerance", () => {
  assert.equal(normaliseInput("ElectroSwap").kind, "name");
  assert.equal(findAppsByName("electroswap", APPS)[0].slug, "electroswap");
  assert.equal(findAppsByName("electrosawp", APPS)[0].slug, "electroswap");
  assert.equal(findAppsByName("argus", APPS)[0].slug, "argus");
  assert.deepEqual(findAppsByName("uniswap", APPS), []);
});

// ── registry matching ──────────────────────────────────────────────────────────────────────────────────
test("exact hosts win over registrable domains; registrable domains cover subdomains", () => {
  assert.equal(match("https://dashboard.planetzephyros.xyz/pnl").app.slug, "argus");
  assert.equal(match("https://staking.planetzephyros.xyz").app.slug, "core-ascension-vault");
  assert.equal(match("https://anything.planetzephyros.xyz").app.slug, "planet-zephyros");
  assert.equal(match("ens.electroneum.com").app.slug, "etn-name-service");
  assert.equal(match("blockexplorer.electroneum.com").app.slug, "electroneum");
  assert.equal(match("https://app.electroswap.io/swap").app.slug, "electroswap");
});

test("a registrable-domain entry never covers lookalikes", () => {
  const m = match("https://app.electroswap.io.evil.com");
  assert.equal(m.status, "lookalike");
  assert.ok(m.reasonIds.includes("subdomain_trick"));
});

test("exact-host entries on shared hosting don't cover siblings, and registrable entries there are refused", () => {
  const apps = validateApps(
    [
      { id: 1, slug: "demo", name: "Demo Swap", category: "dex", verifiedByUs: false, hosts: [{ host: "demoswap.vercel.app", registrableDomain: false, primary: true }], contracts: [] },
      { id: 2, slug: "bad", name: "Bad Entry", category: "dex", verifiedByUs: false, hosts: [{ host: "badentry.github.io", registrableDomain: true, primary: true }], contracts: [] },
    ],
    () => {}
  );
  assert.equal(match("demoswap.vercel.app", apps).status, "known");
  assert.notEqual(match("other.vercel.app", apps).status, "known");
  assert.notEqual(match("x.demoswap.vercel.app", apps).status, "known");
  assert.equal(apps[1].hosts.length, 0); // refused
});

// ── lookalikes ─────────────────────────────────────────────────────────────────────────────────────────
const FIXTURES = {
  typo: ["electroswqp.io", "typo"],
  transposition: ["elecrtoswap.io", "typo"],
  homoglyph_digit: ["e1ectroswap.io", "homoglyph"],
  homoglyph_rn: ["electroswap.io".replace("m", "rn"), null], // no m in electroswap: covered below
  cyrillic: ["еlectroswap.io", "mixed_script"],
  tld_swap: ["electroswap.xyz", "different_domain_ending"],
  shared_hosting: ["electroswap.vercel.app", "shared_hosting_same_name"],
  keyword_hyphen: ["electroswap-claim.com", "keyword_stuffing"],
  keyword_concat: ["claimelectroswap.io", "keyword_stuffing"],
  keyword_many: ["electroswap-airdrop-official.net", "keyword_stuffing"],
  subdomain: ["electroswap.io.claim-now.com", "subdomain_trick"],
  ours_typo: ["p1anetzephyros.xyz", "homoglyph"],
  ours_keyword: ["dashboard-planetzephyros.app", "keyword_stuffing"],
  explorer: ["blockexplorer-electroneum.com", "keyword_stuffing"],
};

test("every lookalike pattern is caught, with its reason", () => {
  for (const [name, [host, reason]] of Object.entries(FIXTURES)) {
    if (!reason) continue;
    const m = match(host);
    assert.equal(m.status, "lookalike", `${name}: ${host}`);
    assert.ok(m.reasonIds.includes(reason), `${name}: ${host} -> ${m.reasonIds}`);
    assert.ok(m.reasons.length === m.reasonIds.length);
  }
  assert.equal(skeleton("rnetamask"), skeleton("metamask"));
  assert.equal(skeleton("vvallet"), skeleton("wallet"));
  assert.equal(editDistance("electroswap", "elecrtoswap"), 1); // a swap of neighbours is one edit
});

test("ties go to the app owning the registrable domain", () => {
  assert.equal(match("electroneum-support.com").app.slug, "electroneum");
});

test("short known names don't produce typo lookalikes of other real brands", () => {
  for (const h of ["anker.com", "ankh.com", "bank.com"]) assert.equal(match(h).status, "unknown", h);
  assert.equal(match("ankr-airdrop.com").status, "lookalike"); // keyword stuffing still applies
  assert.equal(match("ankr.io").status, "lookalike"); // and a different ending
  assert.equal(match("rpc.ankr.com").status, "known");
});

test("clearly unrelated domains don't match", () => {
  for (const h of ["google.com", "uniswap.org", "electrum.org", "etn.com", "ens.domains", "electronic.com", "github.com", "wikipedia.org", "swap.com"]) {
    assert.equal(match(h).status, "unknown", h);
  }
});

// ── domain signals ─────────────────────────────────────────────────────────────────────────────────────
const NOW = Date.parse("2026-11-11T12:00:00Z");
const rdapFetch = (registeredDaysAgo, calls = []) => async (url) => {
  calls.push(url);
  const body = url.includes("dns.json")
    ? { services: [[["io", "xyz", "com"], ["https://rdap.example/"]]] }
    : { events: [{ eventAction: "registration", eventDate: new Date(NOW - registeredDaysAgo * 864e5).toISOString() }] };
  return { status: 200, headers: new Map([["content-type", "application/rdap+json"]]), text: async () => JSON.stringify(body) };
};

test("domain age: under 7 days is caution, under 30 info, never above caution", async () => {
  const n = normaliseInput("https://brand-new-site.io");
  const m = { status: "unknown" };
  const young = await getDomainSignals(n, m, { fetchImpl: rdapFetch(2), now: NOW });
  assert.equal(young.ageDays, 2);
  assert.deepEqual(young.flags.map((f) => [f.id, f.severity]), [["domain_age_under_7_days", "caution"]]);
  _resetDomainSignals();
  const month = await getDomainSignals(n, m, { fetchImpl: rdapFetch(20), now: NOW });
  assert.deepEqual(month.flags.map((f) => [f.id, f.severity]), [["domain_age_under_30_days", "info"]]);
  // a misconfigured rule still can't push age above caution
  const flags = domainFlags(n, m, 1, { domain_age_under_7_days: { enabled: true, severity: "high", days: 7 }, domain_age_under_30_days: { enabled: true, severity: "info", days: 30 } });
  assert.equal(flags[0].severity, "caution");
});

test("RDAP failure or a missing TLD server is 'age unknown', never a flag", async () => {
  const n = normaliseInput("https://some-site.io");
  const s = await getDomainSignals(n, { status: "unknown" }, { fetchImpl: noFetch, now: NOW });
  assert.equal(s.ageDays, "unknown");
  assert.deepEqual(s.flags, []);
  _resetDomainSignals();
  const calls = [];
  const noServer = await getDomainSignals(normaliseInput("https://some-site.dev"), { status: "unknown" }, { fetchImpl: rdapFetch(1, calls), now: NOW });
  assert.equal(noServer.ageDays, "unknown");
  assert.equal(calls.length, 1); // only the IANA file
});

test("RDAP goes only to IANA-listed registry servers, never to the site; shared hosting skips it", async () => {
  const calls = [];
  await getDomainSignals(normaliseInput("https://some-site.io/page"), { status: "unknown" }, { fetchImpl: rdapFetch(400, calls), now: NOW });
  assert.deepEqual(calls, ["https://data.iana.org/rdap/dns.json", "https://rdap.example/domain/some-site.io"]);
  const shared = [];
  const s = await getDomainSignals(normaliseInput("someapp.vercel.app"), { status: "unknown" }, { fetchImpl: rdapFetch(1, shared), now: NOW });
  assert.equal(s.ageDays, "unknown");
  assert.deepEqual(shared, []);
});

test("http and punycode hosts are caution; punycode on a lookalike is high", () => {
  const http = domainFlags(normaliseInput("http://some-site.io"), { status: "unknown" }, "unknown");
  assert.deepEqual(http.map((f) => [f.id, f.severity]), [["not_https", "caution"]]);
  const n = normaliseInput("https://еlectroswap.io");
  const lk = domainFlags(n, matchApp(n, APPS), "unknown");
  assert.deepEqual(lk.map((f) => [f.id, f.severity]), [["lookalike_domain", "high"], ["idn_host", "high"]]);
  assert.deepEqual(domainFlags(normaliseInput("https://bücher.de"), { status: "unknown" }, "unknown").map((f) => f.severity), ["caution"]);
});

// ── overall badge ──────────────────────────────────────────────────────────────────────────────────────
const app = { name: "ElectroSwap" };
test("lookalike is always red", () => {
  assert.equal(computeOverall({ status: "lookalike", app, resembles: "app.electroswap.io" }).overall, "red");
});

test("unknown is never green: clean or unscanned is unassessed", () => {
  assert.equal(computeOverall({ status: "unknown" }).overall, "unassessed");
  assert.equal(computeOverall({ status: "unknown", scan: { status: "ok" }, contracts: [{ overall: "green" }] }).overall, "unassessed");
  assert.equal(computeOverall({ status: "unknown", scan: { status: "partial" }, contracts: [] }).overall, "unassessed");
  assert.equal(computeOverall({ status: "unknown", domainFlags: [{ severity: "caution" }] }).overall, "amber");
  assert.equal(computeOverall({ status: "unknown", domainFlags: [{ severity: "info" }] }).overall, "unassessed");
  assert.equal(computeOverall({ status: "unknown", scan: { status: "ok" }, contracts: [{ overall: "red" }] }).overall, "red");
});

test("a known app is its worst contract; being listed never hides a flag", () => {
  assert.equal(computeOverall({ status: "known", app, contracts: [{ overall: "green" }, { overall: "green" }] }).overall, "green");
  assert.equal(computeOverall({ status: "known", app, contracts: [{ overall: "green" }, { overall: "red" }] }).overall, "red");
  assert.equal(computeOverall({ status: "known", app, contracts: [{ overall: "amber" }] }).overall, "amber");
  assert.equal(computeOverall({ status: "known", app, contracts: [{ overall: "green" }], domainFlags: [{ severity: "caution" }] }).overall, "amber");
  // no listed contracts: badged from the scan, never a free green for being listed
  assert.equal(computeOverall({ status: "known", app, contracts: [], fromScan: true }).overall, "unassessed");
  assert.equal(computeOverall({ status: "known", app, contracts: [{ overall: "red" }], scan: { status: "ok" }, fromScan: true }).overall, "red");
  assert.equal(computeOverall({ status: "known", app, contracts: [{ overall: "green" }], scan: { status: "partial" }, fromScan: true }).overall, "unassessed");
  assert.equal(computeOverall({ status: "known", app, contracts: [], scan: { status: "ok" }, fromScan: true }).overall, "green");
  // a contract we couldn't check is missing data: not green, not a flag
  assert.equal(computeOverall({ status: "known", app, contracts: [{ overall: "green" }, { overall: "unknown" }] }).overall, "unassessed");
});

test("the wording never says safe, legit, scam or official", () => {
  const texts = [
    computeOverall({ status: "lookalike", app, resembles: "app.electroswap.io" }),
    computeOverall({ status: "known", app, contracts: [{ overall: "green" }] }),
    computeOverall({ status: "known", app, contracts: [{ overall: "red" }] }),
    computeOverall({ status: "known", app, contracts: [] }),
    computeOverall({ status: "unknown" }),
    computeOverall({ status: "unknown", scan: { status: "ok" }, contracts: [{ overall: "green" }] }),
  ].map((r) => r.overallReason);
  for (const t of texts) assert.doesNotMatch(t, /\b(safe|legit\w*|scam\w*|official\w*)\b/i, t);
});

// ── tiers ──────────────────────────────────────────────────────────────────────────────────────────────
test("free checks are lookalike-only: no RDAP, no contract analysis", async () => {
  let analysed = 0, fetched = 0;
  const opts = { core: false, apps: APPS, analyse: async () => (analysed++, {}), fetchImpl: async () => (fetched++, noFetch()) };
  const lk = await checkApp("electroswap-claim.com", opts);
  assert.equal(lk.status, "lookalike");
  assert.equal(lk.overall, "red");
  assert.ok(lk.lookalikeReasons.length);
  const known = await checkApp("https://app.electroswap.io", opts);
  assert.equal(known.status, "known");
  assert.equal(known.overall, null);
  assert.equal(known.contracts, undefined);
  assert.equal(known.domain, undefined);
  assert.equal(analysed + fetched, 0);
});

test("core checks a known app's contracts one by one and takes the worst badge", async () => {
  let active = 0, peak = 0;
  const analyse = async (address) => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 1));
    active--;
    return { identity: { isContract: true }, overall: address === "0x2c12c8f15637b7a182dec202816148a5e767dcec" ? "amber" : "green", riskFlags: [] };
  };
  const r = await checkApp("https://app.electroswap.io/swap", { core: true, apps: APPS, analyse, fetchImpl: noFetch, now: NOW });
  assert.equal(r.status, "known");
  assert.equal(r.contracts.length, 13);
  assert.equal(peak, 1); // sequential, no RPC bursts
  assert.equal(r.overall, "amber");
  assert.equal(r.domain.ageDays, "unknown");
  assert.ok(r.fingerprint);
});

test("invalid input gets an error and no badge", async () => {
  const r = await checkApp("http://169.254.169.254/", { apps: APPS });
  assert.equal(r.status, "invalid");
  assert.equal(r.overall, null);
  assert.equal(r.error.detail, "ip_literal");
});

test("App Check makes no Claude calls", () => {
  const dir = new URL("../services/appCheck/", import.meta.url);
  for (const f of readdirSync(dir)) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(src, /anthropic|explain\.js|answerQuestion|explainContract|llm_usage/i, f);
  }
});
