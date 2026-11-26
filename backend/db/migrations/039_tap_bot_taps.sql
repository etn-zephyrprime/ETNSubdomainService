CREATE TABLE IF NOT EXISTS tap_bot_taps (
  id BIGSERIAL PRIMARY KEY,
  tx_hash TEXT NOT NULL UNIQUE,
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  username TEXT,
  first_name TEXT,
  gas_wei NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tap_bot_taps_user_idx ON tap_bot_taps (user_id);
