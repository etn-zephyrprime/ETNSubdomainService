-- "Was this right?" on Contract Check cards and the watcher's Telegram alerts. Every verdict is kept with
-- a snapshot of what was judged (the badge and flags, or the alert), so false positives show up early and
-- the rows become labelled examples (scripts/watchFeedback.js summarises them).
--
-- RLS on, no policies, as for every other public table (023).
CREATE TABLE IF NOT EXISTS watch_feedback (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL CHECK (source IN ('telegram', 'dashboard')),
  owner_wallet TEXT CHECK (owner_wallet = lower(owner_wallet)),
  kind TEXT NOT NULL CHECK (kind IN ('approval', 'change', 'digest', 'card')),
  ref TEXT NOT NULL, -- the contract address, contract_changes id, or digest date
  verdict TEXT NOT NULL CHECK (verdict IN ('right', 'wrong')),
  note TEXT,
  snapshot JSONB
);
CREATE INDEX IF NOT EXISTS watch_feedback_created_at_idx ON watch_feedback (created_at);
-- one verdict per person per thing: a second tap replaces the first
CREATE UNIQUE INDEX IF NOT EXISTS watch_feedback_one_per_owner ON watch_feedback (owner_wallet, kind, ref);

ALTER TABLE watch_feedback ENABLE ROW LEVEL SECURITY;
