import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool, resetPool } from "@/db/connection";
import { withTransaction } from "@/db/transaction";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const acceptanceDatabaseUrl = process.env.RLS_ACCEPTANCE_DATABASE_URL;
const ACTOR_A = randomUUID();
const ACTOR_B = randomUUID();
const ACCEPTANCE_DATE = "2030-01-01";

if (!adminDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required to seed the RLS acceptance fixture");
}
if (!acceptanceDatabaseUrl) {
  throw new Error(
    "RLS_ACCEPTANCE_DATABASE_URL is required for the restricted RLS acceptance session",
  );
}

interface IdentityRow {
  claim: string | null;
  backendPid: number;
}

async function currentIdentity(tx: PoolClient): Promise<IdentityRow> {
  const result = await tx.query<IdentityRow>(
    `SELECT
       current_setting('request.jwt.claim.sub', true) AS "claim",
       pg_backend_pid() AS "backendPid"`,
  );
  return result.rows[0]!;
}

function expectNoClaim(claim: string | null): void {
  expect([null, ""]).toContain(claim);
}

describe("RLS transaction identity", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPoolMax = process.env.DB_POOL_MAX;
  const adminPool = new Pool({ connectionString: adminDatabaseUrl, max: 1 });

  beforeAll(async () => {
    await adminPool.query(
      `INSERT INTO users (id, email)
       VALUES ($1, $2), ($3, $4)`,
      [
        ACTOR_A,
        `rls-actor-a-${ACTOR_A}@example.test`,
        ACTOR_B,
        `rls-actor-b-${ACTOR_B}@example.test`,
      ],
    );

    // Integration tests may have initialized the singleton with the admin URL.
    // Reset before changing configuration, then use one restricted client so
    // the hygiene cases prove identity does not leak across actual reuse.
    await resetPool();
    process.env.DATABASE_URL = acceptanceDatabaseUrl;
    process.env.DB_POOL_MAX = "1";
  });

  afterAll(async () => {
    try {
      await withTransaction(async (tx) => {
        await tx.query(
          `DELETE FROM daily_forecast_snapshots
           WHERE user_id = $1 AND date IN ($2, $3)`,
          [ACTOR_A, ACCEPTANCE_DATE, "2030-01-02"],
        );
      }, { actorId: ACTOR_A });
    } finally {
      await resetPool();
      await adminPool.query(
        "DELETE FROM users WHERE id = ANY($1::uuid[])",
        [[ACTOR_A, ACTOR_B]],
      );
      await adminPool.end();

      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalPoolMax === undefined) delete process.env.DB_POOL_MAX;
      else process.env.DB_POOL_MAX = originalPoolMax;
    }
  });

  it("runs as the dedicated non-owner NOSUPERUSER NOBYPASSRLS principal", async () => {
    const result = await getPool().query<{
      sessionUser: string;
      currentUser: string;
      superuser: boolean;
      bypassRls: boolean;
      ownsProbeTable: boolean;
      roleMemberships: number;
    }>(
      `SELECT
         session_user AS "sessionUser",
         current_user AS "currentUser",
         role.rolsuper AS "superuser",
         role.rolbypassrls AS "bypassRls",
         table_info.tableowner = current_user AS "ownsProbeTable",
         (SELECT count(*)::int FROM pg_auth_members WHERE member = role.oid) AS "roleMemberships"
       FROM pg_roles AS role
       JOIN pg_tables AS table_info
         ON table_info.schemaname = 'public'
        AND table_info.tablename = 'daily_forecast_snapshots'
       WHERE role.rolname = current_user`,
    );

    expect(result.rows).toEqual([{
      sessionUser: "vocab_rls_acceptance",
      currentUser: "vocab_rls_acceptance",
      superuser: false,
      bypassRls: false,
      ownsProbeTable: false,
      roleMemberships: 0,
    }]);
  });

  it("allows actor A to write only its own row and blocks actor B reads and writes", async () => {
    await withTransaction(async (tx) => {
      await tx.query(
        `DELETE FROM daily_forecast_snapshots
         WHERE user_id = $1 AND date IN ($2, $3)`,
        [ACTOR_A, ACCEPTANCE_DATE, "2030-01-02"],
      );
      await tx.query(
        `INSERT INTO daily_forecast_snapshots (user_id, date, forecast_count, desired_retention)
         VALUES ($1, $2, $3, $4)`,
        [ACTOR_A, ACCEPTANCE_DATE, 7, "0.900"],
      );
    }, { actorId: ACTOR_A });

    const bRead = await withTransaction(async (tx) => {
      return tx.query<{ userId: string }>(
        `SELECT user_id AS "userId"
         FROM daily_forecast_snapshots
         WHERE date = $1`,
        [ACCEPTANCE_DATE],
      );
    }, { actorId: ACTOR_B });
    expect(bRead.rowCount).toBe(0);

    const bUpdate = await withTransaction(async (tx) => {
      return tx.query(
        `UPDATE daily_forecast_snapshots
         SET forecast_count = 99
         WHERE user_id = $1 AND date = $2`,
        [ACTOR_A, ACCEPTANCE_DATE],
      );
    }, { actorId: ACTOR_B });
    expect(bUpdate.rowCount).toBe(0);

    await expect(withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO daily_forecast_snapshots (user_id, date, forecast_count, desired_retention)
         VALUES ($1, $2, $3, $4)`,
        [ACTOR_A, "2030-01-02", 1, "0.900"],
      );
    }, { actorId: ACTOR_B })).rejects.toThrow(/row-level security policy/i);

    const aRead = await withTransaction(async (tx) => {
      return tx.query<{ forecastCount: number }>(
        `SELECT forecast_count AS "forecastCount"
         FROM daily_forecast_snapshots
         WHERE user_id = $1 AND date = $2`,
        [ACTOR_A, ACCEPTANCE_DATE],
      );
    }, { actorId: ACTOR_A });
    expect(aRead.rows).toEqual([{ forecastCount: 7 }]);
  });

  it("denies owner data when no actor claim is present", async () => {
    const result = await withTransaction(async (tx) => {
      const identity = await currentIdentity(tx);
      const rows = await tx.query(
        "SELECT 1 FROM daily_forecast_snapshots WHERE user_id = $1 AND date = $2",
        [ACTOR_A, ACCEPTANCE_DATE],
      );
      return { identity, rowCount: rows.rowCount };
    });

    expectNoClaim(result.identity.claim);
    expect(result.rowCount).toBe(0);
  });

  it("clears the actor claim after a callback rollback", async () => {
    const rollbackIdentity = await withTransaction(async (tx) => {
      const identity = await currentIdentity(tx);
      expect(identity.claim).toBe(ACTOR_A);
      throw new Error("intentional rollback probe");
    }, { actorId: ACTOR_A }).catch((error: unknown) => error);
    expect(rollbackIdentity).toBeInstanceOf(Error);

    const afterRollback = await withTransaction((tx) => currentIdentity(tx));
    expectNoClaim(afterRollback.claim);
  });

  it("does not cross-contaminate A, B, and no-actor transactions on one connection", async () => {
    const a = await withTransaction((tx) => currentIdentity(tx), { actorId: ACTOR_A });
    const b = await withTransaction((tx) => currentIdentity(tx), { actorId: ACTOR_B });
    const anonymous = await withTransaction((tx) => currentIdentity(tx));

    expect(a.claim).toBe(ACTOR_A);
    expect(b.claim).toBe(ACTOR_B);
    expectNoClaim(anonymous.claim);
    expect(new Set([a.backendPid, b.backendPid, anonymous.backendPid])).toEqual(
      new Set([a.backendPid]),
    );
  });
});
