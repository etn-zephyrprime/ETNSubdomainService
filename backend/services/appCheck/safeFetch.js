// App Check's fetcher — the ONLY code that makes requests to user-supplied hosts (the site scan, and RDAP).
// A server fetching arbitrary URLs is a security boundary, so every hop:
//   - is http(s) on port 80/443 only, with no credentials in the URL and no IP-literal host;
//   - has its host resolved HERE, every resolved address checked (ipRanges.js: public unicast only; one
//     internal address refuses the host), and the connection pinned to the checked address (the original
//     Host header and TLS SNI kept) — so DNS rebinding can't swap the address between check and connect;
//   - is re-checked on every redirect (at most 3);
//   - has a 5s connect timeout and a 10s total, a 2 MB cap per (decompressed) response, an allow-list of
//     content types (aborted before the body is read otherwise), and counts against the scan's budget
//     (15 MB and 40 requests);
//   - sends no cookies, no auth, nothing about the user: only a generic User-Agent, Accept and Accept-Encoding
//     (and If-None-Match / If-Modified-Since when revalidating).
// Nothing fetched is ever executed: callers get text and a SHA-256.
import http from "http";
import https from "https";
import net from "net";
import zlib from "zlib";
import crypto from "crypto";
import { lookup } from "dns/promises";
import { isPublicAddress } from "./ipRanges.js";
import { describeHost } from "./normaliseInput.js";
import { FETCH, SCAN } from "./appCheck.config.js";

export class SafeFetchError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** A per-scan budget: requests (redirect hops included) and bytes across every response. */
export function createScanBudget({ maxRequests = SCAN.maxRequests, maxBytes = SCAN.maxBytes } = {}) {
  return { maxRequests, maxBytes, requests: 0, bytes: 0 };
}

const defaultResolve = (host) => lookup(host, { all: true, verbatim: true });

function allowedType(kind, contentType, types) {
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!ct) return false;
  if (kind === "json" && /^application\/[\w.-]+\+json$/.test(ct)) return true;
  return (types[kind] || []).includes(ct);
}

/**
 * A fetcher. Options are for tests (fake DNS, a local server's port and address); production uses the defaults.
 * `fetchText(url, { kind: "html" | "script" | "json", budget?, conditional?: { etag, lastModified } })` ->
 * `{ status, url, headers: { etag, lastModified, contentType }, body, bytes, sha256 }` (body only for 2xx).
 * Throws SafeFetchError with `code` for anything refused or failed.
 */
