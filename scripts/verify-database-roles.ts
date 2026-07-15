import { randomUUID } from "node:crypto";
import { Client, type QueryResultRow } from "pg";
import { computeFullHash, computeL2Hash } from "../src/db/content-hash";
import { postgresClientConfig } from "../src/db/ssl";

const ROLE_URLS = {
  app: ["APP_DATABASE_URL", "vocab_app"],
  worker: ["WORKER_DATABASE_URL", "vocab_worker"],
  backup: ["BACKUP_DATABASE_URL", "vocab_backup"],
  migration: ["MIGRATION_DATABASE_URL", "vocab_migration"],
} as const;

type RoleKind = keyof typeof ROLE_URLS;

interface VerifiedUrl {
  kind: RoleKind;
  name: string;
  role: string;
  url: URL;
}

interface Fixture {
  users: [string, string, string];
  wordbooks: [string, string, string, string, string];
  words: [string, string, string];
  l2Progress: [string, string, string, string, string];
  expectedL2Hash: string;
  expectedContentHash: string;
  originalDueAt: string;
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

function verifiedRoleUrls(adminUrl: URL): VerifiedUrl[] {
  const expectedDatabase = databaseIdentity(adminUrl);
  return Object.entries(ROLE_URLS).map(([kind, [name, role]]) => {
    const url = requiredUrl(name);
    if (databaseIdentity(url) !== expectedDatabase) {
      throw new Error(`${name} must target the same database as DATABASE_ADMIN_URL`);
    }
    if (decodeURIComponent(url.username) !== role) {
      throw new Error(`${name} username must be exactly ${role}`);
    }
    return { kind: kind as RoleKind, name, role, url };
  });
}

async function connect(url: URL): Promise<Client> {
  const client = new Client(postgresClientConfig(url.toString()));
  await client.connect();
  return client;
}

async function expectDenied(client: Client, sql: string, params: unknown[], label: string): Promise<void> {
  try {
    await client.query(sql, params);
  } catch (error) {
    if ((error as { code?: string }).code === "42501") return;
    throw error;
  }
  throw new Error(`unexpectedly allowed: ${label}`);
}

async function actorQuery<T extends QueryResultRow>(
  client: Client,
  actorId: string | undefined,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await client.query("BEGIN");
  try {
    if (actorId) {
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [actorId]);
    }
    const result = await client.query<T>(sql, params);
    await client.query("ROLLBACK");
    return result.rows;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "actor query and rollback failed");
    }
    throw error;
  }
}

async function actorCommitQuery<T extends QueryResultRow>(
  client: Client,
  actorId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [actorId]);
    const result = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "actor command and rollback failed");
    }
    throw error;
  }
}

async function expectActorInvisible(
  client: Client,
  actorId: string | undefined,
  sql: string,
  params: unknown[],
  label: string,
): Promise<void> {
  const rows = await actorQuery(client, actorId, sql, params);
  if (rows.length !== 0) throw new Error(`unexpectedly affected rows: ${label}`);
}

async function assertLoginIdentity(client: Client, expectedRole: string): Promise<void> {
  const identity = await client.query<{ session_user: string; current_user: string }>(
    "SELECT session_user, current_user",
  );
  const row = identity.rows[0];
  if (!row || row.session_user !== expectedRole || row.current_user !== expectedRole) {
    throw new Error(`${expectedRole} did not authenticate as a real LOGIN identity`);
  }
}

