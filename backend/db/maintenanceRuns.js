import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { query } from "./pool.js";

// Per-wallet checkpoint for long-running maintenance scripts — see
// migrations/021_maintenance_run_wallets.sql's own comment for why this exists.

const MIGRATION = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations", "021_maintenance_run_wallets.sql");

// The migration is CREATE TABLE IF NOT EXISTS, so applying it here is a no-op once runMigrations.js
// has run — but means a script using the checkpoint doesn't need a separate migrate step first.
export async function ensureMaintenanceRunTable() {
  await query(readFileSync(MIGRATION, "utf8"));
}

export async function getRunWallets(jobKey) {
  const { rows } = await query(
    "SELECT wallet, status FROM maintenance_run_wallets WHERE job_key = $1 ORDER BY wallet",
    [jobKey]
  );
  return rows;
}

// Replaces any previous run's list for this job with a fresh all-pending one.
export async function startRun(jobKey, wallets) {
  await query("DELETE FROM maintenance_run_wallets WHERE job_key = $1", [jobKey]);
  for (const w of wallets) {
    await query(
      "INSERT INTO maintenance_run_wallets (job_key, wallet, status, updated_at) VALUES ($1, $2, 'pending', now())",
      [jobKey, w]
    );
  }
}

export async function markRunWalletDone(jobKey, wallet) {
  await query(
    "UPDATE maintenance_run_wallets SET status = 'done', updated_at = now() WHERE job_key = $1 AND wallet = $2",
    [jobKey, wallet]
  );
}