export function createFetcher({
  resolve = defaultResolve,
  isAllowed = isPublicAddress,
  ports = FETCH.ports,
  connectTimeoutMs = FETCH.connectTimeoutMs,
  totalTimeoutMs = FETCH.totalTimeoutMs,
  maxRedirects = FETCH.maxRedirects,
  maxResponseBytes = FETCH.maxResponseBytes,
  contentTypes = FETCH.contentTypes,
  userAgent = FETCH.userAgent,
  tls = {},
} = {}) {
  async function checkTarget(urlString) {
    let url;
    try {
      url = new URL(urlString);
    } catch {
      throw new SafeFetchError("bad_url");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("scheme", `scheme ${url.protocol} not allowed`);
    if (url.username || url.password) throw new SafeFetchError("credentials");
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (!ports.includes(port)) throw new SafeFetchError("port", `port ${port} not allowed`);
    const host = url.hostname.replace(/\.$/, "").toLowerCase();
    if (net.isIP(host.replace(/^\[|\]$/g, "")) || host.startsWith("[")) throw new SafeFetchError("ip_literal");
    if (host === "localhost" || host.endsWith(".localhost") || !describeHost(host)) throw new SafeFetchError("not_public_host", `${host} isn't a public host`);

    let answers;
    try {
      answers = await Promise.race([
        resolve(host),
        new Promise((_, reject) => setTimeout(() => reject(new SafeFetchError("dns_timeout")), connectTimeoutMs).unref?.()),
      ]);
    } catch (err) {
      throw err instanceof SafeFetchError ? err : new SafeFetchError("dns", `couldn't resolve ${host}`);
    }
    const list = (Array.isArray(answers) ? answers : [answers]).filter(Boolean).map((a) => (typeof a === "string" ? { address: a, family: net.isIP(a) } : a));
    if (!list.length) throw new SafeFetchError("dns", `no address for ${host}`);
    // one internal address is enough to refuse: a mixed answer is how rebinding attempts look
    if (list.some((a) => !isAllowed(a.address))) throw new SafeFetchError("blocked_address", `${host} resolves to a non-public address`);
    const { address, family } = list[0];
    return { url, host, port, address, family: family || net.isIP(address) };
  }

  function requestOnce(target, { kind, budget, conditional, deadline }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);
        fn(v);
      };
      const fail = (code, message) => {
        req.destroy();
        done(reject, new SafeFetchError(code, message));
      };

      const headers = { "user-agent": userAgent, accept: kind === "html" ? "text/html,application/xhtml+xml" : kind === "json" ? "application/json, application/rdap+json" : "*/*", "accept-encoding": "gzip, deflate, br" };
      if (conditional?.etag) headers["if-none-match"] = conditional.etag;
      if (conditional?.lastModified) headers["if-modified-since"] = conditional.lastModified;

      const transport = target.url.protocol === "https:" ? https : http;
      const req = transport.request({
        protocol: target.url.protocol,
        hostname: target.host,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        method: "GET",
        headers,
        agent: false, // a fresh connection: nothing shared, no cookies, no pooled sockets
        autoSelectFamily: false,
        // pin the connection to the address checked above (Host header and SNI stay the hostname)
        lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address: target.address, family: target.family }]) : cb(null, target.address, target.family)),
        ...(target.url.protocol === "https:" ? { servername: target.host, ...tls } : {}),
      });

      const connectTimer = setTimeout(() => fail("connect_timeout"), connectTimeoutMs);
      const totalTimer = setTimeout(() => fail("timeout"), Math.max(1, deadline - Date.now()));
      req.on("socket", (socket) => {
        socket.once(target.url.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
        // never talk to anything but the pinned address
        socket.once("connect", () => {
          if (socket.remoteAddress && socket.remoteAddress.replace(/^::ffff:/, "") !== target.address.replace(/^::ffff:/, "")) fail("pin_mismatch");
        });
      });
      req.on("error", (err) => done(reject, err instanceof SafeFetchError ? err : new SafeFetchError("network", err.code || err.message)));
      req.on("response", (res) => {
        const status = res.statusCode;
        const meta = { etag: res.headers.etag || null, lastModified: res.headers["last-modified"] || null, contentType: res.headers["content-type"] || null };
        if (status >= 300 && status < 400 && status !== 304) {
          res.resume();
          return done(resolve, { redirect: res.headers.location || null, status, headers: meta });
        }
        if (status === 304 || status < 200 || status >= 300) {
          res.resume();
          return done(resolve, { status, headers: meta, body: null, bytes: 0, sha256: null });
        }
        if (!allowedType(kind, meta.contentType, contentTypes)) return fail("content_type", `content type ${meta.contentType || "(none)"} not allowed`);
        const declared = Number(res.headers["content-length"] || 0);
        if (declared > maxResponseBytes) return fail("too_large");
        if (budget && budget.bytes + declared > budget.maxBytes) return fail("budget_bytes");

        const enc = String(res.headers["content-encoding"] || "identity").toLowerCase();
        let stream = res;
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc !== "identity") return fail("encoding", `content encoding ${enc} not supported`);

        const chunks = [];
        let bytes = 0;
        stream.on("data", (c) => {
          bytes += c.length;
          if (bytes > maxResponseBytes) return fail("too_large");
          if (budget && budget.bytes + bytes > budget.maxBytes) return fail("budget_bytes");
          chunks.push(c);
        });
        stream.on("error", (err) => fail("decode", err.message));
        stream.on("end", () => {
          if (settled) return;
          const buf = Buffer.concat(chunks);
          if (budget) budget.bytes += buf.length;
          done(resolve, { status, headers: meta, body: buf.toString("utf8"), bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") });
        });
      });
      req.end();
    });
  }

  async function fetchText(urlString, { kind = "html", budget = null, conditional = null } = {}) {
    const deadline = Date.now() + totalTimeoutMs;
    let current = urlString;
    for (let hop = 0; ; hop++) {
      if (budget) {
        if (budget.requests >= budget.maxRequests) throw new SafeFetchError("budget_requests");
        budget.requests++;
      }
      const target = await checkTarget(current); // every hop, redirects included
      if (Date.now() >= deadline) throw new SafeFetchError("timeout");
      const res = await requestOnce(target, { kind, budget, conditional, deadline });
      if (res.redirect === undefined) return { ...res, url: target.url.toString() };
      if (!res.redirect) throw new SafeFetchError("bad_redirect");
      if (hop >= maxRedirects) throw new SafeFetchError("too_many_redirects");
      current = new URL(res.redirect, target.url).toString();
    }
  }

  return { fetchText, checkTarget };
}

const defaultFetcher = createFetcher();

/** fetchText with the production settings. */
export const safeFetchText = (url, opts) => defaultFetcher.fetchText(url, opts);

/** A minimal fetch()-shaped adapter over safeFetchText for JSON APIs (RDAP). */
export async function safeFetchJsonResponse(url) {
  const r = await safeFetchText(url, { kind: "json" });
  return { status: r.status, headers: new Map([["content-type", r.headers.contentType]]), text: async () => r.body ?? "" };
}
