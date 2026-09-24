import { query } from "./pool.js";

// Persisted "last known" live value of a wallet's open DeFi positions or directly-held liquidity
// positions — see migrations/016_wallet_position_cache.sql's own header comment for the full
// reasoning (this exists so the FIRST reader after a backend restart, or the first Core Tier load
// of the day, doesn't have to pay a from-scratch live computation either — only a genuinely new
// on-chain change does).

/** `kind`: 'defi' | 'lp'. Returns `{ payload, fingerprint, computedAt }` or null if nothing's been
 * computed for this wallet+kind yet. */
export async function getCachedPosition(trackedWallet, kind) {
  const res = await query(
    `SELECT payload, fingerprint, computed_at FROM wallet_position_cache WHERE tracked_wallet = $1 AND kind = $2`,
    [trackedWallet.toLowerCase(), kind]
  );
  const row = res?.rows?.[0];
  if (!row) return null;
  return { payload: row.payload, fingerprint: row.fingerprint, computedAt: row.computed_at };
}

/** Overwrites this wallet+kind's cached row — see this table's own header comment on why there's
 * no history, just the latest value. `fingerprint`'s meaning depends on `kind` (see the migration's
 * own comment); passed through opaquely here. */
export async function upsertCachedPosition(trackedWallet, kind, payload, fingerprint) {
  await query(
    `INSERT INTO wallet_position_cache (tracked_wallet, kind, payload, fingerprint, computed_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tracked_wallet, kind) DO UPDATE SET payload = $3, fingerprint = $4, computed_at = now()`,
    [trackedWallet.toLowerCase(), kind, JSON.stringify(payload), fingerprint]
  );
}
