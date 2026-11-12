// Argus App Check, phase 2: the fetcher (the SSRF boundary) and the site scan. The fetcher runs against a
// local server with fake DNS; blocked targets must fail BEFORE any connection is made (the server counts
// connections). The scan runs on fixture pages. No real site is contacted.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import zlib from "zlib";
import { readFileSync, readdirSync } from "fs";
import { createFetcher, createScanBudget, SafeFetchError } from "../services/appCheck/safeFetch.js";
import { isPublicAddress } from "../services/appCheck/ipRanges.js";
import { extractAddresses, pageScripts, chunkRefs } from "../services/appCheck/extractAddresses.js";
import { scanSite, runScan, _resetScanGate, ScanUnavailable, FOUND_IN_CODE } from "../services/appCheck/scanSite.js";
import { normaliseInput } from "../services/appCheck/normaliseInput.js";
import { matchApp } from "../services/appCheck/matchApp.js";
import { seedApps, validateApps } from "../services/appCheck/registry.js";
import { computeOverall } from "../services/appCheck/appResult.js";
import { checkApp } from "../services/appCheck/appCheck.js";
import { SCAN } from "../services/appCheck/appCheck.config.js";

const APPS = validateApps(seedApps(), () => {});

// ── a local server ─────────────────────────────────────────────────────────────────────────────────────
let server, port;
let connections = 0;
const seenRequests = [];
before(async () => {
  server = http.createServer((req, res) => {
    seenRequests.push({ url: req.url, headers: req.headers });
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { "content-type": type, ...extra });
      res.end(body);
    };
    switch (req.url) {
      case "/page":
        return send(200, "text/html; charset=utf-8", "<html><script src='/app.js'></script></html>", { etag: '"v1"' });
      case "/app.js":
        return send(200, "application/javascript", "const r='0x2c12c8f15637b7a182dec202816148a5e767dcec'");
      case "/json":
        return send(200, "application/rdap+json", '{"ok":true}');
      case "/big":
        return send(200, "text/html", "x".repeat(3 * 1024 * 1024));
      case "/big-chunked": {
        res.writeHead(200, { "content-type": "text/html" });
        for (let i = 0; i < 30; i++) res.write("y".repeat(100 * 1024));
        return res.end();
      }
      case "/bomb":
        return send(200, "text/html", zlib.gzipSync(Buffer.alloc(10 * 1024 * 1024)), { "content-encoding": "gzip" });
      case "/gzip":
        return send(200, "text/html", zlib.gzipSync("<html>hello</html>"), { "content-encoding": "gzip" });
      case "/slow":
        return setTimeout(() => send(200, "text/html", "late"), 1500);
      case "/image":
        return send(200, "image/png", Buffer.alloc(1000));
      case "/no-type":
        res.writeHead(200);
        return res.end("x");
      case "/to-internal":
        return send(302, "text/html", "", { location: `http://internal.example.com:${port}/page` });
      case "/to-ip":
        return send(302, "text/html", "", { location: `http://127.0.0.1:${port}/page` });
      case "/to-file":
        return send(302, "text/html", "", { location: "file:///etc/passwd" });
      case "/to-page":
        return send(301, "text/html", "", { location: "/page" });
      case "/notmodified":
        return send(304, "text/html", "");
      default: {
        const loop = req.url.match(/^\/loop(\d+)$/);
        if (loop) return send(302, "text/html", "", { location: `/loop${Number(loop[1]) + 1}` });
        return send(404, "text/html", "nope");
      }
    }
  });
  server.on("connection", () => connections++);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => server.close());
beforeEach(() => {
  connections = 0;
  seenRequests.length = 0;
  _resetScanGate();
});

// fake DNS: the test server is "public" only for these fetchers
const DNS = {
  "site.example.com": ["127.0.0.1"],
  "internal.example.com": ["10.0.0.7"],
  "metadata.example.com": ["169.254.169.254"],
  "loopback.example.com": ["127.0.0.1"],
  "v6loop.example.com": ["::1"],
  "mapped.example.com": ["::ffff:127.0.0.1"],
  "mapped-hex.example.com": ["::ffff:7f00:1"],
  "linklocal6.example.com": ["fe80::1"],
  "ula.example.com": ["fd00::1"],
  "cgnat.example.com": ["100.64.1.1"],
  "multicast.example.com": ["224.0.0.251"],
  "mixed.example.com": ["127.0.0.1", "10.0.0.1"],
};
const fakeResolve = (calls = []) => async (host) => {
  calls.push(host);
  const a = DNS[host];
  if (!a) throw new Error("ENOTFOUND");
  return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};
