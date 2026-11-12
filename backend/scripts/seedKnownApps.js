// backend/scripts/seedKnownApps.js
//
// The STARTING set of the App Check registry (backend/seed/known_apps.json) -> known_apps / known_app_hosts /
// known_app_contracts (migrations/031). Day to day the registry is edited in Argus (admin wallet: Core Tier ->
// App registry, utils/appRegistryAdminRouter.js) and the database is the source of truth — so by default this
// only ADDS apps that aren't there yet and never touches ones already in the database (edits made in Argus
// are kept). --overwrite resets the seeded apps to the file (host list replaced, registry contracts not in
// the file marked removed). Registrable-domain entries on shared hosting are refused.
//
// Usage (from backend/):  node scripts/seedKnownApps.js                       dry run
//                         node scripts/seedKnownApps.js --apply               add missing apps
//                         node scripts/seedKnownApps.js --apply --overwrite   reset seeded apps to the file
import dotenv from "dotenv";
import { seedApps, validateApps } from "../services/appCheck/registry.js";
import { upsertKnownApp, listKnownApps } from "../db/knownApps.js";

dotenv.config();
const apply = process.argv.includes("--apply");
const overwrite = process.argv.includes("--overwrite");

const raw = seedApps();
const apps = validateApps(raw);
const dropped = raw.reduce((n, a, i) => n + a.hosts.length - apps[i].hosts.length, 0);
if (dropped) {
  console.error(`\n${dropped} host entr${dropped === 1 ? "y" : "ies"} refused (see above) — fix seed/known_apps.json first.`);
  process.exit(1);
}
const inDb = new Set((await listKnownApps().catch(() => [])).map((a) => a.slug));
for (const app of apps) {
  const hosts = app.hosts.map((h) => `${h.host}${h.registrableDomain ? " (+subdomains)" : ""}${h.primary ? " *" : ""}`).join(", ");
  if (inDb.has(app.slug) && !overwrite) {
    console.log(`keep          ${app.slug.padEnd(24)} (already in the database — edit it in Argus, or --overwrite)`);
    continue;
  }
  console.log(`${apply ? "upsert" : "would upsert"}  ${app.slug.padEnd(24)} ${String(app.contracts.length).padStart(2)} contract(s)  ${hosts}`);
  if (apply) await upsertKnownApp(app);
}
console.log(`\n${apps.length} app(s)${apply ? " written" : " — dry run, add --apply to write"}`);
process.exit(0);
