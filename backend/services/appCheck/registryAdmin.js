// Validating an App Check registry entry edited from the Argus admin panel (utils/appRegistryAdminRouter.js).
// The same rules the seed script applies, so the database never holds an entry matchApp can't use:
//   - hosts are real public hosts (normaliseInput's describeHost), lower-cased, at least one, one primary;
//   - a "covers subdomains" entry must BE a registrable domain and never a shared hosting platform
//     (an entry on vercel.app would cover everyone's sites there);
//   - contracts are valid addresses, stored lower-case; roles are short plain text.
// Everything here is admin-typed text, but it's still length-capped and rendered escaped everywhere.
import { ethers } from "ethers";
import { describeHost } from "./normaliseInput.js";

const CATEGORIES = ["project", "dashboard", "dex", "nft-marketplace", "marketplace", "staking", "name-service", "chain", "bridge", "infrastructure", "wallet", "game", "dapp"];
export { CATEGORIES };

const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
export const slugify = (name) =>
  clean(name, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/**
 * `{ ok: true, app }` (normalised, ready for upsertKnownApp) or `{ ok: false, errors: [..] }`.
 * Input: { slug?, name, category, verifiedByUs?, notes?, hosts: [{ host, registrableDomain, primary }], contracts: [{ address, role }] }
 */
export function validateAppInput(input) {
  const errors = [];
  const name = clean(input?.name, 80);
  if (!name) errors.push("Name is required.");
  const slug = input?.slug ? slugify(input.slug) : slugify(name);
  if (!slug) errors.push("Name needs at least one letter or number.");
  const category = CATEGORIES.includes(input?.category) ? input.category : "dapp";

  const hosts = [];
  const seen = new Set();
  for (const raw of Array.isArray(input?.hosts) ? input.hosts : []) {
    let host = clean(raw?.host, 253).toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
    if (!host) continue;
    if (host.startsWith("*.")) host = host.slice(2);
    const facts = describeHost(host);
    if (!facts || host.includes(":")) {
      errors.push(`${host} isn't a public website host.`);
      continue;
    }
    if (seen.has(host)) continue;
    seen.add(host);
    const registrableDomain = !!raw?.registrableDomain;
    if (registrableDomain && facts.sharedHosting) {
      errors.push(`${host} is on a shared hosting platform (${facts.sharedHosting}) — it can only cover itself, not subdomains.`);
      continue;
    }
    if (registrableDomain && facts.registrableDomain !== host) {
      errors.push(`${host} can't cover subdomains — only a whole domain like ${facts.registrableDomain} can.`);
      continue;
    }
    hosts.push({ host, registrableDomain, primary: !!raw?.primary });
  }
  if (!hosts.length) errors.push("Add at least one website host.");
  if (hosts.length && !hosts.some((h) => h.primary)) hosts[0].primary = true;
  if (hosts.filter((h) => h.primary).length > 1) {
    const first = hosts.findIndex((h) => h.primary);
    hosts.forEach((h, i) => (h.primary = i === first));
  }

  const contracts = [];
  const seenC = new Set();
  for (const raw of Array.isArray(input?.contracts) ? input.contracts : []) {
    const a = clean(raw?.address, 60);
    if (!a) continue;
    if (!ethers.isAddress(a)) {
      errors.push(`${a} isn't a valid contract address.`);
      continue;
    }
    const address = a.toLowerCase();
    if (seenC.has(address)) continue;
    seenC.add(address);
    contracts.push({ address, role: clean(raw?.role, 60) || null });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, app: { slug, name, category, verifiedByUs: !!input?.verifiedByUs, notes: clean(input?.notes, 500) || null, hosts, contracts, autoRescan: input?.autoRescan !== false } };
}

/** Hosts this entry would take from another app (each host belongs to one app). */
export function hostConflicts(app, existing) {
  const out = [];
  for (const other of existing) {
    if (other.slug === app.slug) continue;
    for (const h of app.hosts) if (other.hosts.some((o) => o.host === h.host)) out.push(`${h.host} is already listed for ${other.name}.`);
  }
  return out;
}
