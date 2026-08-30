import { query } from "./pool.js";

// Small, manually-maintained list of known exchange hot-wallet addresses — Blockscout has no
// address tagging for these on Electroneum (confirmed live: even the CORE token contract's own
// public_tags/private_tags/watchlist_names are empty). Deliberately separate from a request's own
// self_owned_addresses (per-request user input vs. this global, curated list). Starts empty —
// extend it as real exchange addresses are identified; not a launch blocker (see build brief).

export async function isCexAddress(address) {
  const res = await query("SELECT 1 FROM cex_addresses WHERE address = $1", [address.toLowerCase()]);
  return (res?.rows.length || 0) > 0;
}

export async function listCexAddresses() {
  const res = await query("SELECT * FROM cex_addresses ORDER BY label ASC");
  return res?.rows || [];
}

export async function addCexAddress(address, label, addedBy) {
  await query(
    `INSERT INTO cex_addresses (address, label, added_by) VALUES ($1, $2, $3)
     ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label`,
    [address.toLowerCase(), label, addedBy || null]
  );
}
