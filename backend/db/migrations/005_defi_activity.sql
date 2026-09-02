-- Raw DeFi (yield farm / staking) activity events for a tracked wallet — deposits, withdrawals,
-- and reward claims. Detected by EVENT TOPIC SIGNATURE across the whole chain (not a hardcoded
-- contract address list) — see pnlIngestion.js's ingestDefiActivity for why: both the "YieldFarm"
-- LP-farm template and the "CoreAscension"-style staking template are reused verbatim across
-- multiple deployed instances (confirmed live: 3 separate YieldFarm contracts and 2 separate
-- staking contracts share byte-for-byte identical event signatures), so any *future* instance of
-- either template is picked up automatically with no code change or manual address list to
-- maintain — the whole point of this table existing.
--
-- raw_args is JSONB (not a wide column set) specifically because the 5 event shapes this covers
-- genuinely differ (farm_deposit/farm_withdraw carry farmId + two-token amounts; core_staked/
-- core_withdrawn/reward_paid carry a single amount) — normalizing them into one fixed column set
-- would mean mostly-null columns per row. Token identity is deliberately NOT resolved/stored here
-- — see pnlStatementGenerator.js's buildDefiFarmEvents, which resolves it live (and caches it) at
-- statement-generation time via standard view function calls on whichever contract address emitted
-- the event, same "resolve once, cache indefinitely" pattern as pnlIngestion.js's own
-- tokenMetadataCache.
CREATE TABLE IF NOT EXISTS defi_activity (
  id BIGSERIAL PRIMARY KEY,
  tracked_wallet TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('farm_deposit', 'farm_withdraw', 'core_staked', 'core_withdrawn', 'reward_paid')),
  farm_id BIGINT, -- only set for farm_deposit/farm_withdraw (LP-farm template) — null for the staking template
  raw_args JSONB NOT NULL, -- decoded event args, string-encoded uint256s (see insertDefiActivity)
  block_number BIGINT NOT NULL,
  "timestamp" TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tracked_wallet, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_defi_activity_wallet_time ON defi_activity (tracked_wallet, "timestamp");
