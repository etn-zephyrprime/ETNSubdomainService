// Argus "App Check" entry point: is this website one of a known app's, a lookalike of one, or unknown —
// and (Core) what do its contracts and domain look like? Facts come from code; no Claude calls here.
// Per-contract summaries stay on demand from the contract card.
//
//   free — status, the app it is / resembles, lookalike reasons, and the red badge for a lookalike.
//          Computed locally from the registry: no RDAP, no contract analysis, no request to the site.
//   core — adds domain signals (age, HTTPS, punycode), the contracts with their own Contract Check badges,
//          and the overall badge; with `scan`, the site scan (scanSite.js) adds the contracts in its code.
import crypto from "crypto";
import { normaliseInput } from "./normaliseInput.js";
import { matchApp } from "./matchApp.js";
import { getKnownApps, findAppsByName, primaryHost } from "./registry.js";
import { getDomainSignals } from "./domainSignals.js";
import { computeOverall, listedAs } from "./appResult.js";
import { analyseContract } from "../contractCheck/analyseContract.js";
import { runScan } from "./scanSite.js";

const appSummary = (app) => (app ? { slug: app.slug, name: app.name, category: app.category, primaryHost: primaryHost(app), verifiedByUs: app.verifiedByUs, source: app.source || null } : null);

const normalisedView = (n) => ({
  url: n.url,
  origin: n.origin,
  host: n.host,
  displayHost: n.displayHost,
  registrableDomain: n.registrableDomain,
  punycode: n.punycode ? n.host : null,
  sharedHosting: n.sharedHosting,
});

/** One contract's App Check row from its Contract Check facts (analysed one at a time — no RPC bursts). */
export async function contractRow(c, analyse) {
  const base = { address: c.address, role: c.role || null, source: c.source || "registry" };
  try {
    const facts = await analyse(c.address);
    if (facts?.identity?.isContract === false) return { ...base, overall: "unknown", note: "no contract code at this address" };
    const flags = facts.riskFlags || [];
    return {
      ...base,
      label: facts.identity?.known?.label || null,
      overall: facts.overall,
      flagCount: flags.length,
      topFlags: flags.slice(0, 3).map((f) => ({ id: f.id, severity: f.severity })),
      incomplete: !!facts.incomplete,
    };
  } catch (err) {
    console.warn(`⚠️  App Check: couldn't analyse ${c.address}: ${err.message}`);
    return { ...base, overall: "unknown", note: "couldn't be checked right now" };
  }
}

/** What the result carries about a scan (the full record, with hashes, is for storage — Phase 3). */
export const scanSummary = (s) => ({
  status: s.status,
  scannedAt: s.scannedAt,
  url: s.url,
  pageOnly: !!s.pageOnly,
  addressCount: Object.keys(s.addresses).length,
  scriptCount: Object.keys(s.scriptHashes).length,
  requests: s.requests,
  bytes: s.bytes,
  truncated: s.truncated,
  errorCount: s.errors.length,
  chunkMisses: s.chunkMisses,
  wallets: s.wallets,
  unchecked: s.unchecked,
});

const fingerprintOf = (r) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify([r.status, r.app?.slug || null, (r.contracts || []).map((c) => [c.address, c.overall]), (r.domain?.flags || []).map((f) => f.id)]))
    .digest("hex")
    .slice(0, 32);

/**
 * The AppCheckResult for what someone typed.
 * @param opts.core Core tier (full result) or free (lookalike check only)
 * @param opts.analyse Contract Check's analyseContract (injectable for tests)
 * @param opts.scan also scan the site (Core only; rate-limited by the caller)
 * @param opts.onScan called with the full scan record (for storage)
 * @param opts.fetchImpl / fetchText / getCode / analyse injectable for tests
 */