async function seedFixture(admin: Client): Promise<Fixture> {
  const originalContentHash = "0".repeat(64);
  const expectedWordForHash = {
    definition_md: "role probe",
    core_definitions: [],
    prototype_text: null,
    metadata: {},
    collocations: [{ order: "bare-1" }, { order: "bare-2" }],
    corpus_items: [{ order: "wrapper-1" }, { order: "wrapper-2" }],
    synonym_items: [{ order: "single" }],
    antonym_items: [{ order: "active" }],
  };
  const expectedL2Hash = computeL2Hash(expectedWordForHash);
  const expectedContentHash = computeFullHash(expectedWordForHash);
  const originalDueAt = "2099-01-01T00:00:00.000Z";
  const fixture: Fixture = {
    users: [randomUUID(), randomUUID(), randomUUID()],
    wordbooks: [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    words: [randomUUID(), randomUUID(), randomUUID()],
    l2Progress: [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    expectedL2Hash,
    expectedContentHash,
    originalDueAt,
  };
  const suffix = randomUUID().replaceAll("-", "");
  const wordbookOwners = [fixture.users[0], fixture.users[1], fixture.users[0], fixture.users[1], fixture.users[1]];
  await admin.query("BEGIN");
  try {
    for (let index = 0; index < fixture.users.length; index += 1) {
      await admin.query(
        "INSERT INTO users (id, email) VALUES ($1, $2)",
        [fixture.users[index], `p1a2-${suffix}-${index}@example.invalid`],
      );
      await admin.query(
        "INSERT INTO profiles (id, email) VALUES ($1, $2)",
        [fixture.users[index], `p1a2-${suffix}-${index}@example.invalid`],
      );
    }
    for (let index = 0; index < fixture.wordbooks.length; index += 1) {
      await admin.query(
        "INSERT INTO wordbooks (id, user_id, name) VALUES ($1, $2, $3)",
        [fixture.wordbooks[index], wordbookOwners[index], `p1a2-${suffix}-${index}`],
      );
    }
    for (let index = 0; index < fixture.words.length; index += 1) {
      await admin.query(
        `INSERT INTO words
         (id, slug, content_hash, source_path, title, lemma, definition_md, body_md, is_published)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          fixture.words[index],
          `p1a2-${suffix}-${index}`,
          index === 0 ? originalContentHash : `${index}`.repeat(64),
          `p1a2/${suffix}-${index}.md`,
          `P1a2 role probe ${index}`,
          `p1a2-role-probe-${index}`,
          "role probe",
          "role probe",
          index !== 2,
        ],
      );
    }
    const l2Rows = [
      ["collocation", [{ order: "bare-1" }, { order: "bare-2" }], "2026-01-01T00:00:00.000Z", true],
      ["corpus", { schemaVersion: "l2-content-v1", items: [{ order: "wrapper-1" }, { order: "wrapper-2" }] }, "2026-01-02T00:00:00.000Z", true],
      ["synonym", { order: "single" }, "2026-01-03T00:00:00.000Z", true],
      ["antonym", [{ order: "active" }], "2026-01-04T00:00:00.000Z", true],
      ["antonym", [{ order: "inactive" }], "2026-01-05T00:00:00.000Z", false],
    ] as const;
    for (const [field, content, createdAt, isActive] of l2Rows) {
      await admin.query(
        `INSERT INTO word_l2_content (word_id, field, content, source, created_at, is_active)
         VALUES ($1, $2, $3::jsonb, 'p1a2-role-probe', $4, $5)`,
        [fixture.words[0], field, JSON.stringify(content), createdAt, isActive],
      );
    }
    await admin.query(
      `INSERT INTO word_l2_content (word_id, field, content, source, created_at, is_active)
       VALUES ($1, 'collocation', '[{"order":"other-word"}]'::jsonb,
               'p1a2-role-probe', '2026-01-01T00:00:00.000Z', true)`,
      [fixture.words[1]],
    );
    const progressRows = [
      [fixture.l2Progress[0], fixture.users[0], fixture.wordbooks[0], "c".repeat(64), false],
      [fixture.l2Progress[1], fixture.users[1], fixture.wordbooks[1], "d".repeat(64), false],
      [fixture.l2Progress[2], fixture.users[0], fixture.wordbooks[2], "e".repeat(64), true],
      [fixture.l2Progress[3], fixture.users[1], fixture.wordbooks[3], null, false],
      [fixture.l2Progress[4], fixture.users[1], fixture.wordbooks[4], expectedL2Hash, false],
    ] as const;
    for (const [id, userId, wordbookId, snapshot, paused] of progressRows) {
      await admin.query(
        `INSERT INTO user_word_l2_progress
         (id, user_id, word_id, wordbook_id, l2_content_hash_snapshot, l2_paused, l2_due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, userId, fixture.words[0], wordbookId, snapshot, paused, originalDueAt],
      );
    }
    await admin.query("COMMIT");
    return fixture;
  } catch (error) {
    try {
      await admin.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "fixture seed and rollback failed");
    }
    throw error;
  }
}

async function cleanupFixture(admin: Client, fixture: Fixture | undefined): Promise<void> {
  if (!fixture) return;
  await admin.query("BEGIN");
  try {
    await admin.query("DELETE FROM public.users WHERE id = ANY($1::uuid[])", [fixture.users]);
    await admin.query("DELETE FROM public.words WHERE id = ANY($1::uuid[])", [fixture.words]);
    await admin.query("COMMIT");
  } catch (error) {
    try {
      await admin.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "fixture cleanup and rollback failed");
    }
    throw error;
  }
}

