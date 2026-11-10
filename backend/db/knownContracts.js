import { query } from "./pool.js";

// The known-contracts registry (migrations/025_contract_check.sql) — labels only, never a risk input.

/** `{ address, label, project, category, verifiedByUs, notes }` for an address, or null. */
export async function getKnownContract(address) {
  const res = await query(
    `SELECT address, label, project, category, verified_by_us, notes FROM known_contracts WHERE address = $1`,
    [address.toLowerCase()]
  );
  const r = res?.rows?.[0];
  return r ? { address: r.address, label: r.label, project: r.project, category: r.category, verifiedByUs: r.verified_by_us, notes: r.notes } : null;
}

/** Insert or update one registry row. */
export async function upsertKnownContract({ address, label, project = null, category, verifiedByUs = false, notes = null }) {
  await query(
    `INSERT INTO known_contracts (address, label, project, category, verified_by_us, notes, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label, project = EXCLUDED.project, category = EXCLUDED.category,
       verified_by_us = EXCLUDED.verified_by_us, notes = EXCLUDED.notes, updated_at = now()`,
    [address.toLowerCase(), label, project, category, verifiedByUs, notes]
  );
}