const testFetcher = (opts = {}) => createFetcher({ resolve: fakeResolve(opts.calls), isAllowed: (ip) => ip === "127.0.0.1", ports: [port], totalTimeoutMs: 500, connectTimeoutMs: 500, ...opts });
const url = (host, path) => `http://${host}:${port}${path}`;
const rejects = async (p, code) => {
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof SafeFetchError, `expected SafeFetchError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
};

// ── the fetcher ────────────────────────────────────────────────────────────────────────────────────────
test("the real address check refuses every internal range, and no connection is made", async () => {
  const f = createFetcher({ resolve: fakeResolve(), ports: [port] }); // the PRODUCTION address check
  for (const host of ["loopback.example.com", "internal.example.com", "metadata.example.com", "v6loop.example.com", "mapped.example.com", "mapped-hex.example.com", "linklocal6.example.com", "ula.example.com", "cgnat.example.com", "multicast.example.com", "mixed.example.com"]) {
    await rejects(f.fetchText(url(host, "/page")), "blocked_address");
  }
  assert.equal(connections, 0);
});

test("ipRanges: public unicast only", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.5", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::ffff:7f00:1", "fe80::1", "fc00::1", "2001:db8::1", "64:ff9b::808:808", "2002:c000:0204::1", "ff02::1", "nonsense", ""]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test("IP-literal hosts, other schemes, credentials, odd ports and non-public hosts are refused before DNS", async () => {
  const calls = [];
  const f = testFetcher({ calls });
  await rejects(f.fetchText(`http://127.0.0.1:${port}/page`), "ip_literal");
  await rejects(f.fetchText(`http://[::1]:${port}/page`), "ip_literal");
  await rejects(f.fetchText(`http://2130706433:${port}/page`), "ip_literal");
  await rejects(f.fetchText("file:///etc/passwd"), "scheme");
  await rejects(f.fetchText("ftp://site.example.com/x"), "scheme");
  await rejects(f.fetchText(`http://user:pw@site.example.com:${port}/page`), "credentials");
  await rejects(f.fetchText("http://site.example.com:8080/page"), "port");
  await rejects(f.fetchText(`http://localhost:${port}/page`), "not_public_host");
  await rejects(f.fetchText(`http://intranet.local:${port}/page`), "not_public_host");
  assert.deepEqual(calls, []);
  assert.equal(connections, 0);
  // production: only 80 and 443
  await rejects(createFetcher({ resolve: fakeResolve() }).fetchText(url("site.example.com", "/page")), "port");
});

test("a normal fetch: text, hash, ETag, and only generic headers sent", async () => {
  const r = await testFetcher().fetchText(url("site.example.com", "/page"), { kind: "html" });
  assert.equal(r.status, 200);
  assert.match(r.body, /app\.js/);
  assert.equal(r.headers.etag, '"v1"');
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  const h = seenRequests[0].headers;
  assert.deepEqual(Object.keys(h).sort(), ["accept", "accept-encoding", "connection", "host", "user-agent"]);
  assert.equal(h["user-agent"], "ArgusAppCheck/1.0 (+https://dashboard.planetzephyros.xyz/about)");
  assert.equal(h.host, `site.example.com:${port}`);
  assert.ok(!h.cookie && !h.authorization);
});

test("conditional requests send only If-None-Match / If-Modified-Since, and a 304 has no body", async () => {
  const r = await testFetcher().fetchText(url("site.example.com", "/notmodified"), { conditional: { etag: '"v1"', lastModified: "Tue, 10 Nov 2026 10:00:00 GMT" } });
  assert.equal(r.status, 304);
  assert.equal(r.body, null);
  assert.equal(seenRequests[0].headers["if-none-match"], '"v1"');
});

