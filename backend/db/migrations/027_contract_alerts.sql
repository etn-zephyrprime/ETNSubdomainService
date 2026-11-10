-- Argus "Contract Check" phase 4 — Telegram alerts (utils/contractAlertScheduler.js).
--
--   contract_changes      — every owner / implementation / code-hash change analyseContract sees when a
--                           cached contract is re-checked (the cache-refresh diff), in order. The watchlist
--                           alert reads the ones newer than each member's cursor for tokens they hold.
--   contract_alert_state  — small cursors: per wallet, the newest block whose approvals were checked; per
--                           member, the last contract_changes id they were told about; and who turned the
--                           contract alerts off (/contractalerts off).
--
-- RLS on, no policies, as for every other public table (023).
CREATE TABLE IF NOT EXISTS contract_changes (
  id BIGSERIAL PRIMARY KEY,
  address TEXT NOT NULL CHECK (address = lower(address)),
  changes JSONB NOT NULL, -- [{ field: 'owner' | 'implementation' | 'codeHash', from, to }]
  label TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_changes_address_idx ON contract_changes (address);

CREATE TABLE IF NOT EXISTS contract_alert_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE contract_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_alert_state ENABLE ROW LEVEL SECURITY;
