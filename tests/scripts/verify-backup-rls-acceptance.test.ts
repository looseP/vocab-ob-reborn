import { basename } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptanceDatabaseName,
  acceptanceDatabaseOwnerStatement,
  assertMatchingCatalogSnapshots,
  assertSafeAcceptanceDatabase,
  buildPgDumpInvocation,
  buildPgRestoreInvocation,
  collectCatalogSnapshot,
  retargetDatabaseUrl,
  retargetRoleDatabaseUrls,
  throwAcceptanceErrors,
  type CatalogSnapshot,
} from "../../scripts/verify-backup-rls-acceptance";

const originalSslMode = process.env.DB_SSLMODE;

beforeEach(() => {
  process.env.DB_SSLMODE = "disable";
});

afterEach(() => {
  delete process.env.PG_BIN_DIR;
  delete process.env.PG_RESTORE_JOBS;
  if (originalSslMode === undefined) delete process.env.DB_SSLMODE;
  else process.env.DB_SSLMODE = originalSslMode;
});

describe("backup RLS acceptance command construction", () => {
  it("dumps ownership and ACL state while authenticating only as backup", () => {
    const invocation = buildPgDumpInvocation(
      "postgresql://vocab_backup:backup-secret@db.internal:5433/vocab",
      "/isolated/acceptance.dump",
    );
    expect(basename(invocation.command)).toMatch(/^pg_dump(?:\.exe)?$/);
    expect(invocation.args).toEqual([
      "--format=custom",
      "--compress=6",
      "--no-owner",
      "--file",
      "/isolated/acceptance.dump",
    ]);
    expect(invocation.args).not.toContain("--no-privileges");
    expect(invocation.args.join(" ")).not.toContain("backup-secret");
    expect(invocation.env).toMatchObject({
      PGHOST: "db.internal",
      PGPORT: "5433",
      PGDATABASE: "vocab",
      PGUSER: "vocab_backup",
      PGPASSWORD: "backup-secret",
      PGSSLMODE: "disable",
    });
  });

  it("propagates verify-full to backup subprocesses", () => {
    process.env.DB_SSLMODE = "verify-full";
    const invocation = buildPgDumpInvocation(
      "postgresql://vocab_backup:backup-secret@db.internal:5433/vocab",
      "/isolated/acceptance.dump",
    );
    expect(invocation.env.PGSSLMODE).toBe("verify-full");
  });

  it("restores as the migration LOGIN and replays normalized ACL state", () => {
    process.env.PG_RESTORE_JOBS = "3";
    const invocation = buildPgRestoreInvocation(
      "postgresql://vocab_migration:migration-secret@db.internal:5433/vocab_backup_acceptance_0123456789abcdef0123456789abcdef",
      "C:/isolated/acceptance.dump",
    );
    expect(basename(invocation.command)).toMatch(/^pg_restore(?:\.exe)?$/);
    expect(invocation.args).toEqual([
      "--clean",
      "--if-exists",
      "--exit-on-error",
      "--no-owner",
      "--jobs",
      "3",
      "C:/isolated/acceptance.dump",
    ]);
    expect(invocation.args).not.toContain("--no-privileges");
    expect(invocation.args.join(" ")).not.toContain("migration-secret");
    expect(invocation.env).toMatchObject({ PGUSER: "vocab_migration" });
  });
});

describe("backup RLS acceptance destructive and identity guards", () => {
  const source = "postgresql://admin:secret@db.internal:5432/vocab";
  const name = "vocab_backup_acceptance_0123456789abcdef0123456789abcdef";

  it("creates only a guarded database owned by vocab_migration", () => {
    expect(acceptanceDatabaseOwnerStatement(name)).toBe(
      `CREATE DATABASE "${name}" OWNER vocab_migration TEMPLATE template0`,
    );
    expect(() => acceptanceDatabaseOwnerStatement("vocab_restore")).toThrow(/unguarded/);
  });

  it("retargets all four LOGIN URLs without changing credentials", () => {
    const sourceUrls = {
      app: "postgresql://vocab_app:app-secret@db.internal:5432/vocab",
      worker: "postgresql://vocab_worker:worker-secret@db.internal:5432/vocab",
      backup: "postgresql://vocab_backup:backup-secret@db.internal:5432/vocab",
      migration: "postgresql://vocab_migration:migration-secret@db.internal:5432/vocab",
    };
    const restored = retargetRoleDatabaseUrls(sourceUrls, name);
    for (const kind of Object.keys(sourceUrls) as (keyof typeof sourceUrls)[]) {
      const before = new URL(sourceUrls[kind]);
      const after = new URL(restored[kind]);
      expect(after.pathname).toBe(`/${name}`);
      expect(after.username).toBe(before.username);
      expect(after.password).toBe(before.password);
      expect(after.host).toBe(before.host);
    }
  });

  it("generates and accepts only random prefixed restore databases on the same server", () => {
    const generated = acceptanceDatabaseName("01234567-89ab-cdef-0123-456789abcdef");
    expect(generated).toBe(name);
    const target = retargetDatabaseUrl(source, generated);
    expect(() => assertSafeAcceptanceDatabase(source, target)).not.toThrow();
  });

  it("rejects source, other servers, readable names, and malformed UUID input", () => {
    expect(() => assertSafeAcceptanceDatabase(source, source)).toThrow(/must not be the source/);
    expect(() => assertSafeAcceptanceDatabase(
      source,
      `postgresql://admin:secret@other.internal:5432/${name}`,
    )).toThrow(/source PostgreSQL instance/);
    expect(() => retargetDatabaseUrl(source, "vocab_restore")).toThrow(/unguarded/);
    expect(() => acceptanceDatabaseName("not-a-uuid")).toThrow(/UUID/);
  });
});

