// matchApp: is a host one of a known app's websites, a lookalike of one, or unknown?
//
//   known     — covered by a known_app_hosts entry. An exact-host entry covers only that host; a
//               registrable-domain entry covers its subdomains. The most specific entry wins. A
//               registrable-domain entry never covers lookalikes: app.electroswap.io.evil.com's registrable
//               domain is evil.com, so electroswap.io doesn't cover it.
//   lookalike — not known, but resembles a known app (reasons below). Always red.
//   unknown   — neither.
//
// Lookalike reasons compare the input's registrable-domain label (and TLD) with every known host's:
//   typo                — Damerau-Levenshtein distance within LOOKALIKE thresholds
//   homoglyph           — same skeleton (0/o, 1/l/i, rn/m, vv/w, Cyrillic/Greek letters, - and _ removed)
//   mixed_script        — a label mixing scripts (Latin + Cyrillic, …) that resembles a known label
//   different_domain_ending / shared_hosting_same_name — the same label on another TLD or hosting platform
//   keyword_stuffing    — the known label plus words like claim/airdrop/official (config keyword list)
//   subdomain_trick     — a known domain or label used as a subdomain of someone else's domain
// All thresholds and word lists: appCheck.config.js.
import { describeHost } from "./normaliseInput.js";
import { editDistance, madeOfWords, skeleton } from "./confusables.js";
import { LOOKALIKE } from "./appCheck.config.js";

const maxDistance = (label) => ([...label].length < LOOKALIKE.shortLabelLength ? LOOKALIKE.shortMaxDistance : LOOKALIKE.longMaxDistance);

/** The covering registry entry for a host: { app, entry } (exact host first), or null. */
export function knownMatch(facts, apps) {
  let byDomain = null;
  for (const app of apps) {
    for (const entry of app.hosts) {
      if (!entry.registrableDomain && entry.host === facts.host) return { app, entry };
      if (entry.registrableDomain && !facts.sharedHosting && entry.host === facts.registrableDomain && !byDomain) byDomain = { app, entry };
    }
  }
  return byDomain;
}

/** What each known host looks like, for lookalike comparison: one target per (app, registrable domain). */
export function lookalikeTargets(apps) {
  const out = new Map();
  for (const app of apps) {
    const extraWords = new Set();
    for (const entry of app.hosts) {
      const f = describeHost(entry.host);
      if (!f) continue;
      for (const w of f.subdomain.split(".").filter(Boolean)) extraWords.add(w);
      const key = `${app.slug}|${f.registrableDomain}`;
      if (!out.has(key)) out.set(key, { app, host: entry.host, registrableDomain: f.registrableDomain, label: f.label, suffix: f.suffix, extraWords });
    }
  }
  return [...out.values()];
}

const REASON_TEXT = {
  typo: (t) => `The name is one or two letters away from ${t.registrableDomain}`,
  homoglyph: (t) => `It uses look-alike characters to imitate ${t.registrableDomain}`,
  mixed_script: (t) => `It mixes alphabets (e.g. Latin and Cyrillic letters) to look like ${t.registrableDomain}`,
  different_domain_ending: (t) => `Same name as ${t.registrableDomain}, but a different domain ending`,
  shared_hosting_same_name: (t) => `Uses the name "${t.label}" on a free hosting platform, which isn't a listed site for ${t.app.name}`,
  keyword_stuffing: (t) => `It's "${t.label}" with extra words added (a common phishing pattern)`,
  subdomain_trick: (t) => `It puts ${t.label.length >= LOOKALIKE.minLabelLength ? t.registrableDomain : t.label} at the front of someone else's domain`,
};

/** The lookalike reason ids for one target. */
export function lookalikeReasons(facts, target) {
  const reasons = new Set();
  const T = target.label;
  const L = facts.label;
  const display = facts.displayLabel || L;
  const sameDomain = facts.registrableDomain === target.registrableDomain;
  if (sameDomain) return [];
  const longEnough = [...T].length >= LOOKALIKE.minLabelLength;
  const skT = skeleton(T);
  const skL = skeleton(display);

  if (L === T) reasons.add(facts.sharedHosting ? "shared_hosting_same_name" : "different_domain_ending");
  if (longEnough && L !== T) {
    const d = editDistance(display, T);
    if (d >= 1 && d <= maxDistance(T) && !facts.punycode && [...T].length >= (LOOKALIKE.minTypoLabelLength ?? 0)) reasons.add("typo");
    if (skL === skT) reasons.add("homoglyph");
    if (facts.mixedScript && (skL === skT || editDistance(skL, skT) <= maxDistance(T))) reasons.add("mixed_script");
    if (facts.punycode && !reasons.has("homoglyph") && editDistance(skL, skT) <= maxDistance(T)) reasons.add("homoglyph");

    // keyword stuffing: the known label (or its skeleton) plus only listed words
    const words = [...LOOKALIKE.keywords, ...target.extraWords].map(skeleton);
    if (skL !== skT && skL.includes(skT)) {
      const i = skL.indexOf(skT);
      const rest = skL.slice(0, i) + skL.slice(i + skT.length);
      if (madeOfWords(rest, words)) reasons.add("keyword_stuffing");
    }
  }

  // subdomain trick: electroswap.io.evil.com, electroswap.evil.com, app-electroswap.evil.com
  if (facts.subdomain) {
    const sub = facts.subdomain.toLowerCase();
    const subLabels = sub.split(".");
    if (`.${sub}.`.includes(`.${target.registrableDomain}.`) || (longEnough && subLabels.some((l) => skeleton(l) === skT || l.split("-").some((p) => skeleton(p) === skT)))) {
      reasons.add("subdomain_trick");
    }
  }
  return [...reasons];
}

/**
 * `{ status: "known", app, matchedHost }` | `{ status: "lookalike", app, resembles, reasonIds, reasons }` |
 * `{ status: "unknown" }` for a host described by normaliseInput/describeHost.
 */
export function matchApp(facts, apps) {
  const known = knownMatch(facts, apps);
  if (known) return { status: "known", app: known.app, matchedHost: known.entry.host };

  let best = null;
  for (const target of lookalikeTargets(apps)) {
    const ids = lookalikeReasons(facts, target);
    if (!ids.length) continue;
    // ties go to the app that owns the whole registrable domain (electroneum.com over ens.electroneum.com)
    const score = ids.length + (target.host === target.registrableDomain ? 0.5 : 0);
    if (!best || score > best.score) best = { target, ids, score };
  }
  if (!best) return { status: "unknown" };
  return {
    status: "lookalike",
    app: best.target.app,
    resembles: best.target.host,
    reasonIds: best.ids,
    reasons: best.ids.map((id) => REASON_TEXT[id](best.target)),
  };
}
