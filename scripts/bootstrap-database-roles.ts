import { Client } from "pg";

const ROLE_NAMES = {
  app: "vocab_app",
  worker: "vocab_worker",
  backup: "vocab_backup",
  migration: "vocab_migration",
} as const;

type RoleKind = keyof typeof ROLE_NAMES;
type BootstrapPhase = "prepare" | "converge";

interface RoleUrl {
  kind: RoleKind;
  role: string;
  url: URL;
  password: string;
}

function requiredUrl(name: string): URL {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`${name} must use postgresql://`);
  }
  if (!url.hostname || !url.pathname.slice(1)) {
    throw new Error(`${name} must include host and database name`);
  }
  return url;
}

function databaseIdentity(url: URL): string {
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname}`;
}

function bootstrapPhase(): BootstrapPhase {
  const value = process.argv[2] ?? "converge";
  if (value !== "prepare" && value !== "converge") {
    throw new Error("bootstrap phase must be prepare or converge");
  }
  return value;
}

function roleUrl(kind: RoleKind, name: string, expectedDatabase: string): RoleUrl {
  const url = requiredUrl(name);
  const role = ROLE_NAMES[kind];
  if (decodeURIComponent(url.username) !== role) {
    throw new Error(`${name} username must be exactly ${role}`);
  }
  if (databaseIdentity(url) !== expectedDatabase) {
    throw new Error(`${name} must target the same database as DATABASE_ADMIN_URL`);
  }
  const password = decodeURIComponent(url.password);
  if (password.length < 16 || /replace|example|secret/i.test(password)) {
    throw new Error(`${name} must contain a non-placeholder password of at least 16 characters`);
  }
  return { kind, role, url, password };
}

async function roleSql(client: Client, role: RoleUrl): Promise<void> {
  const exists = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [role.role],
  );
  if (!exists.rows[0]?.exists) {
    await client.query(`CREATE ROLE ${role.role}`);
  }
  const attributes = role.kind === "backup"
    ? "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS"
    : "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS";
  const statement = await client.query<{ sql: string }>(
    `SELECT format('ALTER ROLE %I WITH ${attributes} PASSWORD %L', $1, $2) AS sql`,
    [role.role, role.password],
  );
  await client.query(statement.rows[0]!.sql);

  const memberships = await client.query<{ sql: string }>(
    `SELECT format('REVOKE %I FROM %I', parent.rolname, member.rolname) AS sql
     FROM pg_auth_members membership
     JOIN pg_roles member ON member.oid = membership.member
     JOIN pg_roles parent ON parent.oid = membership.roleid
     WHERE member.rolname = $1 OR parent.rolname = $1`,
    [role.role],
  );
  for (const membership of memberships.rows) {
    await client.query(membership.sql);
  }
}

async function assertZeroManagedRoleMemberships(client: Client): Promise<void> {
  const memberships = await client.query<{ member: string; parent: string }>(
    `SELECT member.rolname AS member, parent.rolname AS parent
     FROM pg_auth_members membership
     JOIN pg_roles member ON member.oid = membership.member
     JOIN pg_roles parent ON parent.oid = membership.roleid
     WHERE member.rolname = ANY($1::text[])
        OR parent.rolname = ANY($1::text[])`,
    [Object.values(ROLE_NAMES)],
  );
  if (memberships.rowCount !== 0) {
    throw new Error(`managed roles must have zero incoming and outgoing memberships: ${JSON.stringify(memberships.rows)}`);
  }
}

async function ensureMigrationAuthority(client: Client, databaseName: string): Promise<void> {
  const statement = await client.query<{ sql: string }>(
    `SELECT format(
       'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %I TO vocab_migration; GRANT vocab_migration TO %I',
       $1,
       current_user
     ) AS sql`,
    [databaseName],
  );
  await client.query(statement.rows[0]!.sql);
}

async function transferDatabaseOwnership(client: Client, databaseName: string): Promise<void> {
  const statement = await client.query<{ sql: string }>(
    "SELECT format('ALTER DATABASE %I OWNER TO vocab_migration', $1) AS sql",
    [databaseName],
  );
  await client.query(statement.rows[0]!.sql);
}

async function revokeAdminMigrationMembership(client: Client): Promise<void> {
  const statement = await client.query<{ sql: string }>(
    "SELECT format('REVOKE vocab_migration FROM %I', current_user) AS sql",
  );
  await client.query(statement.rows[0]!.sql);
}

async function ensureApplicationSchemas(client: Client): Promise<void> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION vocab_migration;
    CREATE SCHEMA IF NOT EXISTS vocab_migrations AUTHORIZATION vocab_migration;
    ALTER SCHEMA public OWNER TO vocab_migration;
    ALTER SCHEMA auth OWNER TO vocab_migration;
    ALTER SCHEMA vocab_migrations OWNER TO vocab_migration;
  `);
}

