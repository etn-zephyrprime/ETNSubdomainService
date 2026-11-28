CREATE TABLE IF NOT EXISTS tap_hunt_finds (
  user_id BIGINT NOT NULL,
  word_index SMALLINT NOT NULL,
  found_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, word_index)
);
