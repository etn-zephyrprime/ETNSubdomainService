-- Per-(wallet, topic) checkpoint for doIngestDefiActivity's 6 concurrent whole-chain getLogs scans
-- (pnlIngestion.js). Added after a real, repeated failure mode: one topic's getLogs call exhausting
-- all 3 RPC failover tiers (rpcProvider.js) mid-scan used to discard ALL 6 topics' already-fetched
-- data -- rows were only built/inserted after every topic's Promise.all entry resolved -- and never
-- advance any cursor, so a retry always restarted the ENTIRE multi-hour scan from block zero,
-- confirmed live repeatedly on a wallet whose DeFi re-ingest kept dying within minutes under real
-- RPC rate-limit pressure. Each topic now checkpoints its own contiguous progress (and inserts its
-- own decoded rows into defi_activity) as it goes, independent of its 5 siblings' fate, so a retry
-- only re-scans the blocks that genuinely weren't finished yet.
--
-- scan_from_block pins this row to ONE scan attempt's lower bound (doIngestDefiActivity's own
-- `fromBlock`). A wallet's later real incremental scan (not a retry -- an actual subsequent
-- cold-start-to-now catch-up) has a different, higher fromBlock once last_ingested_defi_block
-- legitimately advances, and a mismatch here means "stale, from an earlier span" rather than
-- "resumable", so callers must ignore a row whose scan_from_block doesn't match the current attempt.
--
-- Any script that clears defi_activity for a wallet MUST also clear this table for that wallet --
-- otherwise a stale "already completed up to block X" row would make a post-reset scan wrongly skip
-- re-fetching blocks whose defi_activity rows were just deleted, silently losing that DeFi history.
CREATE TABLE IF NOT EXISTS defi_scan_topic_progress (
  tracked_wallet TEXT NOT NULL,
  topic_label TEXT NOT NULL,
  scan_from_block BIGINT NOT NULL,
  last_completed_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tracked_wallet, topic_label)
);
