// The Electroneum block explorer's Apps list (blockexplorer.electroneum.com/apps) as a registry source.
// The explorer reads it from Electroneum's own repo: electroneum/blockscout-metadata, dapps/marketplace.json.
// A daily sync (utils/appRescanScheduler.js) adds those apps to the App Check registry as source 'explorer':
//   - never touches seed or admin apps: an explorer app whose website is already listed is skipped, and an
//     explorer app an admin edits in Argus becomes theirs (source 'admin') and is left alone from then on;
//   - updates explorer apps whose entry changed, and removes explorer apps no longer on the list;
//   - lists websites only (the list has no contract addresses) and doesn't rescan them automatically
//     (auto_rescan off) — many are big third-party sites; they're scanned when someone asks.
// The list is Electroneum's data: titles are length-capped plain text, URLs go through the same host checks
// as everything else (public hosts only; "+ subdomains" only for a site's own whole domain).
import crypto from "crypto";
import { safeFetchText } from "./safeFetch.js";
import { describeHost } from "./normaliseInput.js";
import { knownMatch } from "./matchApp.js";
import { slugify } from "./registryAdmin.js";

export const EXPLORER_APPS_URL = process.env.EXPLORER_APPS_URL || "https://raw.githubusercontent.com/electroneum/blockscout-metadata/refs/heads/main/dapps/marketplace.json";
export const EXPLORER_NOTE = "Listed on the Electroneum block explorer's Apps page (electroneum/blockscout-metadata). Synced daily.";

const CATEGORY = { swaps: "dex", nft: "nft-marketplace", games: "game", wallet: "wallet", "liquid staking": "staking", "data & analytics": "infrastructure", platform: "dapp", bridge: "bridge" };
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);

/** The registry hosts for one explorer app: its url's host exactly; a bare (or www.) domain covers its subdomains. */
export function explorerHosts(app) {
  const out = [];
  for (const [i, raw] of [app.url, app.site].entries()) {
    let host;
    try {
      const u = new URL(String(raw || ""));
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      host = u.hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      continue;
    }
    const bare = host.replace(/^www\./, "");
    const facts = describeHost(bare);
    if (!facts) continue;
    const whole = !facts.sharedHosting && facts.registrableDomain === bare;
    const entry = whole ? { host: bare, registrableDomain: true } : { host, registrableDomain: false };
    if (out.some((h) => h.host === entry.host)) continue;
    out.push({ ...entry, primary: i === 0 && !out.length });
  }
  if (out.length && !out.some((h) => h.primary)) out[0].primary = true;
  return out;
}

/** One explorer list entry as a registry app (or null if it has no usable website). */
export function explorerToApp(x) {
  const id = clean(x?.id, 60).toLowerCase();
  const name = clean(x?.title, 80);
  const hosts = explorerHosts(x || {});
  if (!id || !name || !hosts.length) return null;
  const cats = (x.categories || []).map((c) => String(c).toLowerCase());
  const category = cats.map((c) => CATEGORY[c]).find(Boolean) || "dapp";
  return { externalId: id, slug: slugify(id), name, category, verifiedByUs: false, notes: EXPLORER_NOTE, hosts, contracts: [], source: "explorer", autoRescan: false };
}

const sig = (a) => crypto.createHash("sha256").update(JSON.stringify([a.name, a.category, a.hosts.map((h) => [h.host, h.registrableDomain, h.primary]).sort()])).digest("hex");

/**
 * What a sync would do: { add, update, remove (slugs), skipped: [{ id, reason }] }. Pure.
 * @param list the explorer's JSON array
 * @param registry the current registry (getKnownApps / listKnownApps shape, with source + externalId)
 */
export function planExplorerSync(list, registry) {
  const plan = { add: [], update: [], remove: [], skipped: [] };
  const owned = registry.filter((a) => a.source !== "explorer"); // seed + admin: never touched
  const mine = new Map(registry.filter((a) => a.source === "explorer").map((a) => [a.externalId, a]));
  const takenSlugs = new Set(registry.map((a) => a.slug));
  const seen = new Set();

  for (const x of Array.isArray(list) ? list : []) {
    const app = explorerToApp(x);
    if (!app) {
      plan.skipped.push({ id: x?.id || "?", reason: "no usable website" });
      continue;
    }
    if (seen.has(app.externalId)) continue;
    seen.add(app.externalId);
    // already listed by us (seed/admin), or an admin took this explorer app over
    const takenOver = owned.find((a) => a.externalId === app.externalId);
    if (takenOver) {
      plan.skipped.push({ id: app.externalId, reason: `managed in Argus as ${takenOver.name}` });
      continue;
    }
    const coveredBy = app.hosts.map((h) => knownMatch(describeHost(h.host) || { host: h.host }, owned)?.app).find(Boolean);
    if (coveredBy) {
      plan.skipped.push({ id: app.externalId, reason: `already listed as ${coveredBy.name}` });
      continue;
    }
    const existing = mine.get(app.externalId);
    if (existing) {
      if (sig(existing) !== sig(app)) plan.update.push({ ...app, slug: existing.slug });
      continue;
    }
    let slug = app.slug;
    if (takenSlugs.has(slug)) slug = `${slug}-explorer`;
    takenSlugs.add(slug);
    plan.add.push({ ...app, slug });
  }
  for (const [id, a] of mine) if (!seen.has(id)) plan.remove.push(a.slug);
  return plan;
}

/** The explorer's list (through the App Check fetcher). Throws on failure — a failed fetch changes nothing. */
export async function fetchExplorerApps({ fetchText = safeFetchText } = {}) {
  const r = await fetchText(EXPLORER_APPS_URL, { kind: "json" });
  if (r.status !== 200 || r.body == null) throw new Error(`explorer apps list: HTTP ${r.status}`);
  const list = JSON.parse(r.body);
  if (!Array.isArray(list)) throw new Error("explorer apps list isn't an array");
  return list;
}

/** Fetches the list and applies the plan. Injectable for tests. Returns the plan (with counts) or throws. */
export async function syncExplorerApps({ registry, fetchList = fetchExplorerApps, upsert, remove, onDone = () => {} }) {
  const list = await fetchList();
  if (!list.length) throw new Error("explorer apps list is empty — not removing anything"); // never wipe on a bad answer
  const plan = planExplorerSync(list, registry);
  for (const a of [...plan.add, ...plan.update]) await upsert(a);
  for (const slug of plan.remove) await remove(slug);
  if (plan.add.length || plan.update.length || plan.remove.length) onDone();
  return plan;
}