async function verifyRoleCatalog(admin: Client): Promise<void> {
  const expected = {
    vocab_app: { bypass: false },
    vocab_worker: { bypass: false },
    vocab_backup: { bypass: true },
    vocab_migration: { bypass: false },
  } as const;
  const roles = await admin.query<{
    rolname: keyof typeof expected;
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolinherit: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
            rolinherit, rolreplication, rolbypassrls
     FROM pg_roles WHERE rolname = ANY($1::text[])`,
    [Object.keys(expected)],
  );
  if (roles.rowCount !== Object.keys(expected).length) {
    throw new Error("not all P1a.2 roles exist");
  }
  for (const role of roles.rows) {
    if (!role.rolcanlogin || role.rolsuper || role.rolcreatedb || role.rolcreaterole
      || role.rolinherit || role.rolreplication || role.rolbypassrls !== expected[role.rolname].bypass) {
      throw new Error(`${role.rolname} has unsafe or incorrect role attributes`);
    }
  }
  const memberships = await admin.query<{ member: string; parent: string }>(
    `SELECT member.rolname AS member, parent.rolname AS parent
     FROM pg_auth_members membership
     JOIN pg_roles member ON member.oid = membership.member
     JOIN pg_roles parent ON parent.oid = membership.roleid
     WHERE member.rolname = ANY($1::text[])
        OR parent.rolname = ANY($1::text[])`,
    [Object.keys(expected)],
  );
  if (memberships.rowCount !== 0) {
    throw new Error(`P1a.2 roles must have zero incoming and outgoing memberships: ${JSON.stringify(memberships.rows)}`);
  }
}

function privilegeKey(role: string, object: string, privilege: string): string {
  return `${role}\u0000${object}\u0000${privilege}`;
}

function assertExactPrivilegeSet(label: string, expected: Set<string>, actual: Set<string>): void {
  const unexpected = [...actual].filter((item) => !expected.has(item)).sort();
  const missing = [...expected].filter((item) => !actual.has(item)).sort();
  if (unexpected.length !== 0 || missing.length !== 0) {
    throw new Error(`${label} privileges are not exact: ${JSON.stringify({ unexpected, missing })}`);
  }
}

async function verifyPrivilegeCatalog(admin: Client, databaseName: string): Promise<void> {
  const tableAllowlist = new Map<string, Map<string, Set<string>>>([
    ["PUBLIC", new Map()],
    ["vocab_app", new Map(Object.entries({
      "public.auth_sessions": ["SELECT", "INSERT", "UPDATE"],
      "public.login_rate_limits": ["SELECT", "INSERT", "UPDATE", "DELETE"],
      "public.profiles": ["SELECT", "UPDATE"],
      "public.words": ["SELECT"],
      "public.word_l2_content": ["SELECT", "INSERT"],
      "public.user_word_progress": ["SELECT", "INSERT", "UPDATE"],
      "public.user_word_l2_progress": ["SELECT", "INSERT", "UPDATE"],
      "public.notes": ["SELECT", "INSERT", "UPDATE"],
      "public.note_revisions": ["SELECT", "INSERT"],
      "public.sessions": ["SELECT", "INSERT", "UPDATE"],
      "public.review_logs": ["SELECT", "INSERT", "UPDATE"],
      "public.outbox_events": ["SELECT", "INSERT", "UPDATE"],
      "public.wordbooks": ["SELECT", "INSERT", "UPDATE"],
      "public.wordbook_items": ["SELECT", "INSERT"],
      "public.llm_usage": ["SELECT", "INSERT", "UPDATE"],
      "public.collection_notes": ["SELECT"],
      "public.tags": ["SELECT"],
      "public.word_filter_facets": ["SELECT"],
      "public.word_tags": ["SELECT"],
      "public.l3_sources": ["SELECT", "INSERT", "DELETE"],
      "public.l3_contexts": ["SELECT", "INSERT", "DELETE"],
      "public.l3_occurrences": ["SELECT", "INSERT", "DELETE"],
      "public.l3_context_links": ["SELECT", "INSERT", "DELETE"],
      "public.l3_import_jobs": ["SELECT", "INSERT", "UPDATE"],
      "public.l3_proposals": ["SELECT", "INSERT", "UPDATE"],
      "public.l3_proposal_items": ["SELECT", "INSERT", "UPDATE"],
      "public.l3_recommendation_runs": ["SELECT", "INSERT"],
      "public.l3_recommendation_items": ["SELECT", "INSERT", "UPDATE"],
    }).map(([relation, privileges]) => [relation, new Set(privileges)]))],
    ["vocab_worker", new Map(Object.entries({
      "public.outbox_events": ["SELECT", "UPDATE"],
      "public.outbox_effect_receipts": ["SELECT", "INSERT"],
      "public.llm_usage": ["SELECT", "UPDATE"],
      "public.user_word_progress": ["SELECT", "UPDATE"],
      "public.user_word_l2_progress": ["SELECT", "INSERT", "UPDATE"],
      "public.sessions": ["UPDATE"],
    }).map(([relation, privileges]) => [relation, new Set(privileges)]))],
  ]);
  const tablePrivileges = await admin.query<{ role_name: string; relation: string; privilege: string }>(
    `SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS role_name,
            format('%I.%I', namespace.nspname, relation.relname) AS relation,
            acl.privilege_type AS privilege
     FROM pg_class relation
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     CROSS JOIN LATERAL aclexplode(relation.relacl) acl
     LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND (acl.grantee = 0 OR grantee.rolname = ANY($1::text[]))`,
    [[...tableAllowlist.keys()]],
  );
  const expectedTablePrivileges = new Set<string>();
  for (const [role, relations] of tableAllowlist) {
    for (const [relation, privileges] of relations) {
      for (const privilege of privileges) expectedTablePrivileges.add(privilegeKey(role, relation, privilege));
    }
  }
  assertExactPrivilegeSet(
    "application table",
    expectedTablePrivileges,
    new Set(tablePrivileges.rows.map(({ role_name, relation, privilege }) => privilegeKey(role_name, relation, privilege))),
  );

  const functionAllowlist = new Map<string, Set<string>>([
    ["PUBLIC", new Set()],
    ["vocab_app", new Set([
      "auth.uid()",
      "public.get_or_create_today_session(uuid,uuid,text,timestamp with time zone)",
      "public.increment_session_cards_seen(uuid,uuid,uuid)",
      "public.undo_review_log(uuid,uuid,uuid,uuid)",
      "public.refresh_l2_cache(uuid)",
      "public.finalize_l2_content_hash(uuid,text,text)",
    ])],
    ["vocab_worker", new Set(["auth.uid()"])],
    ["vocab_backup", new Set()],
  ]);
  const functions = await admin.query<{ role_name: string; routine: string }>(
    `SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS role_name,
            format('%I.%I(%s)', namespace.nspname, routine.proname,
                   pg_get_function_identity_arguments(routine.oid)) AS routine
     FROM pg_proc routine
     JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
     CROSS JOIN LATERAL aclexplode(routine.proacl) acl
     LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
       AND (acl.grantee = 0 OR grantee.rolname = ANY($1::text[]))
       AND acl.privilege_type = 'EXECUTE'`,
    [[...functionAllowlist.keys()]],
  );
  const expectedRoutinePrivileges = new Set<string>();
  for (const [role, routines] of functionAllowlist) {
    for (const routine of routines) expectedRoutinePrivileges.add(privilegeKey(role, routine, "EXECUTE"));
  }
  assertExactPrivilegeSet(
    "managed routine EXECUTE",
    expectedRoutinePrivileges,
    new Set(functions.rows.map(({ role_name, routine }) => privilegeKey(role_name, routine, "EXECUTE"))),
  );

  const backupRelations = await admin.query<{ relation: string; privilege: string }>(
    `SELECT format('%I.%I', namespace.nspname, relation.relname) AS relation,
            acl.privilege_type AS privilege
     FROM pg_class relation
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     CROSS JOIN LATERAL aclexplode(relation.relacl) acl
     JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND grantee.rolname = 'vocab_backup'`,
  );
  const managedRelations = await admin.query<{ relation: string }>(
    `SELECT format('%I.%I', namespace.nspname, relation.relname) AS relation
     FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')`,
  );
  assertExactPrivilegeSet(
    "backup relation",
    new Set(managedRelations.rows.map(({ relation }) => privilegeKey("vocab_backup", relation, "SELECT"))),
    new Set(backupRelations.rows.map(({ relation, privilege }) => privilegeKey("vocab_backup", relation, privilege))),
  );

  const sequencePrivileges = await admin.query<{ role_name: string; sequence: string; privilege: string }>(
    `SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS role_name,
            format('%I.%I', namespace.nspname, sequence.relname) AS sequence,
            acl.privilege_type AS privilege
     FROM pg_class sequence
     JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
     CROSS JOIN LATERAL aclexplode(sequence.relacl) acl
     LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
       AND sequence.relkind = 'S'
       AND (acl.grantee = 0 OR grantee.rolname = ANY($1::text[]))`,
    [["vocab_app", "vocab_worker", "vocab_backup"]],
  );
  const managedSequences = await admin.query<{ sequence: string }>(
    `SELECT format('%I.%I', namespace.nspname, sequence.relname) AS sequence
     FROM pg_class sequence JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
     WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
       AND sequence.relkind = 'S'`,
  );
  assertExactPrivilegeSet(
    "managed sequence",
    new Set(managedSequences.rows.map(({ sequence }) => privilegeKey("vocab_backup", sequence, "SELECT"))),
    new Set(sequencePrivileges.rows.map(({ role_name, sequence, privilege }) => privilegeKey(role_name, sequence, privilege))),
  );

  const databasePrivileges = await admin.query<{ role_name: string; privilege: string }>(
    `SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS role_name,
            acl.privilege_type AS privilege
     FROM pg_database database
     CROSS JOIN LATERAL aclexplode(database.datacl) acl
     LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE database.datname = $1
       AND (acl.grantee = 0 OR grantee.rolname = ANY($2::text[]))`,
    [databaseName, ["vocab_app", "vocab_worker", "vocab_backup", "vocab_migration"]],
  );
  assertExactPrivilegeSet(
    "database",
    new Set([
      ...["vocab_app", "vocab_worker", "vocab_backup", "vocab_migration"].map((role) => privilegeKey(role, databaseName, "CONNECT")),
      privilegeKey("vocab_migration", databaseName, "CREATE"),
      privilegeKey("vocab_migration", databaseName, "TEMPORARY"),
    ]),
    new Set(databasePrivileges.rows.map(({ role_name, privilege }) => privilegeKey(role_name, databaseName, privilege))),
  );

  const schemaPrivileges = await admin.query<{ role_name: string; schema_name: string; privilege: string }>(
    `SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS role_name,
            namespace.nspname AS schema_name, acl.privilege_type AS privilege
     FROM pg_namespace namespace
     CROSS JOIN LATERAL aclexplode(namespace.nspacl) acl
     LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
       AND (acl.grantee = 0 OR grantee.rolname = ANY($1::text[]))`,
    [["vocab_app", "vocab_worker", "vocab_backup", "vocab_migration"]],
  );
  const expectedSchemaPrivileges = new Set<string>();
  for (const role of ["vocab_app", "vocab_worker"]) {
    for (const schema of ["public", "auth"]) expectedSchemaPrivileges.add(privilegeKey(role, schema, "USAGE"));
  }
  for (const schema of ["public", "auth", "vocab_migrations"]) {
    expectedSchemaPrivileges.add(privilegeKey("vocab_backup", schema, "USAGE"));
    expectedSchemaPrivileges.add(privilegeKey("vocab_migration", schema, "USAGE"));
    expectedSchemaPrivileges.add(privilegeKey("vocab_migration", schema, "CREATE"));
  }
  assertExactPrivilegeSet(
    "schema",
    expectedSchemaPrivileges,
    new Set(schemaPrivileges.rows.map(({ role_name, schema_name, privilege }) => privilegeKey(role_name, schema_name, privilege))),
  );

  const columnAcl = await admin.query(
    `SELECT grantee.rolname AS role_name, namespace.nspname AS schema_name,
            relation.relname AS relation_name, attribute.attname AS column_name
     FROM pg_attribute attribute
     JOIN pg_class relation ON relation.oid = attribute.attrelid
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
     LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
       AND (acl.grantee = 0 OR grantee.rolname = ANY($1::text[]))`,
    [["vocab_app", "vocab_worker", "vocab_backup"]],
  );
  if (columnAcl.rowCount !== 0) {
    throw new Error(`managed roles retain column ACLs: ${JSON.stringify(columnAcl.rows)}`);
  }

  const defaultAcl = await admin.query<{ schema_name: string; object_type: string; grantee: string; privilege: string }>(
    `SELECT namespace.nspname AS schema_name, defaults.defaclobjtype AS object_type,
            CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
            acl.privilege_type AS privilege
     FROM pg_default_acl defaults
     JOIN pg_roles owner ON owner.oid = defaults.defaclrole
     JOIN pg_namespace namespace ON namespace.oid = defaults.defaclnamespace
     CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
     LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
     WHERE owner.rolname = 'vocab_migration'
       AND namespace.nspname IN ('public', 'auth', 'vocab_migrations')`,
  );
  const expectedDefaultAcl = new Set<string>();
  for (const schema of ["public", "auth", "vocab_migrations"]) {
    expectedDefaultAcl.add(privilegeKey(schema, "r:vocab_backup", "SELECT"));
    expectedDefaultAcl.add(privilegeKey(schema, "S:vocab_backup", "SELECT"));
  }
  assertExactPrivilegeSet(
    "default ACL",
    expectedDefaultAcl,
    new Set(defaultAcl.rows.map(({ schema_name, object_type, grantee, privilege }) => privilegeKey(schema_name, `${object_type}:${grantee}`, privilege))),
  );
}

