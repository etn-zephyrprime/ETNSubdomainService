import { query } from "./pool.js";

/** Gas spent per tracked wallet per UTC day, aggregated in SQL so only one small row per
 * wallet/day leaves the database (ingested_transfers can hold thousands of rows per wallet, and
 * Supabase's free plan caps egress). Gas rows are the `gas_fee_wei IS NOT NULL` ones — exactly one
 * per transaction the wallet itself sent (see pnlIngestion.js), failed transactions included, since
 * they still cost gas. `gas_wei` comes back as text: a wei sum overflows a JS number's exact range. */
export async function getDailyGasByWallet(wallets) {
  const lc = wallets.map((w) => w.toLowerCase());
  if (lc.length === 0) return [];
  const res = await query(
    `SELECT tracked_wallet, to_char("timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            SUM(gas_fee_wei)::text AS gas_wei, COUNT(*)::int AS tx_count
     FROM ingested_transfers
     WHERE tracked_wallet = ANY($1) AND gas_fee_wei IS NOT NULL
     GROUP BY 1, 2 ORDER BY 2`,
    [lc]
  );
  return res?.rows || [];
}
