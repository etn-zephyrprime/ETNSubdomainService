// Domain signals for App Check: age (RDAP), HTTPS (a fact about the input) and punycode/mixed script (from
// normaliseInput). Rules in appCheck.config.js DOMAIN_RULES, flags in Contract Check's { id, severity, fact }
// shape.
//
// RDAP: the IANA bootstrap file (cached 24h) names each TLD's registry RDAP server; the registry's answer
// carries a "registration" event. Requests go only to https servers named in that IANA file — never to the
// domain being checked — through the App Check fetcher (safeFetch.js: SSRF checks, 5s connect timeout, size cap). Any failure, or a TLD with
// no RDAP server, is "age unknown": never a flag. A domain on a shared hosting platform (x.vercel.app) has
// no registration of its own, so its age is unknown too.
import { DOMAIN_RULES, MAX_DOMAIN_AGE_SEVERITY, RDAP } from "./appCheck.config.js";
import { safeFetchJsonResponse } from "./safeFetch.js";

const SEVERITY_RANK = { info: 0, caution: 1, high: 2 };
const DAY_MS = 24 * 3600 * 1000;
let bootstrap = null; // { services: Map(tld -> baseUrl), at }
const ageCache = new Map(); // registrable domain -> { registeredAt | null, at, ok }
const inFlight = new Map();

async function fetchJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(RDAP.timeoutMs),
    headers: { accept: "application/rdap+json, application/json" },
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > RDAP.maxBytes) throw new Error("response too large");
  const text = await res.text();
  if (text.length > RDAP.maxBytes) throw new Error("response too large");
  return JSON.parse(text);
}

/** tld -> https RDAP base URL, from the IANA bootstrap file. */
async function rdapServers(fetchImpl, now) {
  if (bootstrap && now - bootstrap.at < RDAP.bootstrapTtlMs) return bootstrap.services;
  const json = await fetchJson(RDAP.bootstrapUrl, fetchImpl);
  const services = new Map();
  for (const [tlds, urls] of json.services || []) {
    const base = (urls || []).find((u) => /^https:\/\//i.test(u));
    if (!base) continue;
    for (const tld of tlds) services.set(String(tld).toLowerCase(), base.endsWith("/") ? base : `${base}/`);
  }
  bootstrap = { services, at: now };
  return services;
}

/** The registration date in an RDAP domain answer, or null. */
export function registrationDate(rdap) {
  const ev = (rdap?.events || []).find((e) => String(e?.eventAction).toLowerCase() === "registration");
  const t = ev ? Date.parse(ev.eventDate) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** `{ registeredAt: ISO | null, known: boolean }` for a registrable domain. Never throws. */
export async function domainRegistration(domain, { fetchImpl = safeFetchJsonResponse, now = Date.now() } = {}) {
  const cached = ageCache.get(domain);
  if (cached && now - cached.at < (cached.ok ? RDAP.domainTtlMs : RDAP.failureTtlMs)) return { registeredAt: cached.registeredAt, known: cached.ok };
  if (inFlight.has(domain)) return inFlight.get(domain);
  const p = (async () => {
    let entry = { registeredAt: null, at: now, ok: false };
    try {
      const servers = await rdapServers(fetchImpl, now);
      const base = servers.get(domain.split(".").pop());
      if (base) {
        const registeredAt = registrationDate(await fetchJson(`${base}domain/${encodeURIComponent(domain)}`, fetchImpl));
        entry = { registeredAt, at: now, ok: !!registeredAt };
      }
    } catch (err) {
      console.warn(`⚠️  App Check: RDAP lookup failed for ${domain}: ${err.message}`);
    }
    if (ageCache.size >= RDAP.cacheMax) ageCache.delete(ageCache.keys().next().value);
    ageCache.set(domain, entry);
    return { registeredAt: entry.registeredAt, known: entry.ok };
  })().finally(() => inFlight.delete(domain));
  inFlight.set(domain, p);
  return p;
}

/** Tests only. */
export function _resetDomainSignals() {
  bootstrap = null;
  ageCache.clear();
  inFlight.clear();
}

const capAge = (severity) => (SEVERITY_RANK[severity] > SEVERITY_RANK[MAX_DOMAIN_AGE_SEVERITY] ? MAX_DOMAIN_AGE_SEVERITY : severity);

/**
 * The domain flags from facts already gathered: { id, severity, fact }, highest first.
 * `facts` = normaliseInput result; `match` = matchApp result; `ageDays` = number or "unknown".
 */
export function domainFlags(facts, match, ageDays, rules = DOMAIN_RULES) {
  const flags = [];
  const add = (id, severity, fact) => rules[id]?.enabled && flags.push({ id, severity, fact });
  if (match?.status === "lookalike") add("lookalike_domain", rules.lookalike_domain?.severity, `This site resembles ${match.resembles} (${match.app.name}) but isn't a listed site for it`);
  if (typeof ageDays === "number") {
    if (ageDays < rules.domain_age_under_7_days.days) add("domain_age_under_7_days", capAge(rules.domain_age_under_7_days.severity), `The domain was registered ${ageDays === 0 ? "today" : `${ageDays} day${ageDays === 1 ? "" : "s"} ago`}`);
    else if (ageDays < rules.domain_age_under_30_days.days) add("domain_age_under_30_days", capAge(rules.domain_age_under_30_days.severity), `The domain was registered ${ageDays} days ago`);
  }
  if (facts.https === false) add("not_https", rules.not_https?.severity, "The address uses http://, not https://, so the connection isn't encrypted");
  if ((facts.punycode || facts.mixedScript) && match?.status !== "known") {
    add(
      "idn_host",
      match?.status === "lookalike" ? rules.idn_host.lookalikeSeverity : rules.idn_host.severity,
      facts.mixedScript ? "The address mixes letters from different alphabets" : "The address uses international (non-Latin) characters"
    );
  }
  return flags.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/** `{ ageDays: number | "unknown", registeredAt, https, punycode, mixedScript, flags }`. Never throws. */
export async function getDomainSignals(facts, match, { fetchImpl = safeFetchJsonResponse, now = Date.now() } = {}) {
  let ageDays = "unknown";
  let registeredAt = null;
  if (!facts.sharedHosting) {
    const reg = await domainRegistration(facts.registrableDomain, { fetchImpl, now });
    if (reg.known) {
      registeredAt = reg.registeredAt;
      ageDays = Math.max(0, Math.floor((now - Date.parse(reg.registeredAt)) / DAY_MS));
    }
  }
  return { ageDays, registeredAt, https: facts.https, punycode: facts.punycode, mixedScript: facts.mixedScript, flags: domainFlags(facts, match, ageDays) };
}
