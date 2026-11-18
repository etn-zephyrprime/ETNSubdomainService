import express from "express";
import { ethers } from "ethers";
import { verifyWalletOwnership } from "./walletAuth.js";
import { hasCoreAccess } from "./premiumAccess.js";
import { ARGUS_ADMINS } from "./argusAdmins.js";
import { createRateLimiter } from "./rateLimit.js";
import {
  deleteBubblemapOverride,
  getBubblemap,
  getBubblemapCatalog,
  listBubblemapOverrides,
  upsertBubblemapOverride,
} from "../db/bubblemaps.js";
import { query } from "../db/pool.js";

const AUTH_PURPOSE = "Premium Dashboard";
const OVERRIDE_TYPES = new Set(["hub", "not_hub", "entity", "ignore", "include"]);
const writes = createRateLimiter({ max: 60, windowMs: 10 * 60 * 1000 });
const router = express.Router();

function verifySignature(res, credentials) {
  try {
    verifyWalletOwnership(credentials.wallet, credentials.signature, credentials.timestamp, AUTH_PURPOSE);
    return true;
  } catch (err) {
    res.status(401).json({ error: err.message });
    return false;
  }
}

async function requireCoreAccess(res, credentials) {
  if (!credentials.wallet || !ethers.isAddress(credentials.wallet)) {
    res.status(400).json({ error: "wallet must be a valid address" });
    return false;
  }
  if (!verifySignature(res, credentials)) return false;
  if (!(await hasCoreAccess(credentials.wallet))) {
    res.status(403).json({ error: "Core tier membership required" });
    return false;
  }
  return true;
}

function requireAdmin(res, credentials) {
  if (!credentials.wallet || !ethers.isAddress(credentials.wallet)) {
    res.status(400).json({ error: "wallet must be a valid address" });
    return false;
  }
  if (!verifySignature(res, credentials)) return false;
  if (!ARGUS_ADMINS.has(String(credentials.wallet).toLowerCase())) {
    res.status(403).json({ error: "Argus admin wallet required" });
    return false;
  }
  return true;
}

router.get("/premium/bubblemaps/tokens", async (req, res) => {
  if (!(await requireCoreAccess(res, req.query))) return;
  try {
    res.json({ tokens: await getBubblemapCatalog() });
  } catch (err) {
    console.error("⚠️  Bubblemaps catalog lookup failed:", err.message);
    res.status(502).json({ error: "Couldn't load the Bubblemaps catalog" });
  }
});

router.get("/premium/bubblemaps/:token", async (req, res) => {
  const { wallet, signature, timestamp } = req.query;
  if (!(await requireCoreAccess(res, { wallet, signature, timestamp }))) return;
  if (!ethers.isAddress(req.params.token)) return res.status(400).json({ error: "token must be a valid address" });
  try {
    const map = await getBubblemap(req.params.token);
    if (!map) return res.status(404).json({ error: "This token map is not ready yet" });
    res.json(map);
  } catch (err) {
    console.error(`⚠️  Bubblemaps map lookup failed for ${req.params.token}:`, err.message);
    res.status(502).json({ error: "Couldn't load this token map" });
  }
});

router.get("/admin/bubblemaps/access", (req, res) => {
  res.json({ admin: ARGUS_ADMINS.has(String(req.query.wallet || "").toLowerCase()) });
});

router.get("/admin/bubblemaps/overrides", async (req, res) => {
  if (!requireAdmin(res, req.query)) return;
  try {
    res.json({ overrides: await listBubblemapOverrides() });
  } catch (err) {
    console.error("⚠️  Bubblemaps override list failed:", err.message);
    res.status(502).json({ error: "Couldn't load Bubblemaps overrides" });
  }
});

router.post("/admin/bubblemaps/overrides", express.json({ limit: "4kb" }), async (req, res) => {
  const body = req.body || {};
  if (!requireAdmin(res, body)) return;
  if (!writes("w").ok) return res.status(429).json({ error: "Too many changes — try again in a few minutes" });
  const address = String(body.address || "").toLowerCase();
  const type = String(body.type || "");
  const label = String(body.label || "").trim();
  if (!ethers.isAddress(address)) return res.status(400).json({ error: "address must be a valid wallet or contract address" });
  if (!OVERRIDE_TYPES.has(type)) return res.status(400).json({ error: "Unsupported override type" });
  if (label.length > 80) return res.status(400).json({ error: "label must be 80 characters or fewer" });
  if (type === "entity" && !label) return res.status(400).json({ error: "entity overrides require a label" });
  try {
    const result = await upsertBubblemapOverride({ address, type, label, updatedBy: body.wallet });
    await query("UPDATE bubblemap_tokens SET analysis_dirty = true, updated_at = now()");
    res.json({ override: result?.rows?.[0] || null });
  } catch (err) {
    console.error(`⚠️  Bubblemaps override save failed for ${address}:`, err.message);
    res.status(502).json({ error: "Couldn't save that Bubblemaps override" });
  }
});

router.delete("/admin/bubblemaps/overrides/:address", express.json({ limit: "4kb" }), async (req, res) => {
  const body = req.body || {};
  if (!requireAdmin(res, body)) return;
  if (!writes("w").ok) return res.status(429).json({ error: "Too many changes — try again in a few minutes" });
  if (!ethers.isAddress(req.params.address)) return res.status(400).json({ error: "address must be valid" });
  try {
    const result = await deleteBubblemapOverride(req.params.address);
    await query("UPDATE bubblemap_tokens SET analysis_dirty = true, updated_at = now()");
    res.json({ removed: Boolean(result?.rows?.length) });
  } catch (err) {
    console.error(`⚠️  Bubblemaps override removal failed for ${req.params.address}:`, err.message);
    res.status(502).json({ error: "Couldn't remove that Bubblemaps override" });
  }
});

router.get("/admin/bubblemaps/calibration", async (req, res) => {
  if (!requireAdmin(res, req.query)) return;
  try {
    const [report, status] = await Promise.all([
      query("SELECT state_value FROM bubblemap_worker_state WHERE state_key = 'calibration_report'"),
      query(
        `SELECT COUNT(*)::integer AS total_tokens,
                COUNT(*) FILTER (WHERE holders_refreshed_at IS NOT NULL)::integer AS holders_ready,
                COUNT(*) FILTER (WHERE transfer_backfill_complete)::integer AS transfers_ready,
                COUNT(*) FILTER (WHERE map_json IS NOT NULL)::integer AS maps_ready,
                COUNT(*) FILTER (WHERE analysis_dirty)::integer AS maps_dirty,
                MAX(map_updated_at) AS latest_map_at
         FROM bubblemap_tokens`
      ),
    ]);
    res.json({
      report: report?.rows?.[0]?.state_value || null,
      progress: status?.rows?.[0] || null,
    });
  } catch (err) {
    console.error("⚠️  Bubblemaps calibration lookup failed:", err.message);
    res.status(502).json({ error: "Couldn't load the calibration report" });
  }
});

export default router;
