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
