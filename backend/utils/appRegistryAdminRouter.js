// backend/utils/appRegistryAdminRouter.js
//
// The App Check registry, edited from Argus (AdminAppRegistryPanel.jsx) — no seed script or deploy needed
// to add, change or remove an app. The database is the source of truth; seed/known_apps.json is only the
// starting set (scripts/seedKnownApps.js).
//
//   GET    /api/admin/app-registry          every app: hosts, listed contracts, and how many contracts its
//                                           own scans have found
//   POST   /api/admin/app-registry          add or update one app (by slug; a new name makes a new slug)
//   DELETE /api/admin/app-registry/:slug    remove an app
//   POST   /api/admin/app-registry/sync-explorer   pull the block explorer's Apps list now (also runs daily)
//
//   GET    /api/admin/app-registry/access?wallet=0x…   { admin } — only so the panel knows whether to show
//                                           itself; every real request is still signature-checked
//
// Gate: a "Premium Dashboard" wallet signature, and the wallet must be a registry admin: APP_REGISTRY_ADMINS
// (comma-separated addresses) if set, otherwise the Argus admin wallet plus planetzephyros.etn (0x3Fd2…5099)
// and mav-browney.electroswap.etn (0x696A…db2e, resolved and reverse-checked 2026-11-12). Addresses, never
// names: a name can change hands, and its next owner mustn't inherit the right to edit the registry. Every write is validated (services/appCheck/registryAdmin.js) and clears the in-memory
// registry at once; cached App Check results for the app rebuild themselves (the registry is part of
// their cache key), and a host-list change becomes a domain_changed event on the next rescan run.
import express from "express";
import { verifyWalletOwnership } from "./walletAuth.js";
import { listKnownApps, upsertKnownApp, deleteKnownApp } from "../db/knownApps.js";
import { resetRegistryMemo } from "../services/appCheck/registry.js";
import { validateAppInput, hostConflicts, CATEGORIES } from "../services/appCheck/registryAdmin.js";
import { createRateLimiter } from "./rateLimit.js";
import { runExplorerSync } from "./appRescanScheduler.js";

const AUTH_PURPOSE = "Premium Dashboard";
const ADMIN_WALLET = (process.env.ARGUS_ADMIN_WALLET || "0xa48Bc549a329EEd01E491C7CD950857A8ae56E73").toLowerCase();
const DEFAULT_REGISTRY_ADMINS = [
  ADMIN_WALLET,
  "0x3fd2e5b4ac0eff6dfdf2446abddab3f66b425099", // planetzephyros.etn
  "0x696a7b9ea5c86da15d569d99d75ed788cce4db2e", // mav-browney.electroswap.etn
];
export const REGISTRY_ADMINS = new Set(
  (process.env.APP_REGISTRY_ADMINS ? process.env.APP_REGISTRY_ADMINS.split(",") : DEFAULT_REGISTRY_ADMINS).map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a))
);
const writes = createRateLimiter({ max: 60, windowMs: 10 * 60 * 1000 });

const router = express.Router();

/** Signature from a registry admin wallet; sends the error and returns false otherwise. */
function requireAdmin(res, { wallet, signature, timestamp }) {
  try {
    verifyWalletOwnership(wallet, signature, timestamp, AUTH_PURPOSE);
  } catch (err) {
    res.status(401).json({ error: err.message });
    return false;
  }
  if (!REGISTRY_ADMINS.has(String(wallet).toLowerCase())) {
    res.status(403).json({ error: "Registry admin wallet required" });
    return false;
  }
  return true;
}

const view = (apps) =>
  apps
    .map((a) => ({
      slug: a.slug,
      name: a.name,
      category: a.category,
      verifiedByUs: a.verifiedByUs,
      notes: a.notes,
      source: a.source,
      autoRescan: a.autoRescan,
      hosts: a.hosts,
      contracts: a.contracts.filter((c) => c.source === "registry").map((c) => ({ address: c.address, role: c.role })),
      scannedContracts: a.contracts.filter((c) => c.source === "scan").length,
    }))
    .sort((x, y) => x.name.localeCompare(y.name));

router.get("/admin/app-registry/access", (req, res) => {
  res.json({ admin: REGISTRY_ADMINS.has(String(req.query.wallet || "").toLowerCase()) });
});

router.get("/admin/app-registry", async (req, res) => {
  if (!requireAdmin(res, req.query)) return;
  try {
    res.json({ apps: view(await listKnownApps()), categories: CATEGORIES });
  } catch (err) {
    console.error("⚠️  App registry admin: list failed:", err.message);
    res.status(502).json({ error: "Couldn't load the registry" });
  }
});

router.post("/admin/app-registry", express.json({ limit: "32kb" }), async (req, res) => {
  const body = req.body || {};
  if (!requireAdmin(res, body)) return;
  if (!writes("w").ok) return res.status(429).json({ error: "Too many changes — try again in a few minutes" });
  const v = validateAppInput(body.app);
  if (!v.ok) return res.status(400).json({ error: v.errors.join(" ") });
  try {
    const existing = await listKnownApps();
    const conflicts = hostConflicts(v.app, existing);
    if (conflicts.length) return res.status(409).json({ error: conflicts.join(" ") });
    // saving in Argus makes the app the admins' (an explorer app edited here is no longer synced over)
    const previous = existing.find((a) => a.slug === v.app.slug);
    await upsertKnownApp({ ...v.app, source: previous?.source === "seed" ? "seed" : "admin", externalId: previous?.externalId || null });
    resetRegistryMemo();
    console.log(`🗂️  App registry: ${v.app.slug} saved by ${body.wallet.toLowerCase()} (${v.app.hosts.map((h) => h.host).join(", ")}; ${v.app.contracts.length} contract(s))`);
    res.json({ ok: true, slug: v.app.slug, apps: view(await listKnownApps()) });
  } catch (err) {
    console.error("⚠️  App registry admin: save failed:", err.message);
    res.status(502).json({ error: "Couldn't save that app" });
  }
});

// Pull the Electroneum block explorer's Apps list now (it also runs daily on its own).
router.post("/admin/app-registry/sync-explorer", express.json({ limit: "4kb" }), async (req, res) => {
  const body = req.body || {};
  if (!requireAdmin(res, body)) return;
  if (!writes("w").ok) return res.status(429).json({ error: "Too many changes — try again in a few minutes" });
  try {
    const plan = await runExplorerSync();
    res.json({ ok: true, added: plan.add.map((a) => a.name), updated: plan.update.map((a) => a.name), removed: plan.remove, skipped: plan.skipped, apps: view(await listKnownApps()) });
  } catch (err) {
    console.error("⚠️  App registry admin: explorer sync failed:", err.message);
    res.status(502).json({ error: `Couldn't sync from the explorer: ${err.message}` });
  }
});

router.delete("/admin/app-registry/:slug", express.json({ limit: "4kb" }), async (req, res) => {
  const body = req.body || {};
  if (!requireAdmin(res, body)) return;
  if (!writes("w").ok) return res.status(429).json({ error: "Too many changes — try again in a few minutes" });
  try {
    const removed = await deleteKnownApp(String(req.params.slug).toLowerCase());
    resetRegistryMemo();
    if (removed) console.log(`🗂️  App registry: ${req.params.slug} removed by ${body.wallet.toLowerCase()}`);
    res.json({ ok: removed, apps: view(await listKnownApps()) });
  } catch (err) {
    console.error("⚠️  App registry admin: delete failed:", err.message);
    res.status(502).json({ error: "Couldn't remove that app" });
  }
});

export default router;
