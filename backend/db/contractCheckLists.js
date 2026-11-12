import { query } from "./pool.js";

// Lean reads for Contract Check's list views (Supabase egress: one aggregated row per contract, and
// only the few fact fields a list row shows — never the full facts JSONB).

/**
 * Every contract-ish address the given wallets have touched, newest first: tokens they've held/moved,
 * transfer counterparties, DeFi contracts (farms/staking) and swap pools.
 * Returns `[{ address, lastAt, kinds: ["token"|"counterparty"|"defi"|"pool"] }]`.
 */
export async function getTouchedAddresses(wallets, limit = 200) {
  const ws = wallets.map((w) => w.toLowerCase());
  const res = await query(
    `SELECT addr AS address, MAX(ts) AS last_at, array_agg(DISTINCT kind) AS kinds FROM (
       SELECT lower(token_address) AS addr, "timestamp" AS ts, 'token' AS kind FROM ingested_transfers WHERE tracked_wallet = ANY($1) AND token_address IS NOT NULL
       UNION ALL SELECT lower(counterparty_address), "timestamp", 'counterparty' FROM ingested_transfers WHERE tracked_wallet = ANY($1) AND NOT is_self_transfer AND NOT is_cex
       UNION ALL SELECT lower(contract_address), "timestamp", 'defi' FROM defi_activity WHERE tracked_wallet = ANY($1)
       UNION ALL SELECT lower(pool_address), "timestamp", 'pool' FROM swap_trades WHERE tracked_wallet = ANY($1)
     ) x WHERE addr IS NOT NULL AND NOT (addr = ANY($1))
     GROUP BY addr ORDER BY MAX(ts) DESC LIMIT $2`,
    [ws, limit]
  );
  return (res?.rows || []).map((r) => ({ address: r.address, lastAt: r.last_at, kinds: r.kinds }));
}

/**
 * The latest transaction the wallets SENT to each of these contracts that moved nothing — no token or ETN
 * transfer in it, only its gas (the shape of an approve / revoke): `{ [address]: { txHash, at } }`. Every sent
 * transaction has a gas row (log_index -1, direction out, amount 0) whose counterparty is the contract called.
 */
export async function getLatestSentTx(wallets, addresses) {
  if (!wallets.length || !addresses.length) return {};
  const res = await query(
    `SELECT DISTINCT ON (lower(g.counterparty_address)) lower(g.counterparty_address) AS address, g.tx_hash, g."timestamp"
     FROM ingested_transfers g
     WHERE g.tracked_wallet = ANY($1) AND g.log_index = -1 AND g.direction = 'out' AND g.gas_fee_wei IS NOT NULL AND g.amount_raw = 0
       AND lower(g.counterparty_address) = ANY($2)
       AND NOT EXISTS (
         SELECT 1 FROM ingested_transfers t
         WHERE t.tracked_wallet = g.tracked_wallet AND t.tx_hash = g.tx_hash AND (t.log_index <> -1 OR t.amount_raw <> 0)
       )
     ORDER BY lower(g.counterparty_address), g."timestamp" DESC`,
    [wallets.map((w) => w.toLowerCase()), addresses.map((a) => a.toLowerCase())]
  );
  return Object.fromEntries((res?.rows || []).map((r) => [r.address, { txHash: r.tx_hash, at: r.timestamp }]));
}

/** For list rows: `{ [address]: { overall, name, symbol, analysedAt } }` from cached facts (no JSONB body). */
export async function getFactsSummaries(addresses) {
  if (!addresses.length) return {};
  const res = await query(
    `SELECT address, facts->>'overall' AS overall, facts->'identity'->>'contractName' AS name, facts->'token'->>'symbol' AS symbol, (facts->>'schemaVersion')::int AS schema_version, analysed_at
     FROM contract_facts WHERE address = ANY($1)`,
    [addresses.map((a) => a.toLowerCase())]
  );
  return Object.fromEntries((res?.rows || []).map((r) => [r.address, { overall: r.overall, name: r.name, symbol: r.symbol, schemaVersion: r.schema_version, analysedAt: r.analysed_at }]));
}

/** Registry labels for many addresses at once: `{ [address]: { label, project, category, verifiedByUs } }`. */
export async function getKnownContracts(addresses) {
  if (!addresses.length) return {};
  const res = await query(`SELECT address, label, project, category, verified_by_us FROM known_contracts WHERE address = ANY($1)`, [addresses.map((a) => a.toLowerCase())]);
  return Object.fromEntries((res?.rows || []).map((r) => [r.address, { label: r.label, project: r.project, category: r.category, verifiedByUs: r.verified_by_us }]));
}

/** Registry rows whose label or project matches `q` (search suggestions). */
export async function searchKnownContracts(q, limit = 8) {
  const res = await query(
    `SELECT address, label, project, category FROM known_contracts WHERE label ILIKE $1 OR project ILIKE $1 ORDER BY length(label) LIMIT $2`,
    [`%${q.replace(/[%_]/g, "")}%`, limit]
  );
  return res?.rows || [];
}