async function verifyOwnership(admin: Client): Promise<void> {
  const databaseOwner = await admin.query<{ owner: string }>(
    "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()",
  );
  if (databaseOwner.rows[0]?.owner !== "vocab_migration") {
    throw new Error(`application database is not owned by vocab_migration: ${JSON.stringify(databaseOwner.rows)}`);
  }
  const wrongRelations = await admin.query<{ schema_name: string; object_name: string; owner: string }>(
    `SELECT namespace.nspname AS schema_name, relation.relname AS object_name, owner.rolname AS owner
     FROM pg_class relation
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     JOIN pg_roles owner ON owner.oid = relation.relowner
     WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
         WHERE dependency.classid = 'pg_class'::regclass
           AND dependency.objid = relation.oid
           AND dependency.deptype = 'e'
       )
       AND owner.rolname <> 'vocab_migration'`,
  );
  if (wrongRelations.rowCount !== 0) {
    throw new Error(`application relations are not owned by vocab_migration: ${JSON.stringify(wrongRelations.rows)}`);
  }
  const wrongSchemas = await admin.query<{ schema_name: string; owner: string }>(
    `SELECT namespace.nspname AS schema_name, owner.rolname AS owner
     FROM pg_namespace namespace JOIN pg_roles owner ON owner.oid = namespace.nspowner
     WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
       AND owner.rolname <> 'vocab_migration'`,
  );
  if (wrongSchemas.rowCount !== 0) {
    throw new Error(`application schemas are not owned by vocab_migration: ${JSON.stringify(wrongSchemas.rows)}`);
  }
  const wrongRoutines = await admin.query<{ schema_name: string; object_name: string; owner: string }>(
    `SELECT namespace.nspname AS schema_name,
            format('%I(%s)', routine.proname, pg_get_function_identity_arguments(routine.oid)) AS object_name,
            owner.rolname AS owner
     FROM pg_proc routine
     JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
     JOIN pg_roles owner ON owner.oid = routine.proowner
     WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
         WHERE dependency.classid = 'pg_proc'::regclass
           AND dependency.objid = routine.oid
           AND dependency.deptype = 'e'
       )
       AND owner.rolname <> 'vocab_migration'`,
  );
  if (wrongRoutines.rowCount !== 0) {
    throw new Error(`application routines are not owned by vocab_migration: ${JSON.stringify(wrongRoutines.rows)}`);
  }
  const wrongTypes = await admin.query<{ schema_name: string; object_name: string; owner: string }>(
    `SELECT namespace.nspname AS schema_name, type.typname AS object_name, owner.rolname AS owner
     FROM pg_type type
     JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
     JOIN pg_roles owner ON owner.oid = type.typowner
     LEFT JOIN pg_class relation ON relation.oid = type.typrelid
     WHERE namespace.nspname IN ('public', 'auth', 'vocab_migrations')
       AND (type.typtype IN ('e', 'd') OR (type.typtype = 'c' AND relation.relkind = 'c'))
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
         WHERE dependency.classid = 'pg_type'::regclass
           AND dependency.objid = type.oid
           AND dependency.deptype = 'e'
       )
       AND owner.rolname <> 'vocab_migration'`,
  );
  if (wrongTypes.rowCount !== 0) {
    throw new Error(`application types are not owned by vocab_migration: ${JSON.stringify(wrongTypes.rows)}`);
  }
}

