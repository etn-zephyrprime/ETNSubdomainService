-- What Core Tier members ask Contract Check in their own words — so the most-asked questions can become quick
-- questions (scripts/topQuestions.js, and the monthly admin note). No wallet is stored: only the question, the
-- contract it was about, and whether the facts could answer it.
--
-- RLS on, no policies, as for every other public table (023).
CREATE TABLE IF NOT EXISTS contract_questions (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  contract_address TEXT NOT NULL CHECK (contract_address = lower(contract_address)),
  question TEXT NOT NULL, -- as asked (trimmed, max 500)
  normalized TEXT NOT NULL, -- lower case, punctuation and extra spaces removed: groups identical questions
  themes TEXT[] NOT NULL DEFAULT '{}', -- services/contractCheck/questionThemes.js
  answerable BOOLEAN, -- whether the facts could answer it (Claude's own flag)
  source TEXT -- 'claude' | 'template'
);
CREATE INDEX IF NOT EXISTS contract_questions_created_at_idx ON contract_questions (created_at);

ALTER TABLE contract_questions ENABLE ROW LEVEL SECURITY;
