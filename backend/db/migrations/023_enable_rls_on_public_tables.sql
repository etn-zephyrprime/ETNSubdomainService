-- Turn on Row Level Security for every table in the public schema (Supabase advisor:
-- rls_disabled_in_public).
--
-- Why: Supabase serves every public-schema table through its Data API
-- (https://<project>.supabase.co/rest/v1/), and a table without RLS can be read AND written there by
-- anyone holding the project's anon key. This app never uses that API — the backend connects straight
-- to Postgres via DATABASE_URL — so the safe setting is RLS on with NO policies: the API's anon and
-- authenticated roles get nothing, while the backend keeps full access because it connects as the
-- tables' owner, and an owner bypasses RLS (it isn't FORCE'd here).
--
-- Only tables the migrating role owns are changed, so this can never lock the backend out of a table
-- someone else created; any other table is reported as a NOTICE to look at by hand.
-- scripts/runMigrations.js re-applies the same step after every run, so tables added by later
-- migrations are covered automatically.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' LOOP
    IF r.tableowner = current_user THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
    ELSE
      RAISE NOTICE 'RLS not enabled on public.% (owned by %, not %) — check it by hand', r.tablename, r.tableowner, current_user;
    END IF;
  END LOOP;
END $$;
