import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const bootstrap = readFileSync(resolve(projectRoot, "scripts/bootstrap-database-roles.ts"), "utf8");
const verifier = readFileSync(resolve(projectRoot, "scripts/verify-database-roles.ts"), "utf8");

function expectRoutineRevocationContract(source: string): void {
  expect(source).toContain("REVOKE ALL ON ALL ROUTINES IN SCHEMA public, auth, vocab_migrations");
  expect(source).toContain("FROM PUBLIC, vocab_app, vocab_worker, vocab_backup");
  for (const schema of ["public", "auth", "vocab_migrations"]) {
    expect(source).toContain(`FOR ROLE vocab_migration IN SCHEMA ${schema}`);
    expect(source).toMatch(new RegExp(`IN SCHEMA ${schema}\\s+REVOKE ALL ON ROUTINES FROM PUBLIC, vocab_app, vocab_worker, vocab_backup`));
  }
}

function expectExactVerifierContract(source: string): void {
  expect(source).toContain("const unexpected = [...actual].filter");
  expect(source).toContain("const missing = [...expected].filter");
  for (const label of [
    "application table",
    "managed routine EXECUTE",
    "backup relation",
    "managed sequence",
    "database",
    "schema",
    "default ACL",
  ]) {
    expect(source).toContain(`"${label}"`);
  }
  expect(source).toContain("managed roles retain column ACLs");
  expect(source).toContain("acl.grantee = 0");
}

describe("database role bootstrap least-privilege contract", () => {
  it("requires dedicated superusers in bootstrap and verifier", () => {
    expect(bootstrap).toContain("if (!principal?.rolsuper)");
    expect(bootstrap).toContain("SET LOCAL search_path = pg_catalog, public");
    expect(verifier).toContain("identity.session_user !== adminUsername");
    expect(verifier).toContain("!identity.rolsuper");
    expect(verifier).toContain("dedicatedSuperuserAdmin: true");
  });

  it("removes and verifies both incoming and outgoing memberships", () => {
    expect(bootstrap).toContain("WHERE member.rolname = $1 OR parent.rolname = $1");
    expect(bootstrap).toContain("assertZeroManagedRoleMemberships(client)");
    expect(verifier).toContain("zero incoming and outgoing memberships");
  });

  it("revokes current and future routine execution in every managed schema", () => {
    expectRoutineRevocationContract(bootstrap);
    const publicLeak = bootstrap.replace(
      "REVOKE ALL ON ALL ROUTINES IN SCHEMA public, auth, vocab_migrations",
      "REVOKE ALL ON ALL ROUTINES IN SCHEMA public, auth",
    );
    expect(() => expectRoutineRevocationContract(publicLeak)).toThrow();
    const backupLeak = bootstrap.replace(
      "REVOKE ALL ON ROUTINES FROM PUBLIC, vocab_app, vocab_worker, vocab_backup",
      "REVOKE ALL ON ROUTINES FROM PUBLIC, vocab_app, vocab_worker",
    );
    expect(() => expectRoutineRevocationContract(backupLeak)).toThrow();
  });

  it("resets all default ACL grantees before granting backup SELECT only", () => {
    for (const schema of ["public", "auth", "vocab_migrations"]) {
      for (const kind of ["TABLES", "SEQUENCES", "ROUTINES"]) {
        expect(bootstrap).toMatch(new RegExp(
          `IN SCHEMA ${schema}\\s+REVOKE ALL ON ${kind} FROM PUBLIC, vocab_app, vocab_worker, vocab_backup`,
        ));
      }
      expect(bootstrap).toMatch(new RegExp(`IN SCHEMA ${schema}\\s+GRANT SELECT ON TABLES TO vocab_backup`));
      expect(bootstrap).toMatch(new RegExp(`IN SCHEMA ${schema}\\s+GRANT SELECT ON SEQUENCES TO vocab_backup`));
      expect(bootstrap).not.toMatch(new RegExp(`IN SCHEMA ${schema}\\s+GRANT .* ON ROUTINES TO vocab_backup`));
    }
  });

  it("verifies expected-minus-actual and actual-minus-expected for every ACL layer", () => {
    expectExactVerifierContract(verifier);
    const oneWayVerifier = verifier.replace(
      "const missing = [...expected].filter((item) => !actual.has(item)).sort();",
      "const missing: string[] = [];",
    );
    expect(() => expectExactVerifierContract(oneWayVerifier)).toThrow();
    expect(verifier).toContain("new Map()],\n    [\"vocab_app\"");
    expect(verifier).toContain("[\"PUBLIC\", new Set()]");
    expect(verifier).toContain("[\"vocab_backup\", new Set()]");
  });

  it("makes backup managed relation SELECT exact and routine EXECUTE empty", () => {
    expect(verifier).toContain("grantee.rolname = 'vocab_backup'");
    expect(verifier).toContain("managedRelations.rows.map");
    expect(verifier).toContain("privilegeKey(\"vocab_backup\", relation, \"SELECT\")");
    expect(verifier).toContain("[\"vocab_backup\", new Set()]");
    expect(bootstrap).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA public, auth, vocab_migrations TO vocab_backup");
    expect(bootstrap).toContain("GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, auth, vocab_migrations TO vocab_backup");
  });

  it("converges and verifies the database owner", () => {
    expect(bootstrap).toContain("ALTER DATABASE %I OWNER TO vocab_migration");
    expect(verifier).toContain("application database is not owned by vocab_migration");
  });

  it("converges and verifies routine and type ownership across all schemas excluding extensions", () => {
    const managedSchemaSet = "n.nspname IN ('public', 'auth', 'vocab_migrations')";
    expect(bootstrap.match(new RegExp(managedSchemaSet.replace(/[()]/g, "\\$&"), "g"))?.length).toBeGreaterThanOrEqual(3);
    expect(bootstrap).toContain("dependency.deptype = 'e'");
    expect(verifier).toContain("application routines are not owned by vocab_migration");
    expect(verifier).toContain("application types are not owned by vocab_migration");
    expect(verifier).toContain("dependency.classid = 'pg_proc'::regclass");
    expect(verifier).toContain("dependency.classid = 'pg_type'::regclass");
  });

  it("preserves primary, rollback, and end failures and publishes success after cleanup", () => {
    expect(bootstrap).toContain("let primaryError: unknown");
    expect(bootstrap).toContain("cleanupErrors.push(rollbackError)");
    expect(bootstrap).toContain("cleanupErrors.push(endError)");
    expect(bootstrap).toContain("new AggregateError(errors, \"database role bootstrap or cleanup failed\")");
    expect(bootstrap).not.toMatch(/ROLLBACK"\)\.catch\(\(\) => undefined\)/);
    const end = bootstrap.indexOf("await client.end()");
    const success = bootstrap.indexOf("console.log(JSON.stringify({", end);
    expect(end).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(end);
  });
});
