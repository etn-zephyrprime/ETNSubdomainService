// backend/utils/r2CacheProxyRouter.js
//
// Proxies this backend's own public R2 JSON caches (dashboard stats, owned names, ETN price,
// etc.) to the browser, instead of the browser fetching R2's `pub-*.r2.dev` URL directly.
//
// Found live: Cloudflare's own docs state the r2.dev "Public Development URL" is rate-limited
// and meant for development only, and CORS support is documented specifically in the context of
// *custom domains* — never mentioned for r2.dev. Confirmed live that even a freshly-saved,
// correctly-scoped CORS policy on the bucket never actually applies when requested with a real
// Origin header against the r2.dev URL, while a plain server-to-server GET (no CORS enforcement
// involved) succeeds every time. A real custom domain is Cloudflare's documented fix, but that
// needs either a paid Business/Enterprise plan (Partial/CNAME Setup — free plan doesn't offer
// it) or migrating the domain's nameservers to Cloudflare, neither of which this session can do
// and the second of which was explicitly declined. Proxying server-to-server sidesteps the whole
// problem: this backend already talks to R2 with real credentials for the *write* side of every
// cache in this file's sibling `utils/*Cache.js` modules, and browser CORS was never the R2 SDK's
// concern in the first place — only fetch()-from-a-browser is.
//
// Deliberately an allowlist of known cache filenames, not an arbitrary-path proxy — this backend
// has no reason to ever proxy anything in the bucket outside its own published caches (NFT images
// are served via <img src>, which never needed CORS at all, so those stay a direct R2 read).
import express from "express";

// Same env var R2Upload.js already reads (process.env, not the frontend's import.meta.env —
// this is a plain Node backend module, not a Vite-processed one) — the bucket's public r2.dev
// base URL, e.g. https://pub-xxxx.r2.dev. Read lazily inside the handler below (not at module
// load) so a missing env var surfaces as a normal per-request error rather than crashing the
// whole backend at startup over one optional feature.
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

const ALLOWED_FILES = new Set([
  "dashboard-stats-history.json",
  "activated-domains.json",
  "etn-price.json",
  "marketplace-sellers.json",
  "owned-names.json",
  "subname-domains.json",
  "name-service-stats.json",
]);

// Short in-memory cache — these are the exact same objects R2 itself already serves with
// Cache-Control: max-age=60 (etnPriceState.js, nameServiceStatsState.js) or similar; matching
// that here means this proxy adds essentially no staleness on top of what visitors already got
// from R2 directly, while cutting repeat-visitor R2 reads to once per window instead of once per
// page load.
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // filename -> { expiresAt, status, body }

const router = express.Router();

router.get("/r2/:filename", async (req, res) => {
  const { filename } = req.params;
  if (!ALLOWED_FILES.has(filename)) {
    return res.status(404).json({ error: "Unknown cache file" });
  }
  if (!R2_PUBLIC_URL) {
    return res.status(503).json({ error: "R2 not configured" });
  }

  const cached = cache.get(filename);
  if (cached && cached.expiresAt > Date.now()) {
    return res.status(cached.status).type("application/json").send(cached.body);
  }

  try {
    const upstream = await fetch(`${R2_PUBLIC_URL}/${filename}`);
    const body = await upstream.text();
    // R2 returns a real 404 for a cache that's never been published yet (e.g. a fresh deploy
    // before its first scan cycle completes) — passed through as-is rather than masked as a 502,
    // so callers can tell "never published" apart from "this proxy is broken".
    cache.set(filename, { expiresAt: Date.now() + CACHE_TTL_MS, status: upstream.status, body });
    res.status(upstream.status).type("application/json").send(body);
  } catch (err) {
    console.error(`⚠️  R2 cache proxy: failed to fetch ${filename}:`, err.message);
    res.status(502).json({ error: "Couldn't load cached data" });
  }
});

export default router;