function catalog(overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    databaseOwner: "vocab_migration",
    schemas: [
      { schema: "auth", name: "auth", owner: "vocab_migration" },
      { schema: "public", name: "public", owner: "vocab_migration" },
      { schema: "vocab_migrations", name: "vocab_migrations", owner: "vocab_migration" },
    ],
    relations: [{ schema: "public", name: "wordbooks", owner: "vocab_migration", kind: "r" }],
    columns: [{ schema: "public", table: "wordbooks", position: 1, name: "id", type: "uuid", notNull: true, defaultExpression: null, identity: "", generated: "", collation: null }],
    indexes: [{ schema: "public", table: "wordbooks", name: "wordbooks_pkey", definition: "CREATE UNIQUE INDEX wordbooks_pkey ON public.wordbooks USING btree (id)", unique: true, primary: true, valid: true }],
    constraints: [{ schema: "public", table: "wordbooks", name: "wordbooks_pkey", kind: "p", definition: "PRIMARY KEY (id)", deferrable: false, initiallyDeferred: false, validated: true }],
    triggers: [{ schema: "public", table: "wordbooks", name: "wordbooks_audit", definition: "CREATE TRIGGER wordbooks_audit BEFORE UPDATE ON public.wordbooks FOR EACH ROW EXECUTE FUNCTION audit()", enabled: "O" }],
    routines: [{ schema: "auth", name: "uid", owner: "vocab_migration", identityArguments: "", kind: "f" }],
    types: [{ schema: "public", name: "learning_state", owner: "vocab_migration", kind: "e" }],
    extensions: [{ name: "pgcrypto", version: "1.3", owner: "vocab_migration" }],
    rowSecurity: [{ schema: "public", table: "wordbooks", rowSecurity: true, forceRowSecurity: true }],
    policies: [{
      schema: "public", table: "wordbooks", name: "wordbooks_own_all", command: "*",
      roles: ["public"], permissive: true, qual: "(auth.uid() = user_id)", withCheck: "(auth.uid() = user_id)",
    }],
    migrationHistory: { count: 14, sha256: "a".repeat(64), maxId: "14", maxCreatedAt: "1700000000000" },
    sequences: [{ schema: "public", name: "events_id_seq", lastValue: "17", isCalled: true }],
    acls: {
      schemas: [{ schema: "public", name: "public", acl: ["vocab_app=U/vocab_migration"] }],
      relations: [{ schema: "public", name: "wordbooks", acl: ["vocab_backup=r/vocab_migration"] }],
      routines: [{ schema: "auth", name: "uid", identityArguments: "", acl: ["vocab_app=X/vocab_migration"] }],
      defaults: [{ owner: "vocab_migration", schema: "public", objectType: "r", acl: ["vocab_backup=r/vocab_migration"] }],
    },
    ...overrides,
  };
}

