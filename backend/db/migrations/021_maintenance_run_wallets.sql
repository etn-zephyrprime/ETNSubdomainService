-- Per-wallet checkpoint for long-running maintenance scripts (resetDefiAffectedWallets.js). Added
-- after the --wetn-legs reset was killed twice mid-run: the Render instance restarts whenever the
-- web server hits its heap limit (exit 134), which kills any shell job running beside it AND wipes
-- its log file, so a re-run had no way to know which wallets were already done -- and the scope
-- query itself can't be recomputed safely, since a wallet cleared but not yet re-ingested no longer
-- has the rows that put it in scope. The target list is therefore stored here up front, and each
-- wallet is marked done as it finishes, so a re-run picks up exactly where the last one died.
CREATE TABLE IF NOT EXISTS maintenance_run_wallets (
  job_key TEXT NOT NULL,
  wallet TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_key, wallet)
);
