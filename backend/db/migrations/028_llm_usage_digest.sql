-- The daily wallet check (services/walletWatch/walletDigest.js) logs its Claude calls to llm_usage_log as
-- kind 'digest' — widen the kind check (026 allowed only 'summary' and 'question').
ALTER TABLE llm_usage_log DROP CONSTRAINT IF EXISTS llm_usage_log_kind_check;
ALTER TABLE llm_usage_log ADD CONSTRAINT llm_usage_log_kind_check CHECK (kind IN ('summary', 'question', 'digest'));
