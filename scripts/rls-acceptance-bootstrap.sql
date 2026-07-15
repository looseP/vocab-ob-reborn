-- Test-only RLS acceptance principal.
-- This role is deliberately distinct from application/worker/backup/migration roles.
-- It must stay a non-owner NOSUPERUSER NOBYPASSRLS login so policies based on
-- auth.uid() are exercised by a real restricted database session.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('vocab-observatory:rls-acceptance-bootstrap'));

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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vocab_rls_acceptance') THEN
    CREATE ROLE vocab_rls_acceptance
      LOGIN
      PASSWORD 'vocab_rls_acceptance_local_only'
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  ELSE
    ALTER ROLE vocab_rls_acceptance
      LOGIN
      PASSWORD 'vocab_rls_acceptance_local_only'
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  END IF;
END
$$;

-- A reused local acceptance database may have historical role memberships.
-- NOINHERIT blocks implicit privileges, but explicit SET ROLE would remain;
-- remove every membership so the acceptance identity has no alternate role.
DO $$
DECLARE
  granted_role record;
BEGIN
  FOR granted_role IN
    SELECT parent.rolname
    FROM pg_auth_members AS membership
    JOIN pg_roles AS parent ON parent.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE member.rolname = 'vocab_rls_acceptance'
  LOOP
    EXECUTE format('REVOKE %I FROM vocab_rls_acceptance', granted_role.rolname);
  END LOOP;
END
$$;

-- Remove grants from older bootstrap revisions before applying the minimum
-- capabilities required by the RLS probe table.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM vocab_rls_acceptance;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM vocab_rls_acceptance;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA auth FROM vocab_rls_acceptance;

GRANT USAGE ON SCHEMA public, auth TO vocab_rls_acceptance;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.daily_forecast_snapshots
  TO vocab_rls_acceptance;
GRANT EXECUTE ON FUNCTION auth.uid() TO vocab_rls_acceptance;

COMMIT;
