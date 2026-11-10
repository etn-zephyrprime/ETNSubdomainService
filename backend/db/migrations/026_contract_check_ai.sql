-- Argus "Contract Check" phase 2 — the Claude explanation layer (services/contractCheck/explain.js).
--
--   contract_summaries — the cached plain-English summary per contract, shared by every user. facts_hash
--                        is a hash of the facts it was written from (explain.js summaryFactsHash): a new
--                        hash means re-write it; prompt_version bumps when the prompt changes.
--   contract_qa_usage  — free-text questions per Core member per UTC day (the daily quota).
--   llm_usage_log      — one row per Claude API call (summaries, questions, retries): model, tokens and
--                        whether the answer passed validation, so spend can be watched.
--
-- RLS on, no policies, as for every other public table (023).
CREATE TABLE IF NOT EXISTS contract_summaries (
  address TEXT PRIMARY KEY CHECK (address = lower(address)),
  facts_hash TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  model TEXT,
  source TEXT NOT NULL CHECK (source IN ('claude', 'template')),
  summary JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contract_qa_usage (
  wallet TEXT NOT NULL CHECK (wallet = lower(wallet)),
  day DATE NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet, day)
);

CREATE TABLE IF NOT EXISTS llm_usage_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL CHECK (kind IN ('summary', 'question')),
  model TEXT NOT NULL,
  contract_address TEXT,
  wallet TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  outcome TEXT NOT NULL -- 'ok' | 'invalid' | 'refusal' | 'error'
);
CREATE INDEX IF NOT EXISTS llm_usage_log_created_at_idx ON llm_usage_log (created_at);

ALTER TABLE contract_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_qa_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage_log ENABLE ROW LEVEL SECURITY;