test("redirects are re-checked: to an internal host, an IP literal or another scheme is refused", async () => {
  const calls = [];
  await rejects(testFetcher({ calls }).fetchText(url("site.example.com", "/to-internal")), "blocked_address");
  assert.deepEqual(calls, ["site.example.com", "internal.example.com"]);
  assert.equal(seenRequests.length, 1); // only the first hop reached a server
  await rejects(testFetcher().fetchText(url("site.example.com", "/to-ip")), "ip_literal");
  await rejects(testFetcher().fetchText(url("site.example.com", "/to-file")), "scheme");
  const ok = await testFetcher().fetchText(url("site.example.com", "/to-page"));
  assert.equal(ok.status, 200);
  assert.match(ok.url, /\/page$/);
});

test("at most 3 redirects", async () => {
  await rejects(testFetcher().fetchText(url("site.example.com", "/loop1")), "too_many_redirects");
  assert.equal(seenRequests.length, 4); // the first request + 3 redirects
});

test("DNS rebinding: the connection is pinned to the address that was checked", async () => {
  let n = 0;
  const calls = [];
  const rebinding = async (host) => {
    calls.push(host);
    return [{ address: n++ === 0 ? "127.0.0.1" : "10.0.0.66", family: 4 }]; // first answer good, later ones internal
  };
  const f = createFetcher({ resolve: rebinding, isAllowed: (ip) => ip === "127.0.0.1", ports: [port], totalTimeoutMs: 500 });
  const r = await f.fetchText(url("site.example.com", "/page"));
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1); // resolved once, by us; the socket never re-resolved
  // the next request resolves again, gets the internal answer, and is refused
  await rejects(f.fetchText(url("site.example.com", "/page")), "blocked_address");
});

test("oversized responses are cut off, declared or not, and decompression bombs too", async () => {
  const f = testFetcher({ maxResponseBytes: 2 * 1024 * 1024 });
  await rejects(f.fetchText(url("site.example.com", "/big")), "too_large");
  await rejects(f.fetchText(url("site.example.com", "/big-chunked")), "too_large");
  await rejects(f.fetchText(url("site.example.com", "/bomb")), "too_large");
  const gz = await f.fetchText(url("site.example.com", "/gzip"));
  assert.equal(gz.body, "<html>hello</html>");
});

test("slow responses time out", async () => {
  await rejects(testFetcher({ totalTimeoutMs: 200 }).fetchText(url("site.example.com", "/slow")), "timeout");
});

test("wrong content types are aborted", async () => {
  await rejects(testFetcher().fetchText(url("site.example.com", "/image"), { kind: "html" }), "content_type");
  await rejects(testFetcher().fetchText(url("site.example.com", "/no-type"), { kind: "html" }), "content_type");
  await rejects(testFetcher().fetchText(url("site.example.com", "/app.js"), { kind: "html" }), "content_type");
  assert.equal((await testFetcher().fetchText(url("site.example.com", "/app.js"), { kind: "script" })).status, 200);
  assert.equal((await testFetcher().fetchText(url("site.example.com", "/json"), { kind: "json" })).status, 200);
});

test("the scan budget caps requests (redirect hops count) and bytes", async () => {
  const budget = createScanBudget({ maxRequests: 2, maxBytes: 1024 * 1024 });
  await testFetcher().fetchText(url("site.example.com", "/to-page"), { budget }); // 2 hops
  assert.equal(budget.requests, 2);
  await rejects(testFetcher().fetchText(url("site.example.com", "/page"), { budget }), "budget_requests");
  const small = createScanBudget({ maxRequests: 10, maxBytes: 100 });
  await rejects(testFetcher().fetchText(url("site.example.com", "/big-chunked"), { budget: small }), "budget_bytes");
});