async function transferApplicationOwnership(client: Client): Promise<void> {
  await client.query(`
    DO $$
    DECLARE item record;
    BEGIN
      FOR item IN
        SELECT n.nspname, c.relname, c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('public', 'auth', 'vocab_migrations')
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend dependency
            WHERE dependency.classid = 'pg_class'::regclass
              AND dependency.objid = c.oid
              AND dependency.deptype = 'e'
          )
      LOOP
        EXECUTE format(
          CASE item.relkind
            WHEN 'S' THEN 'ALTER SEQUENCE %I.%I OWNER TO vocab_migration'
            WHEN 'v' THEN 'ALTER VIEW %I.%I OWNER TO vocab_migration'
            WHEN 'm' THEN 'ALTER MATERIALIZED VIEW %I.%I OWNER TO vocab_migration'
            WHEN 'f' THEN 'ALTER FOREIGN TABLE %I.%I OWNER TO vocab_migration'
            ELSE 'ALTER TABLE %I.%I OWNER TO vocab_migration'
          END,
          item.nspname,
          item.relname
        );
      END LOOP;
    END $$;

    DO $$
    DECLARE item record;
    BEGIN
      FOR item IN
        SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS arguments
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'auth', 'vocab_migrations')
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend dependency
            WHERE dependency.classid = 'pg_proc'::regclass
              AND dependency.objid = p.oid
              AND dependency.deptype = 'e'
          )
      LOOP
        EXECUTE format('ALTER ROUTINE %I.%I(%s) OWNER TO vocab_migration', item.nspname, item.proname, item.arguments);
      END LOOP;
    END $$;

    DO $$
    DECLARE item record;
    BEGIN
      FOR item IN
        SELECT n.nspname, t.typname
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        LEFT JOIN pg_class relation ON relation.oid = t.typrelid
        WHERE n.nspname IN ('public', 'auth', 'vocab_migrations')
          AND (
            t.typtype IN ('e', 'd')
            OR (t.typtype = 'c' AND relation.relkind = 'c')
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend dependency
            WHERE dependency.classid = 'pg_type'::regclass
              AND dependency.objid = t.oid
              AND dependency.deptype = 'e'
          )
      LOOP
        EXECUTE format('ALTER TYPE %I.%I OWNER TO vocab_migration', item.nspname, item.typname);
      END LOOP;
    END $$;
  `);

  const schemas = await client.query<{ schema_name: string }>(
    "SELECT nspname AS schema_name FROM pg_namespace WHERE nspname IN ('auth', 'vocab_migrations')",
  );
  for (const schema of schemas.rows) {
    const alter = await client.query<{ sql: string }>(
      "SELECT format('ALTER SCHEMA %I OWNER TO vocab_migration', $1) AS sql",
      [schema.schema_name],
    );
    await client.query(alter.rows[0]!.sql);
  }
  await client.query("ALTER SCHEMA public OWNER TO vocab_migration");
}

