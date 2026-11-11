-- Argus "App Check" phase 3: the result cache, stored scans, change events and follows
-- (services/appCheck/appCheckService.js, changeEvents.js, utils/appRescanScheduler.js).
--
--   app_check_cache   — the latest Core result per normalised origin. TTL 6h for registry apps, 24h for
--                       others (appCheck.config.js CACHE). meta = what cheap revalidation needs (registry
--                       hash, the scan's HTML hash / ETag / Last-Modified / script URLs, last frontend check).
--   app_scans         — every scan, ok / partial / failed. Only `ok` scans are baselines: a partial or failed
--                       scan never produces change events and never replaces the previous good baseline.
--   app_change_events — contract_added / contract_removed (missing from two consecutive ok scans) /
--                       contract_changed / frontend_redeployed (info, never alerted) / domain_changed.
--   app_follows       — Core members watching an app (by origin, and by app when it's a registry app).
--
-- RLS on, no policies, same as every other public table (023).
CREATE TABLE IF NOT EXISTS app_check_cache (
  origin TEXT PRIMARY KEY CHECK (origin = lower(origin)),
  result JSONB NOT NULL,
  fingerprint TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS app_scans (
  id BIGSERIAL PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin = lower(origin)),
  app_id BIGINT REFERENCES known_apps(id) ON DELETE SET NULL,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
  html_hash TEXT,
  etag TEXT,
  last_modified TEXT,
  script_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  script_hashes JSONB NOT NULL DEFAULT '{}'::jsonb,
  addresses JSONB NOT NULL DEFAULT '{}'::jsonb,
  contracts JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT
);
CREATE INDEX IF NOT EXISTS app_scans_origin_idx ON app_scans (origin, scanned_at DESC);

CREATE TABLE IF NOT EXISTS app_change_events (
  id BIGSERIAL PRIMARY KEY,
  origin TEXT NOT NULL,
  app_id BIGINT REFERENCES known_apps(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('contract_added', 'contract_removed', 'contract_changed', 'frontend_redeployed', 'domain_changed')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'caution', 'high')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_change_events_origin_idx ON app_change_events (origin, id DESC);
CREATE INDEX IF NOT EXISTS app_change_events_app_idx ON app_change_events (app_id, id DESC);

CREATE TABLE IF NOT EXISTS app_follows (
  wallet TEXT NOT NULL CHECK (wallet = lower(wallet)),
  origin TEXT NOT NULL CHECK (origin = lower(origin)),
  app_id BIGINT REFERENCES known_apps(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, origin)
);
CREATE INDEX IF NOT EXISTS app_follows_origin_idx ON app_follows (origin);

ALTER TABLE app_check_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_change_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_follows ENABLE ROW LEVEL SECURITY;
