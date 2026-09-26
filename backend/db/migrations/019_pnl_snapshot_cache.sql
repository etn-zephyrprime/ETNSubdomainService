-- Last-computed live PnL snapshot per (tracked wallet, self-owned set), so the Core Tier PnL tab can
-- return real figures immediately on load instead of waiting out a full FIFO replay + live pricing
-- (a couple of minutes on a cold backend, since pnlSnapshotService.js's own cache is in-memory only
-- and empties on every deploy/restart).
--
-- Keyed exactly like that in-memory cache (pnlSnapshotService.js's snapshotCacheKey: tracked wallet +
-- the sorted self-owned addresses) — the same address tracked by two members with different other
-- wallets classifies transfers differently (self-transfers aren't disposals), so their snapshots differ
-- and must not share a row. `payload` is the exact snapshot object the API returns. Overwritten on each
-- fresh computation; never written during a cold-start (priority-scoped) run, same rule as the
-- in-memory cache, since that result is deliberately partial.
CREATE TABLE IF NOT EXISTS pnl_snapshot_cache (
  cache_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
