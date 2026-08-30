// Hand-rolled migration runner for the PnL statement feature's Postgres schema — no migration
// framework pulled in (this backend's whole dependency philosophy is minimal; see rpcProvider.js's
// hand-rolled failover instead of a library for the same reason). Applies every
// backend/db/migrations/NNN_*.sql file, in filename order, that isn't already recorded in
// schema_migrations. Safe to re-run — an already-applied migration is skipped, not re-executed.
//
// Run with: node backend/scripts/runMigrations.js
import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
import { getPool } from "../db/pool.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");

async function main() {
  const pool = getPool();
  if (!pool) {
    throw new Error("DATABASE_URL not set — nothing to migrate.");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { rows: applied } = await pool.query("SELECT filename FROM schema_migrations");
  const appliedSet = new Set(applied.map((r) => r.filename));

  let ranAny = false;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`⏭️  ${file} — already applied`);
      continue;
    }

    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`✅ ${file} — applied`);
      ranAny = true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }

  if (!ranAny) console.log("Nothing to do — schema already up to date.");
  await pool.end();
}

main().catch((err) => {
  console.error("❌ Migration run failed:", err.message);
  process.exitCode = 1;
});
