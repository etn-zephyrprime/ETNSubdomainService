import pg from "pg";

// Single shared Postgres connection pool for the PnL statement feature — the first relational
// database this backend has ever used (everything else is R2 JSON blobs; see backend/state/*.js).
// Introduced specifically because the PnL feature's data (per-wallet transfer history, FIFO
// lots, statement request state) is structured/queryable in a way R2's read-modify-write blob
// pattern doesn't fit well. Same lazy-singleton shape as R2Upload.js's getClient().
//
// DATABASE_URL should be Supabase's *pooled* (pgbouncer, port 6543) connection string, not the
// direct one — this runs as a long-lived Node process, and Supabase's free-tier direct-connection
// cap is small enough that a handful of concurrent queries could exhaust it outright.
let cachedPool = null;

export function getPool() {
  if (cachedPool) return cachedPool;
  if (!process.env.DATABASE_URL) return null;

  cachedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    // Supabase requires SSL and presents a cert not in Node's default trust store for the pooled
    // connection — rejectUnauthorized:false is Supabase's own documented setting for this, not a
    // general "skip verification" shortcut. Override via DATABASE_SSL=false only for a local/
    // non-Supabase Postgres in dev that has no TLS at all.
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  });

  cachedPool.on("error", (err) => {
    // A idle-client error (e.g. Supabase recycling a pooled connection) must not crash the whole
    // process — pg's Pool emits this on the pool itself specifically so it can be handled instead
    // of becoming an unhandled 'error' event, same reasoning as index.js's safeStart() wrapper.
    console.error("⚠️  Postgres pool error (idle client):", err.message);
  });

  return cachedPool;
}

/** Runs a single parameterized query. Returns null (not throw) if DATABASE_URL isn't configured,
 * so every caller's own no-op-when-unconfigured guard stays consistent with the rest of this
 * backend's optional-feature pattern. */
export async function query(text, params) {
  const pool = getPool();
  if (!pool) return null;
  const res = await pool.query(text, params);
  recordQueryUsage(text, res);
  return res;
}

// ---- Egress instrumentation ------------------------------------------------------------------
// Supabase's free plan caps EGRESS (bytes leaving the database), and there's no per-query view of it
// in the dashboard. This tallies, per distinct statement, how many times it ran and roughly how many
// bytes came back, and logs the top few once an hour — so "what is actually using our egress" is
// answerable from the Render logs instead of guessed at. Deliberately cheap: only statements that
// return 20+ rows are sized (a JSON.stringify of a huge result is itself real CPU), and the per-row
// size is sampled from the first 5 rows and extrapolated rather than serializing everything.
// Tallies are per process and reset on restart/deploy.
const queryUsage = new Map(); // normalized statement -> { calls, rows, bytes }
const SIZE_SAMPLE_MIN_ROWS = 20;

function normalizeStatement(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 110);
}

function recordQueryUsage(text, res) {
  try {
    const rows = res?.rows?.length || 0;
    let bytes = 0;
    if (rows > 0) {
      if (rows >= SIZE_SAMPLE_MIN_ROWS) {
        const sample = res.rows.slice(0, 5);
        bytes = Math.round((JSON.stringify(sample).length / sample.length) * rows);
      } else {
        bytes = JSON.stringify(res.rows).length;
      }
    }
    const key = normalizeStatement(text);
    const entry = queryUsage.get(key) || { calls: 0, rows: 0, bytes: 0 };
    entry.calls += 1;
    entry.rows += rows;
    entry.bytes += bytes;
    queryUsage.set(key, entry);
  } catch {
    // instrumentation must never affect a query
  }
}

/** Top statements by estimated bytes returned since this process started. */
export function getQueryUsageReport(limit = 8) {
  return [...queryUsage.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, limit)
    .map(([statement, u]) => ({ statement, calls: u.calls, rows: u.rows, mb: Math.round((u.bytes / 1e6) * 10) / 10 }));
}

const USAGE_LOG_INTERVAL_MS = process.env.DB_USAGE_LOG_INTERVAL_MS ? parseInt(process.env.DB_USAGE_LOG_INTERVAL_MS, 10) : 60 * 60 * 1000;
if (process.env.DATABASE_URL) {
  const timer = setInterval(() => {
    const report = getQueryUsageReport();
    if (report.length === 0) return;
    const totalMb = Math.round([...queryUsage.values()].reduce((s, u) => s + u.bytes, 0) / 1e5) / 10;
    console.log(`📊 DB egress since start: ~${totalMb} MB returned. Top statements:\n` + report.map((r) => `   ${r.mb} MB · ${r.calls} calls · ${r.rows} rows · ${r.statement}`).join("\n"));
  }, USAGE_LOG_INTERVAL_MS);
  timer.unref?.(); // never keep the process alive just for this
}

/** Splits `array` into chunks of at most `size` items each — for any bulk multi-row INSERT built
 * as one big `VALUES ($1,...),($n,...),...` statement (see ingestedTransfers.js/swapTrades.js/
 * defiActivity.js's own insert functions), never build that statement from the FULL row list
 * directly; chunk it with this first and issue one INSERT per chunk.
 *
 * CONFIRMED LIVE this matters, not just a theoretical cap: a wallet with real, extensive history
 * produced ~2095 rows in one insertTransfers call (17 columns each, ~35615 total bound
 * parameters) and Postgres rejected it with "bind message has 35614 parameter formats but 0
 * parameters" — a real node-postgres bug at large parameter counts (confirmed against
 * node-postgres's own issue tracker: bind messages silently corrupt somewhere past ~32768 bound
 * parameters, well under Postgres' own documented 65535 wire-protocol limit — 32768 is exactly
 * the signed 16-bit boundary, consistent with an internal signed/unsigned mismatch in how the
 * library sizes its parameter-format buffer). Each of the three call sites picks its own
 * comfortably-safe per-chunk row count (see their own BATCH_SIZE) — nowhere close to 32768 even
 * at their widest column count, so there's real margin, not a tight fit against the same wall. */
export function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}
