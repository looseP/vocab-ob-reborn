-- Test-only RLS acceptance principal.
-- This role is deliberately distinct from application/worker/backup/migration roles.
-- It must stay NOBYPASSRLS so policies based on auth.uid() are exercised.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vocab_rls_acceptance') THEN
    CREATE ROLE vocab_rls_acceptance LOGIN PASSWORD 'vocab_rls_acceptance_local_only' NOBYPASSRLS;
  ELSE
    ALTER ROLE vocab_rls_acceptance LOGIN PASSWORD 'vocab_rls_acceptance_local_only' NOBYPASSRLS;
  END IF;
END
$$;

-- Grant only the capabilities needed to execute the already-applied canonical
-- migration schema. RLS policies, rather than privileges, decide row access.
GRANT USAGE ON SCHEMA public, auth TO vocab_rls_acceptance;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vocab_rls_acceptance;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vocab_rls_acceptance;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO vocab_rls_acceptance;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'daily_forecast_snapshots'
      AND relation.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Canonical RLS migration is incomplete: public.daily_forecast_snapshots with RLS is required before bootstrap';
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'Canonical RLS migration is incomplete: auth.uid() is required before bootstrap';
  END IF;
END
$$;
