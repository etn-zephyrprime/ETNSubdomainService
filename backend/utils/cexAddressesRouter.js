// backend/utils/cexAddressesRouter.js
//
// Public, read-only endpoint exposing this backend's manually-maintained cex_addresses table
// (see db/cexAddresses.js's own header comment: Blockscout has no address tagging on Electroneum
// at all, so this app maintains its own known exchange/bridge counterparty list) to the free
// Argus dashboard — so Overview.jsx can tag a known CEX/bridge address the same way it already
// tags a known Electroneum team wallet (src/dashboard/utils/teamWallets.js). This table was
// previously only ever read server-side, by the Premium PnL feature (pnlIngestion.js/
// pnlStatementGenerator.js) — never exposed to any frontend before now.
//
// Short in-memory cache since this is a small, rarely-changing table that a busy Overview tab
// could otherwise re-query on every page load — same reasoning as r2CacheProxyRouter.js's own
// cache, just in front of a Postgres table instead of an R2 object.
import express from "express";
import { listCexAddresses } from "../db/cexAddresses.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached = null; // { expiresAt, addresses }

const router = express.Router();

router.get("/cex-addresses", async (req, res) => {
  try {
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ addresses: cached.addresses });
    }

    // listCexAddresses() itself degrades to [] if DATABASE_URL isn't configured (see pool.js's
    // query() / cexAddresses.js) — no separate guard needed here.
    const rows = await listCexAddresses();
    const addresses = rows.map((r) => ({ address: r.address, label: r.label }));
    cached = { expiresAt: Date.now() + CACHE_TTL_MS, addresses };
    res.json({ addresses });
  } catch (err) {
    console.error("⚠️  Failed to list CEX addresses:", err.message);
    // A dashboard tag is cosmetic — degrade to empty rather than surface a hard error over it.
    res.json({ addresses: [] });
  }
});

export default router;
