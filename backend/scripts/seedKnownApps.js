// backend/scripts/seedKnownApps.js
//
// Writes the App Check registry seed (backend/seed/known_apps.json) into known_apps / known_app_hosts /
// known_app_contracts (migrations/031). Safe to re-run: apps are upserted by slug, each app's host list is
// replaced, registry contracts no longer in the seed are marked removed (scan-sourced rows are untouched).
// Registrable-domain entries on shared hosting are refused (they'd cover everyone's sites there).
//
// Usage (from backend/):  node scripts/seedKnownApps.js            dry run (lists what it would write)
//                         node scripts/seedKnownApps.js --apply
import dotenv from "dotenv";
import { seedApps, validateApps } from "../services/appCheck/registry.js";
import { upsertKnownApp } from "../db/knownApps.js";

dotenv.config();
const apply = process.argv.includes("--apply");

const raw = seedApps();
const apps = validateApps(raw);
const dropped = raw.reduce((n, a, i) => n + a.hosts.length - apps[i].hosts.length, 0);
if (dropped) {
  console.error(`\n${dropped} host entr${dropped === 1 ? "y" : "ies"} refused (see above) — fix seed/known_apps.json first.`);
  process.exit(1);
}
for (const app of apps) {
  const hosts = app.hosts.map((h) => `${h.host}${h.registrableDomain ? " (+subdomains)" : ""}${h.primary ? " *" : ""}`).join(", ");
  console.log(`${apply ? "upsert" : "would upsert"}  ${app.slug.padEnd(24)} ${String(app.contracts.length).padStart(2)} contract(s)  ${hosts}`);
  if (apply) await upsertKnownApp(app);
}
console.log(`\n${apps.length} app(s)${apply ? " written" : " — dry run, add --apply to write"}`);
process.exit(0);
