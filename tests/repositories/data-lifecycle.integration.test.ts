import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataLifecycleRepository } from "../../src/repositories/data-lifecycle.repository";

const execFileAsync = promisify(execFile);

describe.skipIf(!process.env.TEST_DATABASE_URL)("data lifecycle repository", () => {
  const databaseUrl = process.env.TEST_DATABASE_URL!;
  const pool = new Pool({ connectionString: databaseUrl });
  const repo = new DataLifecycleRepository(pool);
  const cutoff = new Date("2026-07-11T00:00:00.000Z");

  beforeAll(async () => {
    await pool.query("TRUNCATE outbox_effect_receipts, outbox_events, llm_usage CASCADE");
  });

  afterAll(async () => pool.end());

  async function insertOutbox(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      ids.push(id);
      await pool.query(
        `INSERT INTO outbox_events
           (id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, status, processed_at, created_at, updated_at)
         VALUES ($1, 'review', $2, 'test', '{}', $3, 'processed', now() - interval '20 days', now() - interval '20 days', now())`,
        [id, randomUUID(), randomUUID()],
      );
    }
    return ids;
  }

  it("dry-run reports without writing", async () => {
    await insertOutbox(1);
    const result = await repo.run({ cutoff, dryRun: true });
    expect(result.eligible.outboxProcessed).toBe(1);
    expect(result.deleted.outboxProcessed).toBe(0);
    expect((await pool.query("SELECT count(*)::int count FROM outbox_events")).rows[0].count).toBe(1);
  });

  it("runner defaults to dry-run and execute requires exact database confirmation", async () => {
    await pool.query("TRUNCATE outbox_effect_receipts, outbox_events CASCADE");
    await insertOutbox(1);
    const baseEnv = {
      ...process.env,
      DATA_LIFECYCLE_DATABASE_URL: databaseUrl,
      TEST_DATABASE_URL: "",
      DATABASE_URL: "postgresql://ignored:ignored@127.0.0.1:1/ignored",
      DATA_LIFECYCLE_CUTOFF: cutoff.toISOString(),
    };
    const dryRun = await execFileAsync(process.execPath, ["--import", "tsx", "scripts/run-data-lifecycle.ts"], {
      cwd: process.cwd(),
      env: baseEnv,
    });
    expect(JSON.parse(dryRun.stdout).eligible.outboxProcessed).toBe(1);
    expect((await pool.query("SELECT count(*)::int count FROM outbox_events")).rows[0].count).toBe(1);
    await expect(execFileAsync(process.execPath, ["--import", "tsx", "scripts/run-data-lifecycle.ts", "--execute"], {
      cwd: process.cwd(),
      env: { ...baseEnv, DATA_LIFECYCLE_CONFIRM: "wrong_database" },
    })).rejects.toMatchObject({ stderr: expect.stringContaining("must exactly match database name") });
    expect((await pool.query("SELECT count(*)::int count FROM outbox_events")).rows[0].count).toBe(1);
  });

  it("keeps pending LLM reservations and deletes only eligible terminal states", async () => {
    await pool.query("TRUNCATE outbox_effect_receipts, outbox_events, llm_usage CASCADE");
    await pool.query(`INSERT INTO llm_usage (provider, model, prompt_tokens, completion_tokens, status, expires_at, created_at)
      VALUES ('__reservation__', 'test', 0, 0, 'pending', now() - interval '30 days', now() - interval '30 days')`);
    await pool.query(`INSERT INTO llm_usage (provider, model, prompt_tokens, completion_tokens, status, expires_at, finalized_at, created_at)
      VALUES ('__reservation__', 'test', 0, 0, 'released', now() - interval '30 days', now() - interval '30 days', now() - interval '30 days')`);
    await repo.run({ cutoff, allowWrite: true });
    expect((await pool.query("SELECT status FROM llm_usage ORDER BY status")).rows).toEqual([{ status: "pending" }]);
  });

  it("archives review logs idempotently before deleting the source", async () => {
    const userId = randomUUID();
    const wordId = randomUUID();
    const wordbookId = randomUUID();
    const reviewId = randomUUID();
    try {
      await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
      await pool.query("INSERT INTO profiles (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
      await pool.query(`INSERT INTO words (id, slug, content_hash, source_path, title, lemma, definition_md, body_md)
        VALUES ($1, $2, repeat('a', 64), $3, 'test', 'test', 'test', 'test')`, [wordId, wordId, `/test/${wordId}`]);
      await pool.query("INSERT INTO wordbooks (id, user_id, name) VALUES ($1, $2, 'test')", [wordbookId, userId]);
      await pool.query(`INSERT INTO review_logs
        (id, user_id, word_id, rating, state, reviewed_at, wordbook_id)
        VALUES ($1, $2, $3, 'good', '{}', now() - interval '100 days', $4)`, [reviewId, userId, wordId, wordbookId]);
      await pool.query(`INSERT INTO review_logs_archive
        (id, user_id, word_id, rating, state, reviewed_at, wordbook_id)
        SELECT id, user_id, word_id, rating, state, reviewed_at, wordbook_id
        FROM review_logs WHERE id = $1`, [reviewId]);
      const result = await repo.run({ cutoff, allowWrite: true });
      expect(result.archived.reviewLogs).toBe(1);
      expect(result.deleted.reviewLogs).toBe(1);
      expect((await pool.query("SELECT count(*)::int count FROM review_logs WHERE id = $1", [reviewId])).rows[0].count).toBe(0);
      const archive = (await pool.query("SELECT metadata, track, undone FROM review_logs_archive WHERE id = $1", [reviewId])).rows[0];
      expect(archive).toEqual({ metadata: {}, track: "l1", undone: false });
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.query("DELETE FROM words WHERE id = $1", [wordId]);
    }
  });

  it("two concurrent runners have no duplicate or missed deletions and receipts cascade", async () => {
    await pool.query("TRUNCATE outbox_effect_receipts, outbox_events CASCADE");
    const ids = await insertOutbox(220);
    await pool.query("INSERT INTO outbox_effect_receipts (event_id, effect_name) VALUES ($1, 'test')", [ids[0]]);
    const [first, second] = await Promise.all([
      repo.run({ cutoff, allowWrite: true, policy: { batchSize: 100 } }),
      repo.run({ cutoff, allowWrite: true, policy: { batchSize: 100 } }),
    ]);
    expect(first.deleted.outboxProcessed + second.deleted.outboxProcessed).toBe(220);
    expect((await pool.query("SELECT count(*)::int count FROM outbox_events")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int count FROM outbox_effect_receipts")).rows[0].count).toBe(0);
  });
});
