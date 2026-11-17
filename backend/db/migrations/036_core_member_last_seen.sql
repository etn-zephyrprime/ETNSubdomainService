ALTER TABLE premium_memberships
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
