import { query } from "./pool.js";

// App Check scans started per Core member per UTC day (migrations/032_app_scan_usage.sql).

/** Scans this wallet started on `day` (YYYY-MM-DD). */
export async function getScanCount(wallet, day) {
  const res = await query(`SELECT count FROM app_scan_usage WHERE wallet = $1 AND day = $2`, [wallet.toLowerCase(), day]);
  return Number(res?.rows?.[0]?.count || 0);
}

/** Counts one scan. */
export async function incrementScanCount(wallet, day) {
  await query(
    `INSERT INTO app_scan_usage (wallet, day, count) VALUES ($1, $2, 1)
     ON CONFLICT (wallet, day) DO UPDATE SET count = app_scan_usage.count + 1`,
    [wallet.toLowerCase(), day]
  );
}
