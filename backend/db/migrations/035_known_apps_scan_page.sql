-- App Check registry: which page of an app's site to scan, and whether to fetch its scripts too.
--
--   scan_url      the page the scan starts from when someone checks (or the rescan job scans) the app's
--                 site root — e.g. an all-chains app's Electroneum page. Must be on one of the app's
--                 hosts (checked when it's saved). NULL = the main site.
--   scan_scripts  false = scan that page's own source only (its HTML and inline scripts), not the script
--                 files it loads. For multi-chain apps whose script bundle is the same for every chain.
ALTER TABLE known_apps ADD COLUMN IF NOT EXISTS scan_url TEXT;
ALTER TABLE known_apps ADD COLUMN IF NOT EXISTS scan_scripts BOOLEAN NOT NULL DEFAULT true;

-- Rarible: one site for every chain (its Electroneum page loads the same 80 script files as the home page),
-- so scan just its Electroneum page's source.
UPDATE known_apps SET scan_url = 'https://rarible.com/electroneum', scan_scripts = false WHERE slug = 'rarible';
