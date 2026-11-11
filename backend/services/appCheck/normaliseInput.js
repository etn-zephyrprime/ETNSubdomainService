// App Check input handling: a full URL, a bare domain, or an app name.
//
// This is the first of two SSRF layers (the fetcher is the second): only http(s), no credentials, no
// non-standard ports, no IP literals in any spelling (WHATWG URL parsing already turns 2130706433, 0x7f.1
// and 0177.0.0.1 into 127.0.0.1, so the check runs on the parsed host), no localhost, nothing without a
// public suffix. Nothing here makes a network request.
import { domainToUnicode } from "url";
import { parse as parseDomain } from "tldts";
import { LIMITS, SHARED_HOSTING_SUFFIXES, TRACKING_PARAMS } from "./appCheck.config.js";

const OTHER_SCHEMES = /^(javascript|data|file|mailto|vbscript|blob|about|view-source|ws|wss|ftp|sftp|chrome|chrome-extension|intent|tel|sms|ipfs|ipns|gopher|ldap|dict|smb|ssh|git|jar|res):/i;
const HAS_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const NAME_ONLY = /^[\p{L}\p{N}][\p{L}\p{N} _'&-]*$/u;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const invalid = (input, detail, message) => ({ ok: false, kind: "invalid", input, reason: "invalid_input", detail, message });

/** The scripts the letters of a (decoded) label are written in, e.g. ["Latin", "Cyrillic"]. */
export function labelScripts(label) {
  const scripts = new Set();
  for (const ch of label) {
    if (!/\p{L}/u.test(ch)) continue;
    if (/\p{Script=Latin}/u.test(ch)) scripts.add("Latin");
    else if (/\p{Script=Cyrillic}/u.test(ch)) scripts.add("Cyrillic");
    else if (/\p{Script=Greek}/u.test(ch)) scripts.add("Greek");
    else if (/\p{Script=Armenian}/u.test(ch)) scripts.add("Armenian");
    else scripts.add("Other");
  }
  return [...scripts];
}

/** The shared-hosting suffix a host sits on (e.g. "vercel.app"), or null. */
export function sharedHostingSuffix(host, parsed = parseDomain(host, { allowPrivateDomains: true })) {
  const listed = SHARED_HOSTING_SUFFIXES.filter((s) => host.endsWith(`.${s}`)).sort((a, b) => b.length - a.length)[0];
  if (listed) return listed;
  return parsed?.isPrivate ? parsed.publicSuffix : null;
}

/** Host facts: registrable domain, label, suffix, shared hosting, punycode, scripts. Null if no public suffix. */
export function describeHost(host) {
  const parsed = parseDomain(host, { allowPrivateDomains: true });
  if (parsed.isIp) return null;
  let { domain, publicSuffix: suffix, domainWithoutSuffix: label, subdomain } = parsed;
  if (!domain) {
    // the host IS a private suffix (vercel.app itself): use the ICANN view
    const icann = parseDomain(host);
    if (!icann.domain || !icann.isIcann) return null;
    ({ domain, publicSuffix: suffix, domainWithoutSuffix: label, subdomain } = icann);
  } else if (!parsed.isIcann && !parsed.isPrivate) {
    return null; // e.g. foo.local, foo.internal: no real public suffix
  }
  const shared = sharedHostingSuffix(host, parsed);
  if (shared && suffix !== shared && host !== shared) {
    // a platform the public-suffix list doesn't know as private: <label>.<platform> is the registrable unit
    const rest = host.slice(0, -(shared.length + 1)).split(".");
    label = rest.pop();
    subdomain = rest.join(".");
    suffix = shared;
    domain = `${label}.${shared}`;
  }
  const displayHost = domainToUnicode(host) || host;
  const displayLabel = domainToUnicode(`${label}.${suffix}`).split(".")[0] || label;
  const scripts = [...new Set(displayHost.split(".").flatMap(labelScripts))];
  const mixedScript = displayHost.split(".").some((l) => labelScripts(l).length > 1);
  return {
    host,
    displayHost,
    registrableDomain: domain,
    label,
    displayLabel,
    suffix,
    subdomain: subdomain || "",
    sharedHosting: shared && host !== shared ? shared : null,
    punycode: host.split(".").some((l) => l.startsWith("xn--")),
    mixedScript,
    scripts,
  };
}

/**
 * `{ ok: true, kind: "url", … }`, `{ ok: true, kind: "name", query }` or
 * `{ ok: false, kind: "invalid", reason: "invalid_input", detail, message }`.
 */
export function normaliseInput(raw) {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return invalid(input, "empty", "Enter a website address or an app name.");
  if (input.length > LIMITS.maxInputLength) return invalid(input.slice(0, 80), "too_long", "That's too long to be a website address.");
  if (/[\u0000-\u001f\u007f]/.test(input)) return invalid(input, "control_chars", "That contains characters a website address can't have.");
  if (input.toLowerCase() === "localhost") return invalid(input, "localhost", "That's a local address, not a public website.");

  // an app name: letters/digits, no dot, no scheme
  if (!input.includes(".") && !input.includes(":") && !input.includes("/") && NAME_ONLY.test(input)) {
    return { ok: true, kind: "name", input, query: input.toLowerCase() };
  }
  if (/\s/.test(input)) return invalid(input, "whitespace", "A website address can't contain spaces.");

  let withScheme;
  let https = null; // what the input said; null for a bare domain (we don't know, so no flag)
  const scheme = input.match(HAS_SCHEME)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme !== "http" && scheme !== "https") return invalid(input, "scheme", "Only http:// and https:// addresses can be checked.");
    withScheme = input;
    https = scheme === "https";
  } else if (OTHER_SCHEMES.test(input)) {
    return invalid(input, "scheme", "Only http:// and https:// addresses can be checked.");
  } else {
    withScheme = `http://${input.replace(/^\/\//, "")}`;
  }

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return invalid(input, "unparseable", "That doesn't look like a website address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return invalid(input, "scheme", "Only http:// and https:// addresses can be checked.");
  if (url.username || url.password) return invalid(input, "credentials", "Addresses with a username or password in them can't be checked.");
  if (url.port) return invalid(input, "port", "Only addresses on the standard web ports can be checked.");

  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (!host) return invalid(input, "no_host", "That doesn't look like a website address.");
  if (host.startsWith("[") || host.includes(":") || IPV4.test(host)) return invalid(input, "ip_literal", "IP addresses can't be checked — enter the site's domain name.");
  if (host === "localhost" || host.endsWith(".localhost")) return invalid(input, "localhost", "That's a local address, not a public website.");
  if (host.length > 253 || host.split(".").some((l) => !l || l.length > 63)) return invalid(input, "bad_host", "That doesn't look like a valid domain name.");

  const facts = describeHost(host);
  if (!facts) return invalid(input, "no_public_suffix", "That isn't a public website address (no recognised domain ending).");

  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  url.hostname = host;
  if (https === null) url.protocol = "https:"; // a bare domain is fetched over https (Phase 2); `https` stays null
  const origin = `${https === false ? "http:" : "https:"}//${host}`; // the cache key; a bare domain counts as https

  return { ok: true, kind: "url", input, url: url.toString(), origin, https, ...facts };
}
