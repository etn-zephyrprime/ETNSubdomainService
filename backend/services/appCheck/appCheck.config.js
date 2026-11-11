// Argus "App Check" settings — every tunable in one place (thresholds, keyword lists, rules, TTLs, limits).
// Defaults documented next to each value. Nothing here is site-controlled.

// ── Lookalike detection (matchApp.js) ─────────────────────────────────────────────────────────────────
export const LOOKALIKE = {
  // Damerau-Levenshtein distance from a known app's label that counts as a typo: <= shortMaxDistance for
  // labels under shortLabelLength characters, <= longMaxDistance otherwise. 0 is the same label (TLD swap).
  shortLabelLength: 8,
  shortMaxDistance: 1,
  longMaxDistance: 2,
  // Labels shorter than this are never compared by distance or keywords (too many accidental matches).
  minLabelLength: 4,
  // Words phishing domains bolt onto a real name: electroswap-claim.xyz, claimelectroswap.com, …
  keywords: [
    "claim", "claims", "airdrop", "airdrops", "official", "app", "apps", "dapp", "swap", "swaps", "wallet", "wallets",
    "support", "help", "bonus", "rewards", "reward", "verify", "verification", "validate", "connect", "sync", "login",
    "secure", "security", "portal", "dashboard", "stake", "staking", "bridge", "migrate", "migration", "giveaway",
    "promo", "event", "drop", "mint", "nft", "nfts", "defi", "finance", "io", "web", "online", "site", "live",
    "network", "net", "pro", "fix", "recover", "recovery", "unlock", "free", "gift", "v2", "v3", "new",
  ],
};

// Shared hosting platforms: anyone can get <name>.<platform>. A registry entry on one of these must be an
// exact host, never a registrable domain (validated in knownApps.js). tldts with private domains already
// knows most of them; this list is the guaranteed minimum.
export const SHARED_HOSTING_SUFFIXES = [
  "vercel.app", "github.io", "pages.dev", "netlify.app", "onrender.com", "web.app", "firebaseapp.com",
  "herokuapp.com", "workers.dev", "surge.sh", "gitbook.io", "glitch.me", "replit.app", "repl.co", "fly.dev",
  "azurewebsites.net", "azurestaticapps.net", "cloudfront.net", "amplifyapp.com", "webflow.io", "framer.app",
  "framer.website", "wixsite.com", "weebly.com", "blogspot.com", "ipfs.io", "dweb.link", "4everland.app",
  "fleek.co", "on.fleek.co", "railway.app", "up.railway.app", "deno.dev", "codeberg.page", "gitlab.io",
];

// Tracking parameters stripped from an input URL before anything else sees it.
export const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|yclid|_ga|_gl|ref|ref_src|referrer|s_cid)$/i;

// ── Domain rules (domainSignals.js) — same { severity } shape as Contract Check's RISK_RULES ─────────────
// Domain age alone is never above caution: our own dashboard was flagged by reputation engines purely for
// being new. Freshness is a signal, not a verdict.
export const DOMAIN_RULES = {
  lookalike_domain: { enabled: true, severity: "high" },
  domain_age_under_7_days: { enabled: true, severity: "caution", days: 7 },
  domain_age_under_30_days: { enabled: true, severity: "info", days: 30 },
  not_https: { enabled: true, severity: "caution" },
  idn_host: { enabled: true, severity: "caution", lookalikeSeverity: "high" },
};
export const MAX_DOMAIN_AGE_SEVERITY = "caution"; // enforced in code, whatever DOMAIN_RULES says

// ── RDAP (domain age) ─────────────────────────────────────────────────────────────────────────────────
export const RDAP = {
  bootstrapUrl: "https://data.iana.org/rdap/dns.json",
  bootstrapTtlMs: 24 * 3600 * 1000, // the IANA file: 24h
  domainTtlMs: 7 * 24 * 3600 * 1000, // one domain's registration date: 7 days
  failureTtlMs: 3600 * 1000, // a failed lookup is retried after an hour (shown as "age unknown" meanwhile)
  timeoutMs: 5000,
  maxBytes: 1024 * 1024,
  cacheMax: 5000,
};

// ── Registry ──────────────────────────────────────────────────────────────────────────────────────────
export const REGISTRY_MEMO_MS = 10 * 60 * 1000; // known_apps/hosts/contracts kept in memory (small, read on every check)

