-- Argus "App Check" (services/appCheck/): which websites belong to which app, and which contracts each app
-- uses. Seeded from backend/seed/known_apps.json by scripts/seedKnownApps.js.
--
--   known_apps          — one row per app. verified_by_us = our own app. Being listed gives a "Known app"
--                         status only; it never hides or lowers a risk flag on any contract.
--   known_app_hosts     — the app's websites. is_registrable_domain = the entry covers every subdomain of
--                         that registrable domain; otherwise it's an exact host and covers only itself.
--                         Shared hosting platforms (vercel.app, github.io, …) are always exact hosts
--                         (enforced by the seed script, since the public-suffix list lives in code).
--   known_app_contracts — the contracts an app uses. source 'registry' = listed by us; 'scan' = found in the
--                         app's own site code (App Check phase 3). Kept open for a later 'manifest' source.
--                         status 'removed' instead of deleting, so history stays.
--
-- RLS on, no policies, same as every other public table (023): the backend connects as the owner and
-- bypasses it; anon/client access gets nothing.
CREATE TABLE IF NOT EXISTS known_apps (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  verified_by_us BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS known_app_hosts (
  app_id BIGINT NOT NULL REFERENCES known_apps(id) ON DELETE CASCADE,
  host TEXT NOT NULL CHECK (host = lower(host)),
  is_registrable_domain BOOLEAN NOT NULL DEFAULT false,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, host)
);
CREATE INDEX IF NOT EXISTS known_app_hosts_host_idx ON known_app_hosts (host);

CREATE TABLE IF NOT EXISTS known_app_contracts (
  app_id BIGINT NOT NULL REFERENCES known_apps(id) ON DELETE CASCADE,
  address TEXT NOT NULL CHECK (address = lower(address)),
  role TEXT,
  source TEXT NOT NULL DEFAULT 'registry' CHECK (source IN ('registry', 'scan', 'manifest')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, address, source)
);
CREATE INDEX IF NOT EXISTS known_app_contracts_address_idx ON known_app_contracts (address);

ALTER TABLE known_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE known_app_hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE known_app_contracts ENABLE ROW LEVEL SECURITY;