describe("catalog snapshot contract", () => {
  it("executes normalized catalog queries including ownership, policies, migration history, sequences and ACLs", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_database")) return { rows: [{ owner: "vocab_migration" }] };
      if (sql.includes("FROM pg_namespace")) return { rows: [
        { schema: "public", name: "public", owner: "vocab_migration", acl: ["z", "a"] },
      ] };
      if (sql.includes("FROM pg_class")) return { rows: [
        { schema: "public", name: "items_id_seq", owner: "vocab_migration", kind: "S", acl: null },
      ] };
      if (sql.includes("FROM pg_attribute")) return { rows: [] };
      if (sql.includes("FROM pg_index")) return { rows: [] };
      if (sql.includes("FROM pg_constraint")) return { rows: [] };
      if (sql.includes("FROM pg_trigger")) return { rows: [] };
      if (sql.includes("FROM pg_proc")) return { rows: [] };
      if (sql.includes("FROM pg_type")) return { rows: [] };
      if (sql.includes("FROM pg_extension")) return { rows: [] };
      if (sql.includes("relrowsecurity")) return { rows: [] };
      if (sql.includes("FROM pg_policy")) return { rows: [] };
      if (sql.includes("__v2_release_migrations")) return { rows: [
        { row: { id: 1, hash: "first", created_at: 10 } },
        { row: { id: 2, hash: "second", created_at: 20 } },
      ] };
      if (sql.includes('"public"."items_id_seq"')) return { rows: [{ last_value: "9", is_called: true }] };
      if (sql.includes("FROM pg_default_acl")) return { rows: [
        { owner: "vocab_migration", schema: "public", object_type: "r", acl: ["z", "a"] },
      ] };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const snapshot = await collectCatalogSnapshot({ query } as never);
    expect(snapshot.databaseOwner).toBe("vocab_migration");
    expect(snapshot.migrationHistory).toMatchObject({ count: 2, maxId: "2", maxCreatedAt: "20" });
    expect(snapshot.migrationHistory.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.sequences).toEqual([{ schema: "public", name: "items_id_seq", lastValue: "9", isCalled: true }]);
    expect(snapshot.acls.schemas[0]?.acl).toEqual(["a", "z"]);
    expect(snapshot.acls.defaults[0]?.acl).toEqual(["a", "z"]);
    const statements = query.mock.calls.map(([sql]) => sql).join("\n");
    expect(statements).toContain("d.deptype = 'e'");
    expect(statements).toContain("p.polcmd");
    expect(statements).toContain("p.polroles");
    expect(statements).toContain("pg_get_expr(p.polqual");
    expect(statements).toContain("pg_get_function_identity_arguments");
    expect(statements).toContain("FROM pg_attribute");
    expect(statements).toContain("FROM pg_index");
    expect(statements).toContain("FROM pg_constraint");
    expect(statements).toContain("FROM pg_trigger");
  });

  it.each([
    ["database owner", { databaseOwner: "admin" }],
    ["relation owner", { relations: [{ schema: "public", name: "wordbooks", owner: "admin", kind: "r" }] }],
    ["column default", { columns: [{ ...catalog().columns[0]!, defaultExpression: "gen_random_uuid()" }] }],
    ["index definition", { indexes: [{ ...catalog().indexes[0]!, unique: false }] }],
    ["constraint definition", { constraints: [{ ...catalog().constraints[0]!, validated: false }] }],
    ["trigger definition", { triggers: [{ ...catalog().triggers[0]!, enabled: "D" }] }],
    ["RLS flags", { rowSecurity: [{ schema: "public", table: "wordbooks", rowSecurity: false, forceRowSecurity: true }] }],
    ["policy expression", { policies: [{ ...catalog().policies[0]!, qual: "true" }] }],
    ["migration hash", { migrationHistory: { ...catalog().migrationHistory, sha256: "b".repeat(64) } }],
    ["sequence state", { sequences: [{ schema: "public", name: "events_id_seq", lastValue: "18", isCalled: true }] }],
    ["relation ACL", { acls: { ...catalog().acls, relations: [{ schema: "public", name: "wordbooks", acl: null }] } }],
    ["default ACL", { acls: { ...catalog().acls, defaults: [] } }],
  ])("rejects restored %s drift", (_label, override) => {
    expect(() => assertMatchingCatalogSnapshots(catalog(), catalog(override as Partial<CatalogSnapshot>))).toThrow(/catalog snapshot differs/);
  });

  it("compares restore database owner to the migration target rather than mechanically to source owner", () => {
    const source = catalog({ databaseOwner: "vocab_roles_admin" });
    const restored = catalog({ databaseOwner: "vocab_migration" });
    expect(() => assertMatchingCatalogSnapshots(source, restored, "vocab_migration")).not.toThrow();
    expect(() => assertMatchingCatalogSnapshots(source, catalog({ databaseOwner: "vocab_roles_admin" }), "vocab_migration")).toThrow(/databaseOwner/);
  });

  it("accepts an exact normalized snapshot", () => {
    expect(() => assertMatchingCatalogSnapshots(catalog(), structuredClone(catalog()))).not.toThrow();
  });
});

describe("acceptance error aggregation", () => {
  it("preserves the primary error and every cleanup error in order", () => {
    const primary = new Error("restore failed");
    const close = new Error("restored close failed");
    const drop = new Error("database drop failed");
    const fixture = new Error("fixture cleanup failed");
    const admin = new Error("admin close failed");
    const temporary = new Error("temporary directory cleanup failed");
    try {
      throwAcceptanceErrors(primary, [close, drop, fixture, admin, temporary]);
      throw new Error("expected aggregation");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([primary, close, drop, fixture, admin, temporary]);
    }
  });

  it("throws a single primary or cleanup failure without wrapping it", () => {
    const primary = new Error("primary");
    const cleanup = new Error("cleanup");
    expect(() => throwAcceptanceErrors(primary, [])).toThrow(primary);
    expect(() => throwAcceptanceErrors(undefined, [cleanup])).toThrow(cleanup);
    expect(() => throwAcceptanceErrors(undefined, [])).not.toThrow();
  });
});
