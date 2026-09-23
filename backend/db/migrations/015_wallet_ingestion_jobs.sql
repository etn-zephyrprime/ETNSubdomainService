-- Per-wallet ingestion JOB progress — distinct from wallet_ingestion_state (001/006), which tracks
-- how far a wallet has been DURABLY ingested (its resumable cursor). This table exists purely so a
-- live in-progress ingest run can report real progress to a polling frontend (see
-- backend/services/pnlIngestion.js's own header comment on "reading block X of Y" — the frontend
-- needed real backend state to show that honestly instead of it being invented client-side).
--
-- Keyed the same way wallet_ingestion_state is (tracked_wallet alone, no owner_wallet column):
-- ingestion itself is a global-per-address operation, shared across every Core tier member who
-- happens to track the same address (see pnlIngestion.js's own inFlightIngestions comment), so its
-- progress is too — one member's reconnect kicking off a scan benefits every other member tracking
-- that same wallet, rather than each starting (and displaying progress for) their own redundant run.
--
-- One row per wallet, overwritten on every new run (status reset to RUNNING, progress reset to its
-- own starting point) rather than a history table — nothing here needs to be looked back on once a
-- run finishes.
--
-- progress_current/progress_total are both REAL, ABSOLUTE BLOCK NUMBERS — literally "reading block
-- X of Y", not a percentage or an item count. progress_total is the chain's own block height
-- snapshotted once when the run starts (Y — see pnlIngestion.js's doIngestWalletHistory, which never
-- changes it mid-run so the denominator stays stable while progress_current climbs). progress_current
-- starts at the OLDER of the wallet's two resume cursors (last_ingested_block/last_ingested_defi_block
-- in wallet_ingestion_state) and is a weighted blend across the run's several concurrent sub-scans
-- once real progress starts arriving — see that same function's own header comment for exactly how
-- it's derived and why a single literal "current window" isn't well-defined across them.
CREATE TABLE IF NOT EXISTS wallet_ingestion_jobs (
  tracked_wallet TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETE', 'FAILED')),
  stage TEXT,
  progress_current BIGINT NOT NULL DEFAULT 0,
  progress_total BIGINT NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
