-- Argus "Contract Check" (services/contractCheck/): deterministic facts about a contract, shared by every
-- user, plus a registry of contracts we know.
--
--   known_contracts — addresses we can label ("Known contract" badge): our own contracts, the official
--                     .etn name service, ElectroSwap's routers/factories and listed tokens. A match only
--                     labels a contract; it never softens or removes a risk flag (riskFlags.js never
--                     reads it). verified_by_us = we've reviewed it ourselves (our own contracts).
--   contract_facts  — the latest ContractFacts per address (analyseContract.js). Re-analysed when the code
--                     hash, the proxy implementation or the owner changes, or after 24h; no history, just
--                     the latest. facts.incomplete marks an analysis that couldn't reach every source
--                     (e.g. Blockscout down) — those are re-tried after an hour instead of 24h.
--
-- RLS on, no policies, same as every other public table (023): the backend connects as the owner and
-- bypasses it; anon/client access gets nothing.
CREATE TABLE IF NOT EXISTS known_contracts (
  address TEXT PRIMARY KEY CHECK (address = lower(address)),
  label TEXT NOT NULL,
  project TEXT,
  category TEXT NOT NULL,
  verified_by_us BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contract_facts (
  address TEXT PRIMARY KEY CHECK (address = lower(address)),
  code_hash TEXT,
  implementation TEXT,
  implementation_code_hash TEXT,
  owner TEXT,
  facts JSONB NOT NULL,
  analysed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE known_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_facts ENABLE ROW LEVEL SECURITY;
