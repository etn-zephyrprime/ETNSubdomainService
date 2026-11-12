-- App Check registry: where each app came from, and whether the rescan job keeps rescanning it.
--
--   source       'seed'     backend/seed/known_apps.json (scripts/seedKnownApps.js)
--                'admin'    added or edited in Argus (App registry panel) — an admin edit takes the app over
--                'explorer' synced daily from the Electroneum block explorer's Apps list
--                           (electroneum/blockscout-metadata dapps/marketplace.json); the sync adds, updates
--                           and removes ONLY these, never seed/admin apps
--   external_id  the explorer list's id for an explorer app (kept when an admin takes it over)
--   auto_rescan  the 6-hourly rescan job scans it (registry apps default on; explorer apps off — many are
--                big third-party sites, scanned on demand instead)
ALTER TABLE known_apps ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('seed', 'admin', 'explorer'));
ALTER TABLE known_apps ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE known_apps ADD COLUMN IF NOT EXISTS auto_rescan BOOLEAN NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS known_apps_external_id_idx ON known_apps (external_id) WHERE external_id IS NOT NULL;
UPDATE known_apps SET source = 'seed'
  WHERE slug IN ('planet-zephyros', 'argus', 'zephyros-name-service', 'core-ascension-vault', 'etn-name-service', 'electroneum', 'electroswap', 'rarible', 'ankr', 'decentroneum', 'thebitcity')
    AND source = 'admin';