async function convergePrivileges(client: Client, databaseName: string): Promise<void> {
  const databasePrivileges = await client.query<{ sql: string }>(
    `SELECT format(
       'REVOKE ALL ON DATABASE %I FROM PUBLIC, vocab_app, vocab_worker, vocab_backup, vocab_migration; GRANT CONNECT ON DATABASE %I TO vocab_app, vocab_worker, vocab_backup, vocab_migration; GRANT CREATE, TEMPORARY ON DATABASE %I TO vocab_migration',
       $1,
       $1,
       $1
     ) AS sql`,
    [databaseName],
  );
  await client.query(databasePrivileges.rows[0]!.sql);

  await client.query(`
    REVOKE ALL ON SCHEMA public FROM PUBLIC, vocab_app, vocab_worker, vocab_backup, vocab_migration;
    REVOKE ALL ON SCHEMA auth FROM PUBLIC, vocab_app, vocab_worker, vocab_backup, vocab_migration;
    REVOKE ALL ON SCHEMA vocab_migrations FROM PUBLIC, vocab_app, vocab_worker, vocab_backup, vocab_migration;
    GRANT USAGE ON SCHEMA public, auth TO vocab_app, vocab_worker;
    GRANT USAGE ON SCHEMA public, auth, vocab_migrations TO vocab_backup;
    GRANT USAGE, CREATE ON SCHEMA public, auth, vocab_migrations TO vocab_migration;

    REVOKE ALL ON ALL TABLES IN SCHEMA public, auth, vocab_migrations
      FROM PUBLIC, vocab_app, vocab_worker, vocab_backup;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, auth, vocab_migrations
      FROM PUBLIC, vocab_app, vocab_worker, vocab_backup;
    REVOKE ALL ON ALL ROUTINES IN SCHEMA public, auth, vocab_migrations
      FROM PUBLIC, vocab_app, vocab_worker, vocab_backup;

    GRANT SELECT, INSERT, UPDATE ON TABLE public.auth_sessions TO vocab_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.login_rate_limits TO vocab_app;
    GRANT SELECT, UPDATE ON TABLE public.profiles TO vocab_app;
    GRANT SELECT ON TABLE public.words TO vocab_app;
    GRANT SELECT, INSERT ON TABLE public.word_l2_content TO vocab_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.user_word_progress TO vocab_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.user_word_l2_progress TO vocab_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.notes TO vocab_app;
    GRANT SELECT, INSERT ON TABLE public.note_revisions TO vocab_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.sessions TO vocab_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.review_logs TO vocab_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.outbox_events TO vocab_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.wordbooks TO vocab_app;
    GRANT SELECT, INSERT ON TABLE public.wordbook_items TO vocab_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.llm_usage TO vocab_app;
    GRANT SELECT ON TABLE public.collection_notes, public.tags,
      public.word_filter_facets, public.word_tags TO vocab_app;
    GRANT SELECT, INSERT, DELETE ON TABLE public.l3_sources, public.l3_contexts,
      public.l3_occurrences, public.l3_context_links TO vocab_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.l3_import_jobs, public.l3_proposals,
      public.l3_proposal_items TO vocab_app;
    GRANT SELECT, INSERT ON TABLE public.l3_recommendation_runs TO vocab_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.l3_recommendation_items TO vocab_app;

    GRANT SELECT, UPDATE ON TABLE public.outbox_events TO vocab_worker;
    GRANT SELECT, INSERT ON TABLE public.outbox_effect_receipts TO vocab_worker;
    GRANT SELECT, UPDATE ON TABLE public.llm_usage TO vocab_worker;
    GRANT SELECT, UPDATE ON TABLE public.user_word_progress TO vocab_worker;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.user_word_l2_progress TO vocab_worker;
    GRANT UPDATE ON TABLE public.sessions TO vocab_worker;

    DO $$ BEGIN
      IF to_regprocedure('auth.uid()') IS NOT NULL THEN
        GRANT EXECUTE ON FUNCTION auth.uid() TO vocab_app, vocab_worker;
      END IF;
      IF to_regprocedure('public.get_or_create_today_session(uuid,uuid,text,timestamp with time zone)') IS NOT NULL THEN
        GRANT EXECUTE ON FUNCTION public.get_or_create_today_session(uuid, uuid, text, timestamptz) TO vocab_app;
      END IF;
      IF to_regprocedure('public.increment_session_cards_seen(uuid,uuid,uuid)') IS NOT NULL THEN
        GRANT EXECUTE ON FUNCTION public.increment_session_cards_seen(uuid, uuid, uuid) TO vocab_app;
      END IF;
      IF to_regprocedure('public.undo_review_log(uuid,uuid,uuid,uuid)') IS NOT NULL THEN
        GRANT EXECUTE ON FUNCTION public.undo_review_log(uuid, uuid, uuid, uuid) TO vocab_app;
      END IF;
      IF to_regprocedure('public.refresh_l2_cache(uuid)') IS NOT NULL THEN
        GRANT EXECUTE ON FUNCTION public.refresh_l2_cache(uuid) TO vocab_app;
      END IF;
      IF to_regprocedure('public.mark_l2_stale_for_recheck(uuid,text)') IS NOT NULL THEN
        GRANT EXECUTE ON FUNCTION public.mark_l2_stale_for_recheck(uuid, text) TO vocab_app;
      END IF;
    END $$;

    GRANT SELECT ON ALL TABLES IN SCHEMA public, auth, vocab_migrations TO vocab_backup;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, auth, vocab_migrations TO vocab_backup;

    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA public
      REVOKE ALL ON TABLES FROM PUBLIC, vocab_app, vocab_worker, vocab_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA public
      REVOKE ALL ON SEQUENCES FROM PUBLIC, vocab_app, vocab_worker, vocab_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA public
      REVOKE ALL ON ROUTINES FROM PUBLIC, vocab_app, vocab_worker, vocab_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA auth
      REVOKE ALL ON TABLES FROM PUBLIC, vocab_app, vocab_worker, vocab_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA auth
      REVOKE ALL ON SEQUENCES FROM PUBLIC, vocab_app, vocab_worker, vocab_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA auth
      REVOKE ALL ON ROUTINES FROM PUBLIC, vocab_app, vocab_worker, vocab_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA vocab_migrations
      REVOKE ALL ON TABLES FROM PUBLIC, vocab_app, vocab_worker, vocab_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA vocab_migrations
      REVOKE ALL ON SEQUENCES FROM PUBLIC, vocab_app, vocab_worker, vocab_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA vocab_migrations
      REVOKE ALL ON ROUTINES FROM PUBLIC, vocab_app, vocab_worker, vocab_backup;

    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA public
      GRANT SELECT ON TABLES TO vocab_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA public
      GRANT SELECT ON SEQUENCES TO vocab_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA auth
      GRANT SELECT ON TABLES TO vocab_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA auth
      GRANT SELECT ON SEQUENCES TO vocab_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA vocab_migrations
      GRANT SELECT ON TABLES TO vocab_backup;
    ALTER DEFAULT PRIVILEGES FOR ROLE vocab_migration IN SCHEMA vocab_migrations
      GRANT SELECT ON SEQUENCES TO vocab_backup;
  `);
}

