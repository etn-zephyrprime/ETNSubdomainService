// backend/utils/adminMembersRouter.js
//
// Argus admin "Members" tab (AdminMembersPanel.jsx): every Core Tier membership — who, which plan, when it
// ends — straight from premium_memberships (kept current by premiumSubscriptionWatcher.js from the
// PremiumSubscription contract's events; trials from scripts/grantCoreTrial.js are marked "trial:<date>").
//
//   GET /api/admin/members/access?wallet=0x…   { admin } — only so the tab knows whether to show itself
//   GET /api/admin/members?wallet&signature&timestamp   { members, summary }
//
// Gate: a "Premium Dashboard" wallet signature from an admin wallet. MEMBERS_ADMINS (comma-separated
// addresses) if set, otherwise the same set as the App Check registry: the Argus admin wallet,
// planetzephyros.etn (0x3Fd2…5099) and mav-browney.electroswap.etn (0x696A…db2e). Addresses, never names.
import express from "express";
import { verifyWalletOwnership } from "./walletAuth.js";
import { REGISTRY_ADMINS } from "./appRegistryAdminRouter.js";
import { query } from "../db/pool.js";
import { createRateLimiter } from "./rateLimit.js";

const AUTH_PURPOSE = "Premium Dashboard";
const DAY_MS = 24 * 60 * 60 * 1000;
export const EXPIRING_SOON_DAYS = 7;

export const MEMBERS_ADMINS = process.env.MEMBERS_ADMINS
  ? new Set(process.env.MEMBERS_ADMINS.split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))
  : REGISTRY_ADMINS;

const reads = createRateLimiter({ max: 60, windowMs: 10 * 60 * 1000 });
const router = express.Router();

const ms = (d) => (d ? new Date(d).getTime() : null);

/** premium_memberships rows (+ tracked wallet counts) → the tab's view. Pure, for tests. */
export function buildMembersView(rows, now = Date.now()) {
  const members = rows.map((r) => {
    const monthly = ms(r.monthly_expiry);
    const annual = ms(r.annual_expiry);
    const expires = Math.max(monthly ?? 0, annual ?? 0) || null;
    const isTrial = String(r.last_tx_hash || "").startsWith("trial:");
    const plan = isTrial ? "trial" : annual != null && annual === expires ? "annual" : "monthly";
    const active = expires != null && expires > now;
    return {
      wallet: r.wallet_address,
      plan,
      active,
      expiresAt: expires ? new Date(expires).toISOString() : null,
      daysLeft: active ? Math.ceil((expires - now) / DAY_MS) : 0,
      daysSinceExpiry: !active && expires ? Math.floor((now - expires) / DAY_MS) : null,
      lastTxHash: isTrial ? null : r.last_tx_hash || null,
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      trackedWallets: Number(r.tracked_wallets || 0),
    };
  });
  members.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const ea = ms(a.expiresAt) ?? 0;
    const eb = ms(b.expiresAt) ?? 0;
    return a.active ? ea - eb : eb - ea; // active: ending soonest first; expired: most recently lapsed first
  });
  const active = members.filter((m) => m.active);
  return {
    members,
    summary: {
      active: active.length,
      paid: active.filter((m) => m.plan !== "trial").length,
      trials: active.filter((m) => m.plan === "trial").length,
      annual: active.filter((m) => m.plan === "annual").length,
      monthly: active.filter((m) => m.plan === "monthly").length,
      expiringSoon: active.filter((m) => m.daysLeft <= EXPIRING_SOON_DAYS).length,
      expired: members.length - active.length,
    },
  };
}

router.get("/admin/members/access", (req, res) => {
  res.json({ admin: MEMBERS_ADMINS.has(String(req.query.wallet || "").toLowerCase()) });
});

router.get("/admin/members", async (req, res) => {
  const { wallet, signature, timestamp } = req.query;
  try {
    verifyWalletOwnership(wallet, signature, timestamp, AUTH_PURPOSE);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  if (!MEMBERS_ADMINS.has(String(wallet).toLowerCase())) return res.status(403).json({ error: "Admin wallet required" });
  if (!reads(String(wallet).toLowerCase()).ok) return res.status(429).json({ error: "Too many requests, try again shortly" });
  try {
    const result = await query(
      `SELECT m.wallet_address, m.monthly_expiry, m.annual_expiry, m.last_tx_hash, m.updated_at,
              (SELECT count(*) FROM tracked_wallets t WHERE lower(t.owner_wallet) = m.wallet_address AND t.removed_at IS NULL)::int AS tracked_wallets
         FROM premium_memberships m`
    );
    res.json(buildMembersView(result?.rows || []));
  } catch (err) {
    console.error("⚠️  Admin members: list failed:", err.message);
    res.status(502).json({ error: "Couldn't load members" });
  }
});

export default router;
