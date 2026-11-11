// App Check's frontend scan (Core only): fetch a site's page and scripts through the fetcher (safeFetch.js),
// find the contract addresses written in them, and run Contract Check on each. Static text only — nothing
// fetched is executed. An honest but imperfect signal: every contract it finds is labelled "found in this
// site's code, not confirmed by the project", and it misses addresses a site loads dynamically.
//
//   1. the page: SHA-256, ETag / Last-Modified kept (Phase 3 revalidates with them)
//   2. its scripts (<script src>, modulepreload, preload as=script; cross-origin allowed — CDNs are normal)
//      and inline script text
//   3. each script, then chunks referenced from scripts, at most SCAN.maxChunkDepth levels below
//   4. addresses: 0x + 40 hex on word boundaries, EIP-55 checked when mixed-case, junk addresses dropped
//   5. eth_getCode one address at a time (no RPC bursts): code -> contract (Contract Check, at most
//      SCAN.maxContracts, registry contracts first then by occurrences); no code -> a wallet or an
//      other-chain address (listed apart, never part of the badge; a hard-coded wallet is info only)
//   6. registry cross-check: an unknown site using a known app's contracts -> caution
//
// Status: "ok" only when every page script loaded and no cap was hit; "partial" otherwise; "failed" if the
// page itself couldn't be fetched. A partial or failed scan never yields a green or a "no contracts" answer.
import { safeFetchText, createScanBudget } from "./safeFetch.js";
import { extractAddresses, pageScripts, chunkRefs } from "./extractAddresses.js";
import { analyseContract } from "../contractCheck/analyseContract.js";
import { contractCheckProvider } from "../contractCheck/fetchContractData.js";
import { SCAN, SCAN_RULES } from "./appCheck.config.js";

export const FOUND_IN_CODE = "Found in this site's code, not confirmed by the project";

