import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { resetPool } from "@/db/connection";
import { withTransaction } from "@/db/transaction";
import { createRepositories } from "@/repositories/factory";
import { OutboxRepository } from "@/repositories/outbox.repository";
import { ReviewOutboxWorker } from "@/outbox/review-outbox.worker";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for database integration tests");
}

describe("release database contract", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const userId = "00000000-0000-4000-8000-000000000011";
  const wordbookId = "00000000-0000-4000-8000-000000000012";
  const otherUserId = "00000000-0000-4000-8000-000000000021";
  const otherWordbookId = "00000000-0000-4000-8000-000000000022";

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    await pool.query(
      `INSERT INTO public.users (id, email)
       VALUES ($1::uuid, 'integration@example.invalid')
       ON CONFLICT (id) DO NOTHING`,
      [userId],
    );
    await pool.query(
      `INSERT INTO public.profiles (id, email)
       VALUES ($1::uuid, 'integration@example.invalid')
       ON CONFLICT (id) DO NOTHING`,
      [userId],
    );
    await pool.query(
      `INSERT INTO public.wordbooks (id, user_id, name, description, is_default, settings)
       VALUES ($1::uuid, $2::uuid, 'Integration', NULL, false, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [wordbookId, userId],
    );
    await pool.query(
      `INSERT INTO public.users (id, email)
       VALUES ($1::uuid, 'integration-other@example.invalid')
       ON CONFLICT (id) DO NOTHING`,
      [otherUserId],
    );
    await pool.query(
      `INSERT INTO public.profiles (id, email)
       VALUES ($1::uuid, 'integration-other@example.invalid')
       ON CONFLICT (id) DO NOTHING`,
      [otherUserId],
    );
    await pool.query(
      `INSERT INTO public.wordbooks (id, user_id, name, description, is_default, settings)
       VALUES ($1::uuid, $2::uuid, 'Integration other', NULL, false, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [otherWordbookId, otherUserId],
    );
    await pool.query(
      `DELETE FROM public.sessions
       WHERE user_id = ANY($1::uuid[])`,
      [[userId, otherUserId]],
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM public.outbox_events WHERE aggregate_id = ANY($1::uuid[])", [[
      "00000000-0000-4000-8000-000000000041",
      "00000000-0000-4000-8000-000000000042",
      "00000000-0000-4000-8000-000000000043",
    ]]);
    await pool.query("DELETE FROM public.auth_sessions WHERE user_id = ANY($1::uuid[])", [[userId, otherUserId]]);
    await pool.query("DELETE FROM public.sessions WHERE user_id = ANY($1::uuid[])", [[userId, otherUserId]]);
    await pool.query("DELETE FROM public.wordbooks WHERE id = ANY($1::uuid[])", [[wordbookId, otherWordbookId]]);
    await pool.query("DELETE FROM public.profiles WHERE id = ANY($1::uuid[])", [[userId, otherUserId]]);
    await pool.query("DELETE FROM public.users WHERE id = ANY($1::uuid[])", [[userId, otherUserId]]);
    await pool.query("DELETE FROM public.words WHERE id = $1::uuid", ["00000000-0000-4000-8000-000000000031"]);
    await pool.end();
    await resetPool();
  });

  it("publishes all repository database functions", async () => {
    const result = await pool.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = ANY($1::text[])
       ORDER BY p.proname`,
      [["get_or_create_today_session", "increment_session_cards_seen", "undo_review_log"]],
    );

    expect(result.rows.map((row) => row.signature)).toEqual([
      "get_or_create_today_session(uuid,uuid,text,timestamp with time zone)",
      "increment_session_cards_seen(uuid,uuid,uuid)",
      "undo_review_log(uuid,uuid,uuid,uuid)",
    ]);
  });

  it("stores only opaque browser-session digests and enforces token uniqueness", async () => {
    const tokenHash = "a".repeat(64);
    const csrfHash = "b".repeat(64);
    const inserted = await pool.query<{ token_hash: string; csrf_hash: string }>(
      `INSERT INTO public.auth_sessions (user_id, role, token_hash, csrf_hash, expires_at)
       VALUES ($1::uuid, 'owner', $2, $3, now() + interval '1 hour')
       RETURNING token_hash, csrf_hash`,
      [userId, tokenHash, csrfHash],
    );
    expect(inserted.rows[0]).toEqual({ token_hash: tokenHash, csrf_hash: csrfHash });
    await expect(pool.query(
      `INSERT INTO public.auth_sessions (user_id, role, token_hash, csrf_hash, expires_at)
       VALUES ($1::uuid, 'owner', $2, $3, now() + interval '1 hour')`,
      [userId, tokenHash, "c".repeat(64)],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("enforces outbox dedupe and lets concurrent workers claim disjoint events", async () => {
    const aggregateIds = [
      "00000000-0000-4000-8000-000000000041",
      "00000000-0000-4000-8000-000000000042",
      "00000000-0000-4000-8000-000000000043",
    ];
    await pool.query("DELETE FROM public.outbox_events WHERE aggregate_id = ANY($1::uuid[])", [aggregateIds]);
    for (const [index, aggregateId] of aggregateIds.entries()) {
      await pool.query(
        `INSERT INTO public.outbox_events
           (aggregate_type, aggregate_id, event_type, payload, dedupe_key)
         VALUES ('review_log', $1::uuid, 'review.answer.recorded.v1', '{}'::jsonb, $2)`,
        [aggregateId, `integration-outbox-${index}`],
      );
    }
    await expect(pool.query(
      `INSERT INTO public.outbox_events
         (aggregate_type, aggregate_id, event_type, payload, dedupe_key)
       VALUES ('review_log', $1::uuid, 'review.answer.recorded.v1', '{}'::jsonb, 'integration-outbox-0')`,
      [aggregateIds[0]],
    )).rejects.toMatchObject({ code: "23505" });

    const claim = async (workerId: string) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{ id: string }>(
          `WITH candidates AS (
             SELECT id FROM public.outbox_events
             WHERE dedupe_key LIKE 'integration-outbox-%'
               AND status = 'pending'
             ORDER BY created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 2
           )
           UPDATE public.outbox_events AS event
           SET status = 'processing', attempts = attempts + 1,
               locked_by = $1, locked_at = now(), locked_until = now() + interval '1 minute'
           FROM candidates
           WHERE event.id = candidates.id
           RETURNING event.id`,
          [workerId],
        );
        await client.query("COMMIT");
        return result.rows.map((row) => row.id);
      } finally {
        client.release();
      }
    };

    const [first, second] = await Promise.all([claim("worker-a"), claim("worker-b")]);
    expect(new Set([...first, ...second]).size).toBe(3);
    expect(first.length + second.length).toBe(3);
  });

  it("enforces effect receipt uniqueness and supports dead-letter replay", async () => {
    const aggregateId = "00000000-0000-4000-8000-000000000041";
    const event = await pool.query<{ id: string }>(
      `SELECT id FROM public.outbox_events WHERE aggregate_id = $1::uuid LIMIT 1`,
      [aggregateId],
    );
    const eventId = event.rows[0]!.id;
    await pool.query(
      `INSERT INTO public.outbox_effect_receipts (event_id, effect_name)
       VALUES ($1::uuid, 'session_cards_seen')`,
      [eventId],
    );
    await expect(pool.query(
      `INSERT INTO public.outbox_effect_receipts (event_id, effect_name)
       VALUES ($1::uuid, 'session_cards_seen')`,
      [eventId],
    )).rejects.toMatchObject({ code: "23505" });

    await pool.query(
      `UPDATE public.outbox_events
       SET status = 'dead_letter', attempts = max_attempts,
           locked_by = NULL, locked_at = NULL, locked_until = NULL
       WHERE id = $1::uuid`,
      [eventId],
    );
    const replay = await pool.query<{ status: string; attempts: number }>(
      `UPDATE public.outbox_events
       SET status = 'pending', attempts = 0, available_at = now(), last_error = NULL
       WHERE id = $1::uuid AND status = 'dead_letter'
       RETURNING status, attempts`,
      [eventId],
    );
    expect(replay.rows[0]).toEqual({ status: "pending", attempts: 0 });
  });

  it("processes a real review outbox event atomically and exactly once", async () => {
    await pool.query("DELETE FROM public.outbox_events WHERE dedupe_key LIKE 'integration-outbox-%' OR dedupe_key LIKE 'integration-worker:%'");
    const aggregateId = "00000000-0000-4000-8000-000000000043";
    const session = await pool.query<{ id: string }>(
      `SELECT id FROM public.get_or_create_today_session($1::uuid, $2::uuid, 'review', $3::timestamptz)`,
      [userId, wordbookId, "2026-07-10T00:00:00+08:00"],
    );
    const sessionId = session.rows[0]!.id;
    await pool.query("UPDATE public.sessions SET cards_seen = 0 WHERE id = $1::uuid", [sessionId]);
    await pool.query("DELETE FROM public.outbox_events WHERE aggregate_id = $1::uuid", [aggregateId]);
    const wordId = "00000000-0000-4000-8000-000000000033";
    const progressId = "00000000-0000-4000-8000-000000000034";
    await pool.query(
      `INSERT INTO public.words (id, slug, title, lemma, source_path, definition_md, body_md, content_hash)
       VALUES ($1::uuid, 'outbox-worker-test', 'outbox worker test', 'outbox worker test', 'integration/outbox.md', '', '', repeat('d', 64))
       ON CONFLICT (id) DO NOTHING`,
      [wordId],
    );
    await pool.query(
      `INSERT INTO public.wordbook_items (wordbook_id, word_id)
       VALUES ($1::uuid, $2::uuid)
       ON CONFLICT DO NOTHING`,
      [wordbookId, wordId],
    );
    await pool.query(
      `INSERT INTO public.user_word_progress
         (id, user_id, word_id, wordbook_id, state, review_count, last_rating, recent_ratings)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'review', 1, 'good', '["good"]'::jsonb)
       ON CONFLICT (id) DO UPDATE
       SET state = 'review', review_count = 1, last_rating = 'good', recent_ratings = '["good"]'::jsonb`,
      [progressId, userId, wordId, wordbookId],
    );

    const payload = {
      version: 1,
      reviewLogId: aggregateId,
      progressId,
      sessionId,
      userId,
      wordbookId,
      wordId,
    };
    await withTransaction(async (tx) => {
      await createRepositories(tx).outbox.enqueue({
        aggregateType: "review_log",
        aggregateId,
        eventType: "review.answer.recorded.v1",
        payload,
        dedupeKey: `integration-worker:${aggregateId}`,
      });
    });

    await pool.query("UPDATE public.sessions SET ended_at = now() WHERE id = $1::uuid", [sessionId]);

    const worker = new ReviewOutboxWorker(new OutboxRepository(), {
      workerId: "integration-worker",
      batchSize: 10,
      leaseSeconds: 60,
    });
    expect(await worker.processBatch()).toBeGreaterThanOrEqual(1);
    expect(await worker.processBatch()).toBe(0);

    const state = await pool.query<{ status: string; receipts: number; cards_seen: number }>(
      `SELECT e.status,
              (SELECT count(*)::int FROM public.outbox_effect_receipts r WHERE r.event_id = e.id) AS receipts,
              (SELECT cards_seen FROM public.sessions WHERE id = $2::uuid) AS cards_seen
       FROM public.outbox_events e
       WHERE e.aggregate_id = $1::uuid`,
      [aggregateId, sessionId],
    );
    expect(state.rows[0]).toEqual({ status: "processed", receipts: 3, cards_seen: 1 });
  });

  it("creates exactly one active daily session under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => pool.query<{ id: string }>(
        `SELECT id
         FROM public.get_or_create_today_session($1::uuid, $2::uuid, 'review', $3::timestamptz)`,
        [userId, wordbookId, "2026-07-10T00:00:00+08:00"],
      )),
    );

    expect(new Set(results.map((result) => result.rows[0]?.id)).size).toBe(1);
    const count = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM public.sessions
       WHERE user_id = $1::uuid
         AND wordbook_id = $2::uuid
         AND mode = 'review'
         AND ended_at IS NULL`,
      [userId, wordbookId],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("increments cards_seen atomically", async () => {
    const session = await pool.query<{ id: string }>(
      `SELECT id
       FROM public.get_or_create_today_session($1::uuid, $2::uuid, 'review', $3::timestamptz)`,
      [userId, wordbookId, "2026-07-10T00:00:00+08:00"],
    );
    const sessionId = session.rows[0]!.id;

    await pool.query("UPDATE public.sessions SET cards_seen = 0 WHERE id = $1::uuid", [sessionId]);
    await Promise.all(
      Array.from({ length: 40 }, () => pool.query(
        "SELECT public.increment_session_cards_seen($1::uuid, $2::uuid, $3::uuid)",
        [sessionId, userId, wordbookId],
      )),
    );

    const result = await pool.query<{ cards_seen: number }>(
      "SELECT cards_seen FROM public.sessions WHERE id = $1::uuid",
      [sessionId],
    );
    expect(result.rows[0]?.cards_seen).toBe(40);
  });

  it("rejects cross-user and cross-wordbook session counter updates", async () => {
    const session = await pool.query<{ id: string }>(
      `SELECT id
       FROM public.get_or_create_today_session($1::uuid, $2::uuid, 'review', $3::timestamptz)`,
      [userId, wordbookId, "2026-07-10T00:00:00+08:00"],
    );
    const sessionId = session.rows[0]!.id;
    await pool.query("UPDATE public.sessions SET cards_seen = 0 WHERE id = $1::uuid", [sessionId]);

    const wrongUser = await pool.query<{ updated: boolean }>(
      "SELECT public.increment_session_cards_seen($1::uuid, $2::uuid, $3::uuid) AS updated",
      [sessionId, otherUserId, wordbookId],
    );
    const wrongWordbook = await pool.query<{ updated: boolean }>(
      "SELECT public.increment_session_cards_seen($1::uuid, $2::uuid, $3::uuid) AS updated",
      [sessionId, userId, otherWordbookId],
    );

    expect(wrongUser.rows[0]?.updated).toBe(false);
    expect(wrongWordbook.rows[0]?.updated).toBe(false);
    const count = await pool.query<{ cards_seen: number }>(
      "SELECT cards_seen FROM public.sessions WHERE id = $1::uuid",
      [sessionId],
    );
    expect(count.rows[0]?.cards_seen).toBe(0);
  });

  it("enforces review-log Session owner and wordbook scope in the database", async () => {
    const session = await pool.query<{ id: string }>(
      `SELECT id
       FROM public.get_or_create_today_session($1::uuid, $2::uuid, 'review', $3::timestamptz)`,
      [userId, wordbookId, "2026-07-10T00:00:00+08:00"],
    );
    const sessionId = session.rows[0]!.id;
    const wordId = "00000000-0000-4000-8000-000000000031";
    await pool.query(
      `INSERT INTO public.words (id, slug, title, lemma, source_path, definition_md, body_md, content_hash)
       VALUES ($1::uuid, 'scope-test', 'scope test', 'scope test', 'integration/scope-test.md', '', '', repeat('a', 64))
       ON CONFLICT (id) DO NOTHING`,
      [wordId],
    );

    await expect(pool.query(
      `INSERT INTO public.review_logs
         (user_id, word_id, wordbook_id, session_id, state)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'review')`,
      [otherUserId, wordId, otherWordbookId, sessionId],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("enforces progress and review-log owner/wordbook scope without a Session", async () => {
    const wordId = "00000000-0000-4000-8000-000000000031";
    await pool.query(
      `INSERT INTO public.words (id, slug, title, lemma, source_path, definition_md, body_md, content_hash)
       VALUES ($1::uuid, 'scope-test', 'scope test', 'scope test', 'integration/scope-test.md', '', '', repeat('a', 64))
       ON CONFLICT (id) DO NOTHING`,
      [wordId],
    );
    await expect(pool.query(
      `INSERT INTO public.user_word_progress
         (user_id, word_id, wordbook_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [userId, wordId, otherWordbookId],
    )).rejects.toMatchObject({ code: "23503" });

    await expect(pool.query(
      `INSERT INTO public.review_logs
         (user_id, word_id, wordbook_id, session_id, state)
       VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, 'suspended')`,
      [userId, wordId, otherWordbookId],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("scopes undo to the review-log owner, wordbook, and active Session", async () => {
    const wordId = "00000000-0000-4000-8000-000000000031";
    const progressId = "00000000-0000-4000-8000-000000000041";
    const reviewLogId = "00000000-0000-4000-8000-000000000042";
    const session = await pool.query<{ id: string }>(
      `SELECT id
       FROM public.get_or_create_today_session($1::uuid, $2::uuid, 'review', $3::timestamptz)`,
      [userId, wordbookId, "2026-07-10T00:00:00+08:00"],
    );
    const sessionId = session.rows[0]!.id;
    await pool.query(
      `INSERT INTO public.words (id, slug, title, lemma, source_path, definition_md, body_md, content_hash)
       VALUES ($1::uuid, 'scope-test', 'scope test', 'scope test', 'integration/scope-test.md', '', '', repeat('a', 64))
       ON CONFLICT (id) DO NOTHING`,
      [wordId],
    );
    await pool.query(
      `INSERT INTO public.user_word_progress
         (id, user_id, word_id, wordbook_id, state, review_count)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'review', 5)
       ON CONFLICT (id) DO UPDATE SET state = 'review', review_count = 5`,
      [progressId, userId, wordId, wordbookId],
    );
    await pool.query(
      `INSERT INTO public.review_logs
         (id, user_id, word_id, wordbook_id, progress_id, session_id, rating, state, previous_progress_snapshot)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'good', 'review', $7::jsonb)
       ON CONFLICT (id) DO UPDATE SET undone = false, undone_at = NULL`,
      [reviewLogId, userId, wordId, wordbookId, progressId, sessionId, JSON.stringify({
        scheduler_payload: {}, state: "new", review_count: 0, lapse_count: 0,
        again_count: 0, hard_count: 0, good_count: 0, easy_count: 0,
        recent_ratings: [], l1_weak_signal: false,
      })],
    );

    const denied = await pool.query<{ out_success: boolean }>(
      "SELECT * FROM public.undo_review_log($1::uuid, $2::uuid, $3::uuid, $4::uuid)",
      [reviewLogId, otherUserId, otherWordbookId, sessionId],
    );
    expect(denied.rows[0]?.out_success).toBe(false);

    const allowed = await pool.query<{ out_success: boolean }>(
      "SELECT * FROM public.undo_review_log($1::uuid, $2::uuid, $3::uuid, $4::uuid)",
      [reviewLogId, userId, wordbookId, sessionId],
    );
    expect(allowed.rows[0]?.out_success).toBe(true);
    const restored = await pool.query<{ state: string; review_count: number; undone: boolean }>(
      `SELECT p.state, p.review_count, l.undone
       FROM public.user_word_progress p
       JOIN public.review_logs l ON l.progress_id = p.id
       WHERE p.id = $1::uuid AND l.id = $2::uuid`,
      [progressId, reviewLogId],
    );
    expect(restored.rows[0]).toEqual({ state: "new", review_count: 0, undone: true });
  });
});