export async function checkApp(input, { core = false, scan: doScan = false, analyse = analyseContract, fetchImpl = undefined, fetchText = undefined, getCode = undefined, apps = null, now = Date.now(), onScan = null } = {}) {
  const checkedAt = new Date(now).toISOString();
  const n = normaliseInput(input);
  if (!n.ok) return { input: n.input, status: "invalid", error: { detail: n.detail, message: n.message }, overall: null, overallReason: n.message, checkedAt };

  const registry = apps || (await getKnownApps());
  if (n.kind === "name") {
    const matches = findAppsByName(n.query, registry).map(appSummary);
    return {
      input: n.input,
      status: "name",
      apps: matches,
      overall: null,
      overallReason: matches.length ? "Pick the app you mean to check its listed site." : "No app with that name in our registry. Enter the website address instead.",
      checkedAt,
    };
  }

  const match = matchApp(n, registry);
  const base = {
    input: n.input,
    normalised: normalisedView(n),
    status: match.status,
    app: appSummary(match.app),
    resembles: match.resembles || null,
    lookalikeReasons: match.reasons || [],
    lookalikeReasonIds: match.reasonIds || [],
    checkedAt,
  };

  if (!core) {
    const lookalike = match.status === "lookalike";
    const { overall, overallReason } = lookalike ? computeOverall({ status: "lookalike", app: match.app, resembles: match.resembles }) : { overall: null, overallReason: null };
    return {
      ...base,
      tier: "free",
      overall,
      overallReason:
        overallReason ||
        (match.status === "known"
          ? `${listedAs(match.app)}. Core Tier checks its contracts and domain.`
          : "Not in our registry, and it doesn't resemble a listed app. Core Tier checks its domain and scans the contracts it uses."),
    };
  }

  const domain = await getDomainSignals(n, match, { fetchImpl, now });
  const contracts = [];
  if (match.status === "known") {
    const seen = new Set();
    // the registry's own list; contracts found by scans come from the scan itself
    for (const c of match.app.contracts.filter((x) => x.source === "registry")) {
      if (seen.has(c.address)) continue;
      seen.add(c.address);
      contracts.push(await contractRow(c, analyse)); // sequential on purpose (RPC limits)
    }
  }

  // the site scan ("Scan this site", or the rescan job): its contracts join the list
  let scan = null;
  if (doScan) {
    // a registry app can name the page to scan (and whether to fetch its scripts) — used when its site root
    // is checked; a specific page someone enters is scanned as entered
    const app = match.status === "known" ? match.app : null;
    const atRoot = (() => {
      try {
        return new URL(n.url).pathname === "/";
      } catch {
        return true;
      }
    })();
    const target = app?.scanUrl && atRoot ? { ...n, url: app.scanUrl } : n;
    scan = await runScan(target, match, registry, { fetchText, analyse, getCode, now, scripts: app ? app.scanScripts !== false : true });
    onScan?.(scan);
  }
  return assembleResult({ base, match, domain, contracts, scan });
}

/** Merges a scan's contracts into the list (a registry contract it also found is marked, not duplicated). */
export function mergeScanContracts(contracts, scan) {
  const out = contracts.map((c) => ({ ...c }));
  const byAddress = new Map(out.map((c) => [c.address, c]));
  for (const c of scan?.contracts || []) {
    if (byAddress.has(c.address)) byAddress.get(c.address).foundInScan = true;
    else out.push(c);
  }
  return out;
}

/**
 * Which contracts decide the badge. A known app: its listed (registry) contracts — or, when none are listed,
 * the ones found in its own site's code. Anything else: every contract found.
 */
export function badgeContractsOf(match, contracts, scan) {
  if (match.status !== "known") return { contracts, fromScan: false };
  const listed = contracts.filter((c) => c.source === "registry");
  if (listed.length) return { contracts: listed, fromScan: false };
  return { contracts: scan ? contracts.filter((c) => c.source === "scan") : [], fromScan: true };
}

/**
 * The Core result from its parts (also used when a cached result is revalidated).
 * A known app's badge is its registry contracts'. Other contracts its code mentions are listed with their
 * own badges, never hidden — but don't decide the app's badge. For an unknown site every scanned contract counts.
 */
export function assembleResult({ base, match, domain, contracts, scan }) {
  const all = scan ? mergeScanContracts(contracts.filter((c) => c.source !== "scan"), scan) : contracts;
  const flags = [...domain.flags, ...(scan?.flags || [])];
  const { contracts: badgeContracts, fromScan } = badgeContractsOf(match, all, scan);
  const { overall, overallReason } = computeOverall({ status: match.status, app: match.app, resembles: match.resembles, contracts: badgeContracts, domainFlags: flags, scan, fromScan });
  const result = { ...base, tier: "core", domain, contracts: all, flags, scan: scan ? (scan.scriptHashes ? scanSummary(scan) : scan) : null, overall, overallReason, cache: { hit: false, ageSeconds: 0, revalidated: false } };
  result.fingerprint = fingerprintOf(result);
  return result;
}