async function verifyAppRls(app: Client, fixture: Fixture): Promise<void> {
  await expectDenied(app, "SELECT id FROM import_runs LIMIT 1", [], "vocab_app privileged import audit read");
  await expectDenied(app, "UPDATE words SET title = title WHERE id = $1", [fixture.words[0]], "vocab_app catalog administration write");
  const own = await actorQuery<{ id: string }>(
    app,
    fixture.users[0],
    "SELECT id FROM wordbooks WHERE id = ANY($1::uuid[]) ORDER BY id",
    [fixture.wordbooks],
  );
  if (JSON.stringify(own.map(({ id }) => id).sort()) !== JSON.stringify([fixture.wordbooks[0], fixture.wordbooks[2]].sort())) {
    throw new Error("vocab_app did not enforce owner RLS for user A");
  }
  const other = await actorQuery<{ id: string }>(
    app,
    fixture.users[1],
    "SELECT id FROM wordbooks WHERE id = ANY($1::uuid[]) ORDER BY id",
    [fixture.wordbooks],
  );
  if (JSON.stringify(other.map(({ id }) => id).sort())
    !== JSON.stringify([fixture.wordbooks[1], fixture.wordbooks[3], fixture.wordbooks[4]].sort())) {
    throw new Error("vocab_app did not enforce owner RLS for user B");
  }
  const anonymous = await actorQuery<{ id: string }>(
    app,
    undefined,
    "SELECT id FROM wordbooks WHERE id = ANY($1::uuid[])",
    [fixture.wordbooks],
  );
  if (anonymous.length !== 0) throw new Error("vocab_app exposed owner rows without an actor");
  await expectActorInvisible(
    app,
    fixture.users[0],
    "UPDATE wordbooks SET name = name WHERE id = $1 RETURNING id",
    [fixture.wordbooks[1]],
    "vocab_app cross-owner update",
  );
}

