-- Make every public view run with the QUERYING user's permissions (Supabase advisor:
-- security_definer_view).
--
-- Why: a Postgres view runs with its owner's permissions by default. Every view here is owned by the
-- same role that owns the tables (the backend's), and an owner bypasses Row Level Security — so after
-- 023_enable_rls_on_public_tables.sql locked the tables away from Supabase's Data API, a view like
-- ingested_transfers_with_cex was still a way to read ingested_transfers through that API.
-- security_invoker = true closes it: the API's anon/authenticated roles hit the tables' RLS, with no
-- policies, so they get nothing. The backend and the Supabase SQL editor run as the owner, so nothing
-- changes for them. (Requires Postgres 15+, which Supabase runs.)
--
-- Only views the migrating role owns are changed; scripts/runMigrations.js re-applies this after
-- every run, so views added later are covered too.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT viewname, viewowner FROM pg_views WHERE schemaname = 'public' LOOP
    IF r.viewowner = current_user THEN
      EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', r.viewname);
    ELSE
      RAISE NOTICE 'security_invoker not set on view public.% (owned by %, not %) — check it by hand', r.viewname, r.viewowner, current_user;
    END IF;
  END LOOP;
END $$;
