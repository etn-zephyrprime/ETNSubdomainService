-- Argus "App Check" site scans (services/appCheck/scanSite.js): how many each Core member started per UTC
-- day, for the daily limit (APP_CHECK_SCANS_PER_DAY, default 10). In the database, not memory, so a deploy
-- doesn't reset it. Only the count — not which sites.
--
-- RLS on, no policies, same as every other public table (023).
CREATE TABLE IF NOT EXISTS app_scan_usage (
  wallet TEXT NOT NULL CHECK (wallet = lower(wallet)),
  day DATE NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet, day)
);

ALTER TABLE app_scan_usage ENABLE ROW LEVEL SECURITY;