async function expectActorFunctionDenied(
  client: Client,
  actorId: string | undefined,
  sql: string,
  params: unknown[],
  label: string,
): Promise<void> {
  try {
    await actorQuery(client, actorId, sql, params);
  } catch (error) {
    if ((error as { code?: string }).code === "42501") return;
    throw error;
  }
  throw new Error(`unexpectedly allowed: ${label}`);
}

async function verifyL2SecurityFunctions(app: Client, admin: Client, fixture: Fixture): Promise<void> {
  const targetWord = fixture.words[0];
  const otherWord = fixture.words[1];
  const ineligibleWord = fixture.words[2];
  const forgedL2Hash = "f".repeat(64);
  const forgedContentHash = "9".repeat(64);

  for (const [actorId, label] of [[undefined, "without actor"], [fixture.users[2], "wrong actor"]] as const) {
    await expectActorFunctionDenied(
      app,
      actorId,
      "SELECT public.refresh_l2_cache($1::uuid)",
      [targetWord],
      `refresh_l2_cache ${label}`,
    );
    await expectActorFunctionDenied(
      app,
      actorId,
      "SELECT public.finalize_l2_content_hash($1::uuid, $2::text, $3::text)",
      [targetWord, forgedL2Hash, forgedContentHash],
      `finalize_l2_content_hash ${label}`,
    );
  }
  await expectActorFunctionDenied(
    app,
    fixture.users[0],
    "SELECT public.refresh_l2_cache($1::uuid)",
    [otherWord],
    "refresh_l2_cache for actor-ineligible word",
  );
  await expectActorFunctionDenied(
    app,
    fixture.users[0],
    "SELECT public.finalize_l2_content_hash($1::uuid, $2::text, $3::text)",
    [ineligibleWord, fixture.expectedL2Hash, fixture.expectedContentHash],
    "finalize_l2_content_hash for non-published word",
  );
  await expectActorFunctionDenied(
    app,
    fixture.users[0],
    "SELECT public.finalize_l2_content_hash($1::uuid, $2::text, $3::text)",
    [targetWord, forgedL2Hash, forgedContentHash],
    "finalize_l2_content_hash with forged hashes",
  );

  await actorCommitQuery(app, fixture.users[0], "SELECT public.refresh_l2_cache($1::uuid)", [targetWord]);
  const cacheRows = await admin.query<{
    id: string;
    collocations: unknown;
    corpus_items: unknown;
    synonym_items: unknown;
    antonym_items: unknown;
  }>(
    `SELECT id, collocations, corpus_items, synonym_items, antonym_items
     FROM words WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [[targetWord, otherWord]],
  );
  const target = cacheRows.rows.find((row) => row.id === targetWord);
  const other = cacheRows.rows.find((row) => row.id === otherWord);
  if (!target || JSON.stringify(target.collocations) !== JSON.stringify([{ order: "bare-1" }, { order: "bare-2" }])
    || JSON.stringify(target.corpus_items) !== JSON.stringify([{ order: "wrapper-1" }, { order: "wrapper-2" }])
    || JSON.stringify(target.synonym_items) !== JSON.stringify([{ order: "single" }])
    || JSON.stringify(target.antonym_items) !== JSON.stringify([{ order: "active" }])) {
    throw new Error(`refresh_l2_cache produced unstable or incorrect aggregation: ${JSON.stringify(target)}`);
  }
  if (!other || JSON.stringify(other.collocations) !== "[]" || JSON.stringify(other.corpus_items) !== "[]"
    || JSON.stringify(other.synonym_items) !== "[]" || JSON.stringify(other.antonym_items) !== "[]") {
    throw new Error(`refresh_l2_cache modified a non-target word: ${JSON.stringify(other)}`);
  }

  const finalized = await actorCommitQuery<{ updated_count: number }>(
    app,
    fixture.users[0],
    "SELECT public.finalize_l2_content_hash($1::uuid, $2::text, $3::text) AS updated_count",
    [targetWord, fixture.expectedL2Hash, fixture.expectedContentHash],
  );
  if (finalized[0]?.updated_count !== 2) {
    throw new Error(`finalize_l2_content_hash updated unexpected progress count: ${JSON.stringify(finalized)}`);
  }
  const wordHashes = await admin.query<{ l2_content_hash: string | null; content_hash: string }>(
    "SELECT l2_content_hash, content_hash FROM words WHERE id = $1",
    [targetWord],
  );
  const wordHash = wordHashes.rows[0];
  if (wordHash?.l2_content_hash !== fixture.expectedL2Hash || wordHash.content_hash !== fixture.expectedContentHash) {
    throw new Error(`finalize_l2_content_hash persisted incorrect canonical hashes: ${JSON.stringify(wordHash)}`);
  }
  const progress = await admin.query<{
    id: string;
    l2_content_hash_snapshot: string | null;
    l2_paused: boolean;
    due_changed: boolean;
  }>(
    `SELECT id, l2_content_hash_snapshot, l2_paused, l2_due_at <> $2::timestamptz AS due_changed
     FROM user_word_l2_progress WHERE word_id = $1 ORDER BY id`,
    [targetWord, fixture.originalDueAt],
  );
  const expected = new Map([
    [fixture.l2Progress[0], { snapshot: fixture.expectedL2Hash, changed: true }],
    [fixture.l2Progress[1], { snapshot: fixture.expectedL2Hash, changed: true }],
    [fixture.l2Progress[2], { snapshot: "e".repeat(64), changed: false }],
    [fixture.l2Progress[3], { snapshot: null, changed: false }],
    [fixture.l2Progress[4], { snapshot: fixture.expectedL2Hash, changed: false }],
  ]);
  for (const row of progress.rows) {
    const expectedRow = expected.get(row.id);
    if (!expectedRow || row.l2_content_hash_snapshot !== expectedRow.snapshot || row.due_changed !== expectedRow.changed) {
      throw new Error(`finalize_l2_content_hash changed an excluded progress row: ${JSON.stringify(row)}`);
    }
  }
}

async function verifyWorker(worker: Client, fixture: Fixture): Promise<void> {
  const own = await actorQuery<{ id: string }>(
    worker,
    fixture.users[0],
    "SELECT id FROM user_word_l2_progress WHERE id = ANY($1::uuid[]) ORDER BY id",
    [fixture.l2Progress],
  );
  if (JSON.stringify(own.map(({ id }) => id).sort())
    !== JSON.stringify([fixture.l2Progress[0], fixture.l2Progress[2]].sort())) {
    throw new Error("vocab_worker did not enforce owner RLS on L2 progress");
  }
  const anonymous = await actorQuery<{ id: string }>(
    worker,
    undefined,
    "SELECT id FROM user_word_l2_progress WHERE id = ANY($1::uuid[])",
    [fixture.l2Progress],
  );
  if (anonymous.length !== 0) throw new Error("vocab_worker exposed L2 progress without an actor");
  await expectActorInvisible(
    worker,
    fixture.users[0],
    "UPDATE user_word_l2_progress SET l2_review_count = l2_review_count + 1 WHERE id = $1 RETURNING id",
    [fixture.l2Progress[1]],
    "vocab_worker cross-owner L2 update",
  );
  await worker.query("SELECT id FROM outbox_events FOR UPDATE SKIP LOCKED LIMIT 0");
  await expectDenied(worker, "SELECT public.refresh_l2_cache($1::uuid)", [fixture.words[0]], "vocab_worker L2 cache function execute");
  await expectDenied(
    worker,
    "SELECT public.finalize_l2_content_hash($1::uuid, $2::text, $3::text)",
    [fixture.words[0], fixture.expectedL2Hash, fixture.expectedContentHash],
    "vocab_worker L2 hash function execute",
  );
  await expectDenied(worker, "DELETE FROM profiles WHERE id = $1", [fixture.users[0]], "vocab_worker unrelated table write");
}

async function verifyBackup(backup: Client, fixture: Fixture): Promise<void> {
  const rows = await backup.query<{ id: string }>(
    "SELECT id FROM wordbooks WHERE id = ANY($1::uuid[]) ORDER BY id",
    [fixture.wordbooks],
  );
  if (rows.rowCount !== fixture.wordbooks.length) throw new Error("vocab_backup cannot read all owner rows for a complete dump");
  await expectDenied(backup, "UPDATE wordbooks SET name = name WHERE id = $1", [fixture.wordbooks[0]], "vocab_backup application write");
  await expectDenied(backup, "SELECT public.refresh_l2_cache($1::uuid)", [fixture.words[0]], "vocab_backup L2 cache function execute");
  await expectDenied(
    backup,
    "SELECT public.finalize_l2_content_hash($1::uuid, $2::text, $3::text)",
    [fixture.words[0], fixture.expectedL2Hash, fixture.expectedContentHash],
    "vocab_backup L2 hash function execute",
  );
  await expectDenied(backup, "CREATE TABLE backup_forbidden_probe(id integer)", [], "vocab_backup DDL");
  await expectDenied(backup, "CREATE ROLE backup_forbidden_role", [], "vocab_backup role administration");
}

async function verifyDdlIsolation(app: Client, worker: Client, backup: Client, migration: Client): Promise<void> {
  for (const [role, client] of [["vocab_app", app], ["vocab_worker", worker], ["vocab_backup", backup]] as const) {
    await expectDenied(client, `CREATE TABLE ${role}_forbidden_probe(id integer)`, [], `${role} schema DDL`);
  }
  await migration.query("BEGIN");
  try {
    await migration.query("CREATE TABLE p1a2_migration_probe(id integer)");
  } finally {
    await migration.query("ROLLBACK");
  }
  await expectDenied(migration, "CREATE ROLE migration_forbidden_role", [], "vocab_migration role administration");
}

async function main(): Promise<void> {
  const adminUrl = requiredUrl("DATABASE_ADMIN_URL");
  const adminUsername = decodeURIComponent(adminUrl.username);
  if (!adminUsername || Object.values(ROLE_URLS).some(([, role]) => role === adminUsername)) {
    throw new Error("DATABASE_ADMIN_URL must use a dedicated administration identity");
  }
  const roleUrls = verifiedRoleUrls(adminUrl);
  const clients = new Map<RoleKind, Client>();
  const admin = await connect(adminUrl);
  let fixture: Fixture | undefined;
  let verificationError: unknown;
  try {
    const adminIdentity = await admin.query<{ session_user: string; current_user: string; rolsuper: boolean }>(
      `SELECT session_user, current_user,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper`,
    );
    const identity = adminIdentity.rows[0];
    if (!identity || identity.session_user !== adminUsername || identity.current_user !== adminUsername
      || Object.values(ROLE_URLS).some(([, role]) => role === identity.current_user) || !identity.rolsuper) {
      throw new Error("DATABASE_ADMIN_URL must authenticate as its dedicated superuser identity");
    }
    await verifyRoleCatalog(admin);
    await verifyOwnership(admin);
    await verifyPrivilegeCatalog(admin, decodeURIComponent(adminUrl.pathname.slice(1)));
    for (const roleUrl of roleUrls) {
      const client = await connect(roleUrl.url);
      clients.set(roleUrl.kind, client);
      await assertLoginIdentity(client, roleUrl.role);
    }
    fixture = await seedFixture(admin);
    const app = clients.get("app")!;
    const worker = clients.get("worker")!;
    const backup = clients.get("backup")!;
    const migration = clients.get("migration")!;
    await verifyAppRls(app, fixture);
    await verifyL2SecurityFunctions(app, admin, fixture);
    await verifyWorker(worker, fixture);
    await verifyBackup(backup, fixture);
    await verifyDdlIsolation(app, worker, backup, migration);
  } catch (error) {
    verificationError = error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    await cleanupFixture(admin, fixture);
  } catch (error) {
    cleanupErrors.push(error);
  }
  for (const client of clients.values()) {
    try {
      await client.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await admin.end();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (verificationError !== undefined || cleanupErrors.length !== 0) {
    const errors = verificationError === undefined ? cleanupErrors : [verificationError, ...cleanupErrors];
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "database role verification or cleanup failed");
  }

  console.log(JSON.stringify({
    ok: true,
    realLoginIdentities: true,
    dedicatedSuperuserAdmin: true,
    appRls: true,
    workerRls: true,
    backupReadOnlyBypassRls: true,
    ddlExclusiveToMigration: true,
    zeroIncomingAndOutgoingMemberships: true,
    exactPrivileges: true,
    functionExecuteAllowlist: true,
    l2SecurityFunctions: true,
    ownershipConverged: true,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
