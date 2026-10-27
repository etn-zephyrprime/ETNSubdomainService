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

  // Keep every public table behind Row Level Security, including any a migration above just created
  // (same step as 023_enable_rls_on_public_tables.sql — see its header for why RLS with no policies is
  // right here). Idempotent; only touches tables this role owns, and reports the rest.
  const { rows: tables } = await pool.query(
    "SELECT tablename, tableowner, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
  );
  const { rows: [{ current_user: me }] } = await pool.query("SELECT current_user");
  let enabled = 0;
  for (const t of tables) {
    if (t.rowsecurity) continue;
    if (t.tableowner !== me) {
      console.warn(`⚠️  RLS is off on public.${t.tablename} (owned by ${t.tableowner}, not ${me}) — enable it by hand`);
      continue;
    }
    await pool.query(`ALTER TABLE public."${t.tablename.replace(/"/g, '""')}" ENABLE ROW LEVEL SECURITY`);
    console.log(`🔒 RLS enabled on public.${t.tablename}`);
    enabled++;
  }
  console.log(`🔒 Row Level Security: ${tables.length - tables.filter((t) => !t.rowsecurity).length + enabled}/${tables.length} public tables protected`);
  await pool.end();
}

main().catch((err) => {
  console.error("❌ Migration run failed:", err.message);
  process.exitCode = 1;
});
