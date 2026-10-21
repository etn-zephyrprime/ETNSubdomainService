// backend/scripts/egressReport.js
//
// Read-only: which queries send the most data out of the database (Supabase bills that as egress).
// Uses Postgres's pg_stat_statements (enabled on Supabase by default): per normalized query, how
// many times it ran, how many rows it returned in total, and an estimate of the bytes those rows
// carried (rows x the average row width of the table it reads, from pg_stats).
//
// Usage (from backend/):
//   node scripts/egressReport.js            top 15 since the stats were last reset
//   node scripts/egressReport.js --top=30
//   node scripts/egressReport.js --reset    clear the stats first, so a later run measures a clean window
//
// The report itself is tiny (a few KB), so it barely adds to egress.
import dotenv from "dotenv";
import { getPool } from "../db/pool.js";

dotenv.config();

const args = process.argv.slice(2);
const top = Number((args.find((a) => a.startsWith("--top=")) || "--top=15").split("=")[1]) || 15;
const reset = args.includes("--reset");

const mb = (b) => (b / 1048576).toFixed(1);

async function main() {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL not set.");

  if (reset) {
    await pool.query("SELECT pg_stat_statements_reset()");
    console.log("✅ pg_stat_statements reset — run this again later (without --reset) to see that window.");
    await pool.end();
    return;
  }

  const info = await pool.query("SELECT stats_reset FROM pg_stat_statements_info").catch(() => ({ rows: [] }));
  const since = info.rows[0]?.stats_reset;
  // Average stored row width per table (bytes), to turn row counts into an egress estimate.
  const widths = await pool.query(
    `SELECT tablename, SUM(avg_width)::int AS width FROM pg_stats WHERE schemaname = 'public' GROUP BY tablename`
  );
  const widthOf = new Map(widths.rows.map((r) => [r.tablename, r.width]));

  const res = await pool.query(
    `SELECT query, calls, rows, total_exec_time
     FROM pg_stat_statements
     WHERE query NOT ILIKE '%pg_stat_statements%' AND rows > 0
     ORDER BY rows DESC
     LIMIT 200`
  );

  const rows = res.rows.map((r) => {
    const table = (/from\s+"?([a-z_]+)"?/i.exec(r.query) || [])[1] || "?";
    const width = widthOf.get(table) || 100;
    const bytes = Number(r.rows) * width;
    return { table, calls: Number(r.calls), rows: Number(r.rows), perCall: Number(r.rows) / Math.max(1, Number(r.calls)), bytes, query: r.query.replace(/\s+/g, " ").slice(0, 110) };
  });
  rows.sort((a, b) => b.bytes - a.bytes);
  const totalBytes = rows.reduce((s, r) => s + r.bytes, 0);

  console.log(`\nDatabase egress estimate by query${since ? ` since ${new Date(since).toISOString()}` : ""} (rows x average row width):`);
  console.log(`Total of the top 200 queries: ~${mb(totalBytes)} MB\n`);
  for (const r of rows.slice(0, top)) {
    console.log(`~${mb(r.bytes).padStart(8)} MB  ${String(r.calls).padStart(7)} calls  ${Math.round(r.perCall).toString().padStart(7)} rows/call  [${r.table}]`);
    console.log(`            ${r.query}`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error("❌ Egress report failed:", err.message);
  process.exitCode = 1;
});
