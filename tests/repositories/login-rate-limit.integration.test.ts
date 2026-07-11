import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { LoginRateLimitRepository } from "@/repositories/login-rate-limit.repository";
import { resetPool } from "@/db/connection";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database integration tests");

const key = (suffix: string) => suffix.padStart(64, "0");

describe("LoginRateLimitRepository", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const repository = new LoginRateLimitRepository();

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    await pool.query("DELETE FROM login_rate_limits WHERE key_hash LIKE $1", ["00000000000000000000000000000000000000000000000000000000000000%"]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM login_rate_limits WHERE key_hash LIKE $1", ["00000000000000000000000000000000000000000000000000000000000000%"]);
    await resetPool();
    await pool.end();
  });

  it("atomically counts concurrent consumers in one database-defined window", async () => {
    await pool.query(
      `INSERT INTO login_rate_limits (key_hash, window_started_at, window_expires_at, attempts)
       VALUES ($1, clock_timestamp(), clock_timestamp() + interval '2 minutes', 1)`,
      [key("a1")],
    );
    const results = await Promise.all(Array.from({ length: 24 }, () => repository.consume({ keyHash: key("a1"), windowMs: 60_000 })));
    expect(results.map((result) => result.attempts).sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, index) => index + 2));
    expect(results.every((result) => result.retryAfterSeconds >= 1 && result.retryAfterSeconds <= 120)).toBe(true);
  });

  it("never moves an existing window backwards", async () => {
    await pool.query(
      `INSERT INTO login_rate_limits (key_hash, window_started_at, window_expires_at, attempts)
       VALUES ($1, clock_timestamp() + interval '2 minutes', clock_timestamp() + interval '3 minutes', 7)`,
      [key("a2")],
    );
    const result = await repository.consume({ keyHash: key("a2"), windowMs: 60_000 });
    expect(result.attempts).toBe(8);
    const row = await pool.query<{ attempts: number }>("SELECT attempts FROM login_rate_limits WHERE key_hash = $1", [key("a2")]);
    expect(row.rows[0]?.attempts).toBe(8);
  });

  it("deletes expired rows in bounded batches while consuming", async () => {
    const values = Array.from({ length: 110 }, (_, index) => [key((0xb00 + index).toString(16)), "2000-01-01T00:00:00.000Z", "2000-01-01T00:01:00.000Z", 1]);
    for (const value of values) {
      await pool.query("INSERT INTO login_rate_limits (key_hash, window_started_at, window_expires_at, attempts) VALUES ($1, $2, $3, $4)", value);
    }
    await repository.consume({ keyHash: key("a3"), windowMs: 60_000 });
    const remaining = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM login_rate_limits WHERE window_expires_at < clock_timestamp() AND key_hash <> $1", [key("a3")]);
    expect(Number(remaining.rows[0]?.count)).toBeLessThanOrEqual(10);
  });
});