// ── Endpoint limits (appCheckRouter.js) ───────────────────────────────────────────────────────────────
export const LIMITS = {
  checksPerIpPer10Min: Number(process.env.APP_CHECK_PER_IP_10MIN) || 30,
  checksPerWalletPer10Min: Number(process.env.APP_CHECK_PER_WALLET_10MIN) || 60,
  maxInputLength: 2048,
  maxNameMatches: 5,
};

// ── The fetcher (safeFetch.js) — the only code that requests user-supplied hosts ─────────────────────────
export const FETCH = {
  userAgent: "ArgusAppCheck/1.0 (+https://dashboard.planetzephyros.xyz/about)",
  connectTimeoutMs: 5000,
  totalTimeoutMs: 10000, // per request, redirects included
  maxRedirects: 3,
  maxResponseBytes: (Number(process.env.APP_CHECK_MAX_RESPONSE_MB) || 4) * 1024 * 1024, // per response (decompressed); default 4 MB (the official .etn app's main bundle is 2.7 MB)
  ports: [80, 443],
  // content types a response may have (anything else is aborted before its body is read)
  contentTypes: {
    html: ["text/html", "application/xhtml+xml"],
    script: ["application/javascript", "text/javascript", "application/x-javascript", "application/ecmascript", "text/ecmascript", "text/plain"],
    json: ["application/json", "text/plain"], // and any */*+json (application/rdap+json)
  },
};

// ── The frontend scan (scanSite.js) — Core only ─────────────────────────────────────────────────────────
export const SCAN = {
  maxBytes: 15 * 1024 * 1024, // per scan, all responses together
  maxRequests: Number(process.env.APP_CHECK_MAX_REQUESTS) || 60, // per scan, redirects included (big apps load ~40 scripts)
  maxChunkDepth: 2, // scripts referenced from scripts, at most 2 levels below the page's own scripts
  maxAddressesToCheck: 150, // eth_getCode reads per scan (sequential, small groups); more found -> partial
  codeReadGroupSize: 5,
  maxContracts: 25, // analysed with Contract Check per scan (registry contracts first, then by occurrences). The
  // rest are still listed as contracts (the set stays complete), just not analysed — so this cap alone
  // doesn't make a scan partial; the fetch caps and the address cap do.
  maxConcurrentScans: 2, // across the server
  perDomainCooldownMs: 60 * 1000, // one scan of a registrable domain per minute, whoever asks
  scansPerMemberPerDay: Number(process.env.APP_CHECK_SCANS_PER_DAY) || 10,
  // registry contracts any app may reasonably use; finding them on an unknown site isn't a "uses X's
  // contracts" signal (WETN, CORE)
  crossCheckIgnore: ["0x138dafbda0ccb3d8e39c19edb0510fc31b7c1c77", "0x309b916b3a90cb3e071697ea9680e9217a30066f"],
  // never real contracts: zero, burn and placeholder addresses
  ignoreAddresses: [
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
    "0xdead000000000000000042069420694206942069",
    "0xdead000000000000000000000000000000000000",
    "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", // "native coin" placeholder
    "0xffffffffffffffffffffffffffffffffffffffff",
  ],
};

// a hard-coded plain wallet in an app's code (often a fee recipient) — info, never a warning
export const SCAN_RULES = {
  uses_known_app_contracts: { enabled: true, severity: "caution" },
  hardcoded_wallet: { enabled: true, severity: "info" },
};

// ── Cache, change detection, following (appCheckService.js, changeEvents.js, appRescanScheduler.js) ───────
export const CACHE = {
  knownAppTtlMs: 6 * 3600 * 1000, // a registry app's cached result
  otherTtlMs: 24 * 3600 * 1000, // any other site's
  frontendRecheckMs: 3600 * 1000, // a cached scan older than this gets one conditional request for its HTML
  changesShown: 10, // recent change events on a card
};
export const RESCAN = {
  tickMs: 30 * 60 * 1000,
  registryEveryMs: Number(process.env.APP_RESCAN_REGISTRY_HOURS || 6) * 3600 * 1000,
  followedEveryMs: Number(process.env.APP_RESCAN_FOLLOWED_HOURS || 24) * 3600 * 1000,
  retryFailedMs: 3600 * 1000, // after a failed / partial attempt, wait this long before trying again
  claimMs: 30 * 60 * 1000, // a scan claimed by one server isn't started by another for this long
};
export const FOLLOW = {
  maxPerMember: Number(process.env.APP_FOLLOWS_PER_MEMBER) || 20,
};
// alerted to followers (frontend_redeployed never is); contract_added only from this severity up
export const ALERT_TYPES = ["contract_added", "contract_changed", "contract_removed", "domain_changed"];
export const ADDED_ALERT_MIN_SEVERITY = "caution";
