// The App Check registry in memory: known_apps + hosts + contracts (db/knownApps.js), refreshed every
// REGISTRY_MEMO_MS. Falls back to the seed file (backend/seed/known_apps.json) when the database isn't
// configured or can't be reached (a local CLI run), the same way knownContracts.js does.
//
// Load-time rule: a registrable-domain entry on a shared hosting platform (vercel.app, github.io, …) would
// cover everyone's sites there, so it's dropped (with a warning) — those must be exact hosts.
import { readFileSync } from "fs";
import { listKnownApps } from "../../db/knownApps.js";
import { describeHost } from "./normaliseInput.js";
import { editDistance, skeleton } from "./confusables.js";
import { LIMITS, LOOKALIKE, REGISTRY_MEMO_MS } from "./appCheck.config.js";

const SEED_URL = new URL("../../seed/known_apps.json", import.meta.url);
let memo = null; // { apps, at }
let loading = null;

/** The seed file's apps, in the same shape as listKnownApps(). */
export function seedApps() {
  const { apps } = JSON.parse(readFileSync(SEED_URL, "utf8"));
  return apps.map((a, i) => ({
    id: -(i + 1),
    slug: a.slug,
    name: a.name,
    category: a.category,
    verifiedByUs: !!a.verifiedByUs,
    notes: a.notes || null,
    source: "seed",
    externalId: null,
    autoRescan: true,
    hosts: a.hosts.map((h) => ({ host: h.host.toLowerCase(), registrableDomain: !!h.registrableDomain, primary: !!h.primary })),
    contracts: a.contracts.map((c) => ({ address: c.address.toLowerCase(), role: c.role || null, source: "registry" })),
  }));
}

/** Drops registrable-domain entries that aren't a real registrable domain (or sit on shared hosting). */
export function validateApps(apps, warn = console.warn) {
  return apps.map((app) => ({
    ...app,
    hosts: app.hosts.filter((h) => {
      if (!h.registrableDomain) return true;
      const facts = describeHost(h.host);
      if (!facts || facts.sharedHosting || facts.registrableDomain !== h.host) {
        warn(`⚠️  App Check: ${app.slug}'s host ${h.host} can't be a registrable-domain entry (shared hosting or not a registrable domain) — ignored`);
        return false;
      }
      return true;
    }),
  }));
}

async function load() {
  if (process.env.DATABASE_URL) {
    try {
      const apps = await listKnownApps();
      if (apps.length) return validateApps(apps);
    } catch (err) {
      console.warn("⚠️  App Check: registry unavailable, using the seed file:", err.message);
    }
  }
  return validateApps(seedApps());
}

/** All known apps (memoised). */
export async function getKnownApps() {
  if (memo && Date.now() - memo.at < REGISTRY_MEMO_MS) return memo.apps;
  if (!loading) {
    loading = load()
      .then((apps) => {
        memo = { apps, at: Date.now() };
        return apps;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** Forget the memo (after a seed run, and in tests). */
export function resetRegistryMemo() {
  memo = null;
}

/** An app's primary host (or its first). */
export const primaryHost = (app) => (app.hosts.find((h) => h.primary) || app.hosts[0])?.host || null;

/** Apps whose name or slug matches what someone typed (typo-tolerant), best first. */
export function findAppsByName(query, apps) {
  const q = String(query || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (q.length < 2) return [];
  const scored = [];
  for (const app of apps) {
    const words = [app.slug.replace(/-/g, ""), ...app.name.toLowerCase().split(/[^\p{L}\p{N}]+/u), app.name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")].filter(Boolean);
    let best = Infinity;
    for (const w of words) {
      if (w === q) best = Math.min(best, 0);
      else if (q.length >= 3 && w.startsWith(q)) best = Math.min(best, 0.5);
      else if (q.length >= 4 && w.includes(q)) best = Math.min(best, 0.8);
      else {
        const max = w.length < LOOKALIKE.shortLabelLength ? LOOKALIKE.shortMaxDistance : LOOKALIKE.longMaxDistance;
        const d = Math.min(editDistance(q, w), skeleton(q) === skeleton(w) ? 1 : Infinity);
        if (q.length >= 3 && d <= max) best = Math.min(best, d);
      }
    }
    if (best < Infinity) scored.push({ app, score: best });
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, LIMITS.maxNameMatches)
    .map((s) => s.app);
}