export class ScanUnavailable extends Error {
  constructor(code, retryAfterSec = 60) {
    super(code === "busy" ? "App Check is busy scanning other sites — try again in a minute" : `This site was scanned moments ago — try again in ${retryAfterSec}s`);
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

let running = 0;
const lastScanAt = new Map(); // registrable domain -> ms

/** Tests only. */
export function _resetScanGate() {
  running = 0;
  lastScanAt.clear();
}

/** The contracts in the registry: address -> [{ app, role }]. */
function registryIndex(apps) {
  const idx = new Map();
  for (const app of apps) for (const c of app.contracts) idx.set(c.address, [...(idx.get(c.address) || []), { app, role: c.role }]);
  return idx;
}

/**
 * Scans one site. `n` = normaliseInput result; `match` = matchApp result.
 * Injectables for tests: fetchText, analyse, getCode, now.
 */
export async function scanSite(n, match, apps, { fetchText = safeFetchText, analyse = analyseContract, getCode = (a) => contractCheckProvider().getCode(a), now = Date.now(), limits = SCAN } = {}) {
  const budget = createScanBudget({ maxRequests: limits.maxRequests, maxBytes: limits.maxBytes });
  const scan = { status: "ok", scannedAt: new Date(now).toISOString(), url: n.url, htmlHash: null, etag: null, lastModified: null, scriptUrls: [], scriptHashes: {}, addresses: {}, requests: 0, bytes: 0, truncated: {}, errors: [], chunkMisses: 0, contracts: [], wallets: [], unchecked: [], flags: [] };
  const finish = (status) => {
    scan.status = status;
    scan.requests = budget.requests;
    scan.bytes = budget.bytes;
    return scan;
  };

  // 1. the page
  let page;
  try {
    page = await fetchText(n.url, { kind: "html", budget });
  } catch (err) {
    scan.errors.push({ url: n.url, code: err.code || "error" });
    return finish("failed");
  }
  if (page.status !== 200 || page.body == null) {
    scan.errors.push({ url: n.url, code: `http_${page.status}` });
    return finish("failed");
  }
  scan.url = page.url;
  scan.htmlHash = page.sha256;
  scan.etag = page.headers.etag;
  scan.lastModified = page.headers.lastModified;
  const origin = new URL(page.url).origin;
  const found = new Map();
  extractAddresses(page.body, found);

  // 2-3. scripts, then chunks
  const { scriptUrls, inline } = pageScripts(page.body, page.url);
  page = null; // let the page body go
  scan.scriptUrls = scriptUrls;
  const queue = scriptUrls.map((url) => ({ url, depth: 0 }));
  for (const text of inline) {
    extractAddresses(text, found);
    for (const url of chunkRefs(text, origin + "/", origin)) queue.push({ url, depth: 1 });
  }
  const seen = new Set();
  while (queue.length) {
    const item = queue.shift();
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    if (budget.requests >= budget.maxRequests) {
      scan.truncated.requests = true;
      break;
    }
    let res;
    try {
      res = await fetchText(item.url, { kind: "script", budget });
    } catch (err) {
      if (err.code === "budget_requests") {
        scan.truncated.requests = true;
        break;
      }
      if (err.code === "budget_bytes") scan.truncated.bytes = true;
      // a chunk reference is a pattern match, so a miss there (404, an SPA's HTML fallback) isn't a failure;
      // a script the page itself loads is
      else if (item.depth === 0) scan.errors.push({ url: item.url, code: err.code || "error" });
      else scan.chunkMisses++;
      continue;
    }
    if (res.status !== 200 || res.body == null) {
      if (item.depth === 0) scan.errors.push({ url: item.url, code: `http_${res.status}` });
      else scan.chunkMisses++;
      continue;
    }
    scan.scriptHashes[item.url] = res.sha256;
    extractAddresses(res.body, found);
    if (item.depth < limits.maxChunkDepth) for (const url of chunkRefs(res.body, res.url, origin)) if (!seen.has(url)) queue.push({ url, depth: item.depth + 1 });
  }
  scan.addresses = Object.fromEntries([...found].sort((a, b) => b[1] - a[1]));

  // 5. contract or wallet — one eth_getCode at a time
  const registry = registryIndex(apps);
  const ordered = [...found.keys()].sort((a, b) => (registry.has(b) ? 1 : 0) - (registry.has(a) ? 1 : 0) || found.get(b) - found.get(a));
  if (ordered.length > limits.maxAddressesToCheck) scan.truncated.addresses = ordered.length - limits.maxAddressesToCheck;
  const contractAddrs = [];
  const group = Math.max(1, limits.codeReadGroupSize);
  const toCheck = ordered.slice(0, limits.maxAddressesToCheck);
  for (let i = 0; i < toCheck.length; i += group) {
    for (const address of toCheck.slice(i, i + group)) {
      try {
        const code = await getCode(address);
        if (code && code !== "0x") contractAddrs.push(address);
        else scan.wallets.push({ address, occurrences: found.get(address) });
      } catch {
        scan.unchecked.push({ address, occurrences: found.get(address) });
      }
    }
  }

  // Contract Check on each contract (on-demand Claude summaries stay on the contract card)
  if (contractAddrs.length > limits.maxContracts) scan.truncated.contracts = contractAddrs.length - limits.maxContracts;
  for (const [i, address] of contractAddrs.entries()) {
    const reg = registry.get(address) || [];
    const row = {
      address,
      occurrences: found.get(address),
      source: "scan",
      foundIn: FOUND_IN_CODE,
      label: reg.length ? `${reg[0].app.name}: ${reg[0].role || "contract"}` : null,
      apps: reg.map((r) => ({ slug: r.app.slug, name: r.app.name, role: r.role })),
    };
    if (i >= limits.maxContracts) {
      scan.contracts.push({ ...row, overall: "unknown", note: "not analysed (contract cap reached)" });
      continue;
    }
    try {
      const facts = await analyse(address);
      const flags = facts.riskFlags || [];
      scan.contracts.push({ ...row, label: row.label || facts.identity?.known?.label || null, overall: facts.overall, flagCount: flags.length, topFlags: flags.slice(0, 3).map((f) => ({ id: f.id, severity: f.severity })), incomplete: !!facts.incomplete });
    } catch {
      scan.contracts.push({ ...row, overall: "unknown", note: "couldn't be checked right now" });
    }
  }

  // 6. registry cross-check (only for a site that isn't listed; a lookalike is already red)
  if (match.status !== "known" && SCAN_RULES.uses_known_app_contracts.enabled) {
    const ignore = new Set(limits.crossCheckIgnore || SCAN.crossCheckIgnore);
    const used = new Map();
    for (const c of scan.contracts) {
      if (ignore.has(c.address)) continue;
      for (const a of c.apps) used.set(a.slug, a.name);
    }
    for (const [slug, name] of used) {
      scan.flags.push({ id: "uses_known_app_contracts", severity: SCAN_RULES.uses_known_app_contracts.severity, fact: `This site uses contracts belonging to ${name} but isn't a listed site for ${name}`, app: slug });
    }
  }
  if (scan.wallets.length && SCAN_RULES.hardcoded_wallet.enabled) {
    scan.flags.push({ id: "hardcoded_wallet", severity: SCAN_RULES.hardcoded_wallet.severity, fact: `${scan.wallets.length} plain wallet (or other-chain) address${scan.wallets.length === 1 ? " is" : "es are"} written in this site's code — often a fee recipient; not a warning on its own` });
  }

  const partial = scan.errors.length || scan.unchecked.length || Object.keys(scan.truncated).length;
  return finish(partial ? "partial" : "ok");
}

/** scanSite behind the server-wide gate: at most SCAN.maxConcurrentScans at once, one per domain per cooldown. */
export async function runScan(n, match, apps, opts = {}) {
  const now = opts.now ?? Date.now();
  const key = n.registrableDomain;
  const last = lastScanAt.get(key);
  if (last && now - last < SCAN.perDomainCooldownMs) throw new ScanUnavailable("cooldown", Math.ceil((SCAN.perDomainCooldownMs - (now - last)) / 1000));
  if (running >= SCAN.maxConcurrentScans) throw new ScanUnavailable("busy");
  running++;
  lastScanAt.set(key, now);
  if (lastScanAt.size > 5000) lastScanAt.delete(lastScanAt.keys().next().value);
  try {
    return await scanSite(n, match, apps, opts);
  } finally {
    running--;
  }
}