test("every outbound request to a user-supplied host goes through safeFetch.js", () => {
  const dirs = ["../services/appCheck/", "../utils/"];
  for (const d of dirs) {
    const dir = new URL(d, import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      if (d.includes("utils") && !/^appCheck/.test(f)) continue;
      if (f === "safeFetch.js") continue;
      const src = readFileSync(new URL(f, dir), "utf8");
      assert.doesNotMatch(src, /\bfetch\(|https?\.request\(|https?\.get\(|net\.connect\(|createConnection\(|tls\.connect\(|from "(http|https|tls|undici|axios|node-fetch)"/, `${d}${f}`);
    }
  }
});

// ── extraction ─────────────────────────────────────────────────────────────────────────────────────────
test("address extraction: EIP-55 checked, embedded hex and junk rejected, occurrences counted", () => {
  const good = "0x072D4706f9A383D5608BD14B09b41683cb95fFd7"; // valid checksum
  const bad = "0x072D4706f9A383D5608BD14B09b41683cb95fFD7"; // one letter's case wrong
  const text = [
    good,
    good.toLowerCase(),
    bad,
    "0x2c12c8f15637b7a182dec202816148a5e767dcec",
    `tx 0x${"ab".repeat(32)}`, // a 32-byte hash
    "0x2c12c8f15637b7a182dec202816148a5e767dcec00", // longer hex
    "a0x2c12c8f15637b7a182dec202816148a5e767dcec", // glued to an identifier
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dEaD",
    "0x0000000000000000000000000000000000000004", // precompile
    "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  ].join(" ");
  const m = extractAddresses(text);
  assert.deepEqual([...m], [[good.toLowerCase(), 2], ["0x2c12c8f15637b7a182dec202816148a5e767dcec", 1]]);
});

test("script discovery: src, modulepreload, preload as=script, inline; <base> honoured", () => {
  const html = `<base href="/v2/"><script type="module" src="/assets/index.js"></script><link rel="modulepreload" href="assets/vendor.js">
    <link rel="preload" as="script" href="https://cdn.example.org/lib.js"><link rel="stylesheet" href="x.css"><script>var a=1</script>`;
  const { scriptUrls, inline } = pageScripts(html, "https://site.example.com/page");
  assert.deepEqual(scriptUrls, ["https://site.example.com/assets/index.js", "https://site.example.com/v2/assets/vendor.js", "https://cdn.example.org/lib.js"]);
  assert.deepEqual(inline, ["var a=1"]);
  assert.deepEqual(chunkRefs(`import("./c.js");x=["assets/Swap-1.js","a.css"];import("../u.mjs")`, "https://site.example.com/assets/index.js", "https://site.example.com"), [
    "https://site.example.com/assets/c.js",
    "https://site.example.com/assets/Swap-1.js",
    "https://site.example.com/u.mjs",
  ]);
});

// ── the scan ───────────────────────────────────────────────────────────────────────────────────────────
const ROUTER = "0x2c12c8f15637b7a182dec202816148a5e767dcec"; // ElectroSwap Universal Router (registry)
const WETN = "0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77";
const OTHER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const DEEP = "0x3333333333333333333333333333333333333333";
const DEEPER = "0x4444444444444444444444444444444444444444";

function fixtureSite(pages) {
  const fetched = [];
  const fetchText = async (u, { kind }) => {
    fetched.push(u);
    const p = pages[u];
    if (!p) return { status: 404, url: u, headers: {}, body: null };
    if (p.error) throw new SafeFetchError(p.error);
    return { status: p.status || 200, url: u, headers: { etag: p.etag || null, lastModified: null }, body: p.body, sha256: `sha-${u}`, kind };
  };
  return { fetchText, fetched };
}
const SITE = "https://clone-site.example.com";
const basePages = () => ({
  [`${SITE}/`]: { body: `<html><script src="/assets/index.js"></script><script>window.cfg={wetn:"${WETN}"}</script></html>`, etag: '"e1"' },
  [`${SITE}/assets/index.js`]: { body: `const r="${ROUTER}",o="${OTHER}",w="${WALLET}",o2="${OTHER}";import("./Swap.js")` },
  [`${SITE}/assets/Swap.js`]: { body: `const d="${DEEP}";import("./deep.js")` },
  [`${SITE}/assets/deep.js`]: { body: `const e="${DEEPER}";import("./deeper.js")` },
  [`${SITE}/assets/deeper.js`]: { body: `const never="0x5555555555555555555555555555555555555555"` },
});
const codeOf = (calls = []) => async (a) => {
  calls.push(a);
  return a === WALLET ? "0x" : "0x6080";
};
const analyseStub = (calls = []) => async (a) => {
  calls.push(a);
  return { identity: { isContract: true }, overall: a === OTHER ? "red" : "green", riskFlags: a === OTHER ? [{ id: "mint_power", severity: "high" }] : [] };
};
const site = (u = `${SITE}/`) => {
  const n = normaliseInput(u);
  return { n, match: matchApp(n, APPS) };
};

test("a scan follows scripts and chunks at most 2 levels deep, splits contracts from wallets, and labels them", async () => {
  const { n, match } = site();
  const { fetchText, fetched } = fixtureSite(basePages());
  const scan = await scanSite(n, match, APPS, { fetchText, getCode: codeOf(), analyse: analyseStub() });
  assert.equal(scan.status, "ok");
  assert.ok(!fetched.includes(`${SITE}/assets/deeper.js`)); // level 3: not fetched
  assert.deepEqual(Object.keys(scan.addresses).sort(), [ROUTER, WETN, OTHER, WALLET, DEEP, DEEPER].sort());
  assert.equal(scan.addresses[OTHER], 2);
  assert.deepEqual(scan.wallets.map((w) => w.address), [WALLET]);
  const router = scan.contracts.find((c) => c.address === ROUTER);
  assert.equal(router.label, "ElectroSwap: universal router");
  assert.equal(router.foundIn, FOUND_IN_CODE);
  assert.equal(scan.contracts.length, 5);
  assert.equal(scan.htmlHash, `sha-${SITE}/`);
  assert.equal(scan.etag, '"e1"');
});

test("registry contracts on an unknown site are a caution; WETN/CORE alone aren't; a wallet is info", async () => {
  const { n, match } = site();
  const scan = await scanSite(n, match, APPS, { fetchText: fixtureSite(basePages()).fetchText, getCode: codeOf(), analyse: analyseStub() });
  assert.deepEqual(scan.flags.map((f) => [f.id, f.severity]), [["uses_known_app_contracts", "caution"], ["hardcoded_wallet", "info"]]);
  assert.match(scan.flags[0].fact, /belonging to ElectroSwap but isn't a listed site for ElectroSwap/);

  const onlyWetn = { [`${SITE}/`]: { body: `<script>const w="${WETN}"</script>` } };
  const scan2 = await scanSite(n, match, APPS, { fetchText: fixtureSite(onlyWetn).fetchText, getCode: codeOf(), analyse: analyseStub() });
  assert.deepEqual(scan2.flags, []);
});

test("eth_getCode and Contract Check run one at a time; registry contracts first; the contract cap truncates the analysis", async () => {
  const { n, match } = site();
  let active = 0, peak = 0;
  const getCode = async (a) => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 1));
    active--;
    return a === WALLET ? "0x" : "0x60";
  };
  const analysed = [];
  const scan = await scanSite(n, match, APPS, { fetchText: fixtureSite(basePages()).fetchText, getCode, analyse: analyseStub(analysed), limits: { ...SCAN, maxContracts: 2 } });
  assert.equal(peak, 1);
  assert.deepEqual(analysed.slice(0, 2).sort(), [ROUTER, WETN].sort()); // the registry's first
  assert.equal(analysed.length, 2);
  assert.equal(scan.truncated.contracts, 3);
  assert.equal(scan.status, "ok"); // the set is complete; only the badges are capped
  assert.equal(scan.contracts.filter((c) => c.note === "not analysed (contract cap reached)").length, 3);
});

test("partial scans: a page script failing, or a getCode error; a chunk 404 doesn't count", async () => {
  const { n, match } = site();
  const pages = basePages();
  delete pages[`${SITE}/assets/Swap.js`]; // chunk ref 404: fine
  const ok = await scanSite(n, match, APPS, { fetchText: fixtureSite(pages).fetchText, getCode: codeOf(), analyse: analyseStub() });
  assert.equal(ok.status, "ok");
  delete pages[`${SITE}/assets/index.js`]; // a script the page loads: partial
  const partial = await scanSite(n, match, APPS, { fetchText: fixtureSite(pages).fetchText, getCode: codeOf(), analyse: analyseStub() });
  assert.equal(partial.status, "partial");
  const rpcDown = await scanSite(n, match, APPS, { fetchText: fixtureSite(basePages()).fetchText, getCode: async () => { throw new Error("rpc"); }, analyse: analyseStub() });
  assert.equal(rpcDown.status, "partial");
  assert.equal(rpcDown.contracts.length, 0);
  assert.equal(rpcDown.unchecked.length, 6);
});

test("a failed page fetch is 'failed', with no contracts and never a 'no contracts' or green answer", async () => {
  const { n, match } = site();
  for (const page of [{ status: 503, body: null }, { error: "timeout" }]) {
    const scan = await scanSite(n, match, APPS, { fetchText: fixtureSite({ [`${SITE}/`]: page }).fetchText, getCode: codeOf(), analyse: analyseStub() });
    assert.equal(scan.status, "failed");
    const o = computeOverall({ status: "unknown", scan, contracts: [] });
    assert.equal(o.overall, "unassessed");
    assert.doesNotMatch(o.overallReason, /No contracts found/);
  }
});

test("checkApp with a scan: unknown site with a red contract is red; a clean one stays unassessed", async () => {
  const opts = (pages, analyse) => ({ core: true, scan: true, apps: APPS, fetchText: fixtureSite(pages).fetchText, getCode: codeOf(), analyse, fetchImpl: async () => { throw new Error("offline"); } });
  const red = await checkApp(`${SITE}/`, opts(basePages(), analyseStub()));
  assert.equal(red.overall, "red");
  assert.equal(red.scan.status, "ok");
  _resetScanGate();
  const cleanPages = { [`${SITE}/`]: { body: `<script>const x="${OTHER}"</script>` } };
  const clean = await checkApp(`${SITE}/`, opts(cleanPages, async () => ({ identity: { isContract: true }, overall: "green", riskFlags: [] })));
  assert.equal(clean.overall, "unassessed");
  assert.match(clean.overallReason, /No red flags found in the contracts we could see/);
});

test("the scan gate: one scan per domain per cooldown, and a server-wide cap", async () => {
  const { n, match } = site();
  const opts = { fetchText: fixtureSite(basePages()).fetchText, getCode: codeOf(), analyse: analyseStub() };
  await runScan(n, match, APPS, opts);
  await assert.rejects(runScan(n, match, APPS, opts), (e) => e instanceof ScanUnavailable && e.code === "cooldown");
  _resetScanGate();
  const pending = [];
  let free = false;
  const slow = { ...opts, getCode: () => (free ? Promise.resolve("0x60") : new Promise((r) => pending.push(r))) };
  const sites = ["https://a-site.com/", "https://b-site.com/", "https://c-site.com/"].map((u) => site(u));
  const pagesFor = (u) => ({ [u]: { body: `<script>const x="${OTHER}"</script>` } });
  const p1 = runScan(sites[0].n, sites[0].match, APPS, { ...slow, fetchText: fixtureSite(pagesFor("https://a-site.com/")).fetchText });
  const p2 = runScan(sites[1].n, sites[1].match, APPS, { ...slow, fetchText: fixtureSite(pagesFor("https://b-site.com/")).fetchText });
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(runScan(sites[2].n, sites[2].match, APPS, opts), (e) => e.code === "busy");
  free = true;
  for (const r of pending) r("0x60");
  await Promise.all([p1, p2]);
});

test("Next.js chunk paths resolve under /_next/", () => {
  assert.deepEqual(chunkRefs(`"static/chunks/pages/swap-1.js"`, "https://app.example.org/_next/static/chunks/main-1.js", "https://app.example.org"), ["https://app.example.org/_next/static/chunks/pages/swap-1.js"]);
});

test("a known app's badge is its own contracts; other apps' contracts in its code are listed, not counted", async () => {
  const pages = { "https://app.electroswap.io/swap": { body: `<script>const a="${ROUTER}",b="${OTHER}"</script>` } };
  const r = await checkApp("https://app.electroswap.io/swap", {
    core: true,
    scan: true,
    apps: APPS,
    fetchText: fixtureSite(pages).fetchText,
    getCode: codeOf(),
    analyse: async (a) => ({ identity: { isContract: true }, overall: a === OTHER ? "red" : "green", riskFlags: [] }),
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(r.overall, "green");
  const other = r.contracts.find((c) => c.address === OTHER);
  assert.equal(other.overall, "red"); // still shown, still red
  assert.equal(other.foundIn, FOUND_IN_CODE);
  assert.equal(r.contracts.find((c) => c.address === ROUTER).foundInScan, true);
});

test("the cooldown is per host: sibling sites on one domain can be scanned back to back", async () => {
  const opts = (u) => ({ fetchText: fixtureSite({ [u]: { body: `<script>const x="${OTHER}"</script>` } }).fetchText, getCode: codeOf(), analyse: analyseStub() });
  const a = site("https://dashboard.planetzephyros.xyz/");
  const b = site("https://nameservice.planetzephyros.xyz/");
  await runScan(a.n, a.match, APPS, opts("https://dashboard.planetzephyros.xyz/"));
  const scan = await runScan(b.n, b.match, APPS, opts("https://nameservice.planetzephyros.xyz/"));
  assert.equal(scan.status, "ok");
  await assert.rejects(runScan(a.n, a.match, APPS, opts("https://dashboard.planetzephyros.xyz/")), (e) => e.code === "cooldown");
});

test("only listed registry contracts count as an app's own: a scan-found library address never does", async () => {
  // Core Ascension Vault's site code mentions a wallet-library address; the rescan records it as a 'scan' row
  const LIB = "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789"; // ERC-4337 EntryPoint, in every Reown/viem bundle
  const apps = APPS.map((a) => (a.slug === "core-ascension-vault" ? { ...a, contracts: [...a.contracts, { address: LIB, role: null, source: "scan" }] } : a));
  const { n, match } = site("https://some-launchpad.example.com/");
  const pages = { "https://some-launchpad.example.com/": { body: `<script>const ep="${LIB}"</script>` } };
  const scan = await scanSite(n, match, apps, { fetchText: fixtureSite(pages).fetchText, getCode: codeOf(), analyse: analyseStub() });
  assert.deepEqual(scan.flags.filter((f) => f.id === "uses_known_app_contracts"), []);
  const row = scan.contracts.find((c) => c.address === LIB);
  assert.equal(row.label, null);
  assert.deepEqual(row.apps, []);
});

test("a registry app can scan one page only: its own source, none of the script files it loads", async () => {
  const PAGE = "https://rarible.com/electroneum";
  const pages = {
    [PAGE]: { body: `<html><script src="/assets/bundle.js"></script><script>const etn="${ROUTER}"</script></html>` },
    "https://rarible.com/assets/bundle.js": { body: `const other="${OTHER}"` },
    "https://rarible.com/": { body: `<html>home</html>` },
  };
  const { fetchText, fetched } = fixtureSite(pages);
  const apps = APPS.map((a) => (a.slug === "electroswap" ? a : a));
  const rarible = { id: 77, slug: "rarible", name: "Rarible", category: "nft-marketplace", source: "seed", hosts: [{ host: "rarible.com", registrableDomain: true, primary: true }], contracts: [], scanUrl: PAGE, scanScripts: false };
  const r = await checkApp("https://rarible.com/", {
    core: true,
    scan: true,
    apps: [...apps, rarible],
    fetchText,
    getCode: codeOf(),
    analyse: analyseStub(),
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(fetched, [PAGE]); // the Electroneum page only — not the home page, not the bundle
  assert.equal(r.scan.pageOnly, true);
  assert.equal(r.scan.url, PAGE);
  assert.deepEqual(r.contracts.map((c) => c.address), [ROUTER]);
});

test("the page to scan must be on the app's own websites", async () => {
  const { validateAppInput } = await import("../services/appCheck/registryAdmin.js");
  const base = { name: "Rarible", hosts: [{ host: "rarible.com", registrableDomain: true }] };
  assert.equal(validateAppInput({ ...base, scanUrl: "rarible.com/electroneum", scanScripts: false }).app.scanUrl, "https://rarible.com/electroneum");
  assert.equal(validateAppInput({ ...base, scanUrl: "https://og.rarible.com/x" }).ok, true); // a subdomain of a "+ subdomains" host
  assert.match(validateAppInput({ ...base, scanUrl: "https://evil.com/rarible" }).errors.join(), /must be on one of this app's websites/);
  assert.match(validateAppInput({ ...base, scanUrl: "https://rarible.com:8443/x" }).errors.join(), /must be on one of this app's websites/);
});
