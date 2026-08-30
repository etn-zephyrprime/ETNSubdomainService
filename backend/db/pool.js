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
  return pool.query(text, params);
}