async function main(): Promise<void> {
  const phase = bootstrapPhase();
  const adminUrl = requiredUrl("DATABASE_ADMIN_URL");
  const expectedDatabase = databaseIdentity(adminUrl);
  const roles = [
    roleUrl("app", "APP_DATABASE_URL", expectedDatabase),
    roleUrl("worker", "WORKER_DATABASE_URL", expectedDatabase),
    roleUrl("backup", "BACKUP_DATABASE_URL", expectedDatabase),
    roleUrl("migration", "MIGRATION_DATABASE_URL", expectedDatabase),
  ];
  const adminUsername = decodeURIComponent(adminUrl.username);
  if (!adminUsername || Object.values(ROLE_NAMES).includes(adminUsername as (typeof ROLE_NAMES)[RoleKind])) {
    throw new Error("DATABASE_ADMIN_URL must use a dedicated administration identity");
  }

  const client = new Client({ connectionString: adminUrl.toString() });
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  let transactionStarted = false;
  try {
    await client.connect();
    const authority = await client.query<{ current_user: string; rolsuper: boolean }>(
      `SELECT current_user, rolsuper
       FROM pg_roles WHERE rolname = current_user`,
    );
    const principal = authority.rows[0];
    if (!principal?.rolsuper) {
      throw new Error("DATABASE_ADMIN_URL must use a superuser because vocab_backup requires BYPASSRLS");
    }
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET LOCAL search_path = pg_catalog, public");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('vocab:p1a2:database-roles'))");
    for (const role of roles) await roleSql(client, role);
    const databaseName = decodeURIComponent(adminUrl.pathname.slice(1));
    await ensureMigrationAuthority(client, databaseName);
    await ensureApplicationSchemas(client);
    if (phase === "converge") {
      await transferApplicationOwnership(client);
      await convergePrivileges(client, databaseName);
      await transferDatabaseOwnership(client, databaseName);
      await revokeAdminMigrationMembership(client);
      await assertZeroManagedRoleMemberships(client);
    }
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    primaryError = error;
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        cleanupErrors.push(rollbackError);
      }
    }
  }
  try {
    await client.end();
  } catch (endError) {
    cleanupErrors.push(endError);
  }
  if (primaryError !== undefined || cleanupErrors.length !== 0) {
    const errors = primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors];
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "database role bootstrap or cleanup failed");
  }

  console.log(JSON.stringify({
    ok: true,
    phase,
    roles: roles.map(({ kind, role }) => ({ kind, role })),
    appRls: "NOBYPASSRLS",
    workerRls: "NOBYPASSRLS",
    backup: "read-only BYPASSRLS for complete pg_dump",
    migration: "DDL owner",
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
