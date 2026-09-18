/**
 * 作文子空间 RLS 与数据库约束集成测试（W1，ADR《writing-workspace》§1/§2/§5）。
 *
 * Run（独立验收库 vocab_writing_test@127.0.0.1:5433；先 migrate + converge）：
 *   TEST_DATABASE_URL=<admin@vocab_writing_test> \
 *   TEST_APP_DATABASE_URL=<vocab_app@vocab_writing_test> \
 *   npx vitest run --config vitest.integration.config.ts tests/writing-rls.integration.test.ts
 *
 * 前置语义（与 tests/l3-rls.integration.test.ts 同一套基建）：
 * - TEST_DATABASE_URL     管理连接（表属主角色）——仅用于 seed/cleanup/库内核验；
 * - TEST_APP_DATABASE_URL 受限应用连接（vocab_app，NOBYPASSRLS 非属主）——RLS 强制生效。
 *
 * 覆盖：A/B 读写隔离（tasks/feedback）、冒名 WITH CHECK 拒、伪造 question/task/
 * sheet 关系被复合 FK 拒、单 task 双 draft 部分唯一、writing 一稿一 attempt 部分
 * 唯一、sealed 稿号唯一、CHECK 约束（scope 形状 / revision 语义 / venue）、
 * 旧 file/paper 插入不受扩展影响。
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetPool } from "@/db/connection";
import { withTransaction } from "@/db/transaction";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;

// Fail closed（同 l3-rls 先例）：缺接线必须报错而非静默跳过。
if (!adminDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required to seed the writing RLS fixture");
}
if (!appDatabaseUrl) {
  throw new Error("TEST_APP_DATABASE_URL is required for the restricted writing RLS session");
}

describe("Writing workspace RLS and constraints (integration)", () => {
  const ACTOR_A = randomUUID();
  const ACTOR_B = randomUUID();
  const QA = randomUUID();
  const QB = randomUUID();
  const SOURCE_A = randomUUID();
  const TASK_A = randomUUID();
  const DRAFT_A = randomUUID();
  const SEALED_A = randomUUID();
  const FILE_SHEET_A = randomUUID();
  const FEEDBACK_A = randomUUID();
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
  const ORIGINAL_POOL_MAX = process.env.DB_POOL_MAX;
  const adminPool = new Pool({ connectionString: adminDatabaseUrl, max: 1 });

  /** 受限应用角色事务（actor 上下文由 set_config 注入，RLS 据此判定）。 */
  async function inTx<T>(actorId: string, fn: (tx: import("pg").PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(async (tx) => fn(tx), { actorId });
  }

  beforeAll(async () => {
    await adminPool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)`,
      [ACTOR_A, `ws-rls-a-${ACTOR_A.slice(0, 8)}@example.test`, ACTOR_B, `ws-rls-b-${ACTOR_B.slice(0, 8)}@example.test`],
    );
    await adminPool.query(
      `INSERT INTO profiles (id, email) VALUES ($1, $2), ($3, $4)`,
      [ACTOR_A, `ws-rls-a-${ACTOR_A.slice(0, 8)}@example.test`, ACTOR_B, `ws-rls-b-${ACTOR_B.slice(0, 8)}@example.test`],
    );
    // 题库：A 的写作内部题与 B 的对照题（file_key 前缀 writing: 仅为语义标记）。
    await adminPool.query(
      `INSERT INTO l3_questions (id, user_id, file_key, space, question_type, stem)
       VALUES ($1, $2, $3, '作文', 'long_essay', '写作 RLS 题面 A'),
              ($4, $5, $6, '作文', 'long_essay', '写作 RLS 题面 B')`,
      [QA, ACTOR_A, `writing:${TASK_A}`, QB, ACTOR_B, `writing:${randomUUID()}`],
    );
    // A 的素材来源（file scope 回归用）。
    await adminPool.query(
      `INSERT INTO l3_sources (id, user_id, wordbook_id, source_type, title, language, metadata, content_text)
       VALUES ($1, $2, NULL, 'article', 'RLS 回归来源', 'en', '{}', 'Regression text for file scope.')`,
      [SOURCE_A, ACTOR_A],
    );
    // A 的任务 + draft 稿 + sealed 稿 + file 回归稿。
    await adminPool.query(
      `INSERT INTO l3_writing_tasks (id, user_id, question_id, title, kind, direction, create_request_id, create_input_hash)
       VALUES ($1, $2, $3, 'RLS 任务 A', 'free', '通用', $4, $5)`,
      [TASK_A, ACTOR_A, QA, randomUUID(), "hash-" + TASK_A.slice(0, 8)],
    );
    await adminPool.query(
      `INSERT INTO l3_submissions (id, user_id, scope, scope_key, writing_task_id, status, answers)
       VALUES ($1, $2, 'writing', $3, $4, 'draft', $5::jsonb)`,
      [DRAFT_A, ACTOR_A, `writing:${TASK_A}`, TASK_A, JSON.stringify({ [QA]: { text: "第一稿草稿" } })],
    );
    await adminPool.query(
      `INSERT INTO l3_submissions (id, user_id, scope, scope_key, writing_task_id, revision_no, status, seal_mode, sealed_at, answers)
       VALUES ($1, $2, 'writing', $3, $4, 1, 'sealed', 'full', now(), '{}'::jsonb)`,
      [SEALED_A, ACTOR_A, `writing:${TASK_A}`, TASK_A],
    );
    await adminPool.query(
      `INSERT INTO l3_submissions (id, user_id, scope, scope_key, source_id, question_type, status, answers)
       VALUES ($1, $2, 'file', $3, $4, 'long_essay', 'draft', '{}'::jsonb)`,
      [FILE_SHEET_A, ACTOR_A, `file:${SOURCE_A}:long_essay`, SOURCE_A],
    );
    // A 的 sealed 稿反馈。
    await adminPool.query(
      `INSERT INTO l3_writing_feedback (id, user_id, sheet_id, text_sha256, feedback, version, request_id, last_editor)
       VALUES ($1, $2, $3, $4, '{"schemaVersion":1}'::jsonb, 1, $5, 'owner')`,
      [FEEDBACK_A, ACTOR_A, SEALED_A, "a".repeat(64), randomUUID()],
    );

    await resetPool();
    process.env.DATABASE_URL = appDatabaseUrl!;
    process.env.DB_POOL_MAX = "1";
  });

  afterAll(async () => {
    try {
      await adminPool.query("DELETE FROM l3_writing_feedback WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_question_attempts WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_submissions WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_writing_tasks WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_questions WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_sources WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM profiles WHERE id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
    } finally {
      await resetPool();
      await adminPool.end();
      if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
      if (ORIGINAL_POOL_MAX === undefined) delete process.env.DB_POOL_MAX;
      else process.env.DB_POOL_MAX = ORIGINAL_POOL_MAX;
    }
  });

  it("owner B cannot read or write owner A's writing task (SELECT invisible / UPDATE no-op)", async () => {
    const read = await inTx(ACTOR_B, (tx) =>
      tx.query("SELECT id FROM l3_writing_tasks WHERE id = $1", [TASK_A]));
    expect(read.rows).toHaveLength(0);
    const update = await inTx(ACTOR_B, (tx) =>
      tx.query("UPDATE l3_writing_tasks SET title = '劫持' WHERE id = $1 RETURNING id", [TASK_A]));
    expect(update.rows).toHaveLength(0);
  });

  it("owner B cannot read owner A's feedback and B's UPDATE is a no-op", async () => {
    const read = await inTx(ACTOR_B, (tx) =>
      tx.query("SELECT id FROM l3_writing_feedback WHERE id = $1", [FEEDBACK_A]));
    expect(read.rows).toHaveLength(0);
    const update = await inTx(ACTOR_B, (tx) =>
      tx.query("UPDATE l3_writing_feedback SET version = 99 WHERE id = $1 RETURNING id", [FEEDBACK_A]));
    expect(update.rows).toHaveLength(0);
  });

  it("impersonation is rejected by RLS WITH CHECK (B inserting rows attributed to A)", async () => {
    await expect(inTx(ACTOR_B, (tx) =>
      tx.query(
        `INSERT INTO l3_writing_tasks (id, user_id, question_id, title, kind, direction, create_request_id, create_input_hash)
         VALUES ($1, $2, $3, '冒名', 'free', '通用', $4, 'x')`,
        [randomUUID(), ACTOR_A, QA, randomUUID()],
      ))).rejects.toThrow(/row-level security/i);
    await expect(inTx(ACTOR_B, (tx) =>
      tx.query(
        `INSERT INTO l3_writing_feedback (id, user_id, sheet_id, text_sha256, feedback, version, request_id, last_editor)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, 1, $5, 'agent-b')`,
        [randomUUID(), ACTOR_A, SEALED_A, "b".repeat(64), randomUUID()],
      ))).rejects.toThrow(/row-level security/i);
  });

  it("forged relations are rejected by composite owner FKs (B's task→A's question; B's feedback→A's sheet)", async () => {
    // B 自建任务但挂 A 的题：复合 FK (question_id,user_id) 失败。
    await expect(inTx(ACTOR_B, (tx) =>
      tx.query(
        `INSERT INTO l3_writing_tasks (id, user_id, question_id, title, kind, direction, create_request_id, create_input_hash)
         VALUES ($1, $2, $3, '伪造', 'free', '通用', $4, 'x')`,
        [randomUUID(), ACTOR_B, QA, randomUUID()],
      ))).rejects.toThrow(/foreign key|violates/i);
    // B 的反馈指向 A 的稿：复合 FK (sheet_id,user_id) 失败。
    await expect(inTx(ACTOR_B, (tx) =>
      tx.query(
        `INSERT INTO l3_writing_feedback (id, user_id, sheet_id, text_sha256, feedback, version, request_id, last_editor)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, 1, $5, 'agent-b')`,
        [randomUUID(), ACTOR_B, SEALED_A, "c".repeat(64), randomUUID()],
      ))).rejects.toThrow(/foreign key|violates/i);
    // B 的 writing 稿挂 A 的任务：复合 FK 失败。
    await expect(inTx(ACTOR_B, (tx) =>
      tx.query(
        `INSERT INTO l3_submissions (id, user_id, scope, scope_key, writing_task_id, status, answers)
         VALUES ($1, $2, 'writing', $3, $4, 'draft', '{}'::jsonb)`,
        [randomUUID(), ACTOR_B, `writing:${TASK_A}`, TASK_A],
      ))).rejects.toThrow(/foreign key|violates/i);
  });

  it("a second draft for the same task violates the draft partial unique index", async () => {
    await expect(inTx(ACTOR_A, (tx) =>
      tx.query(
        `INSERT INTO l3_submissions (id, user_id, scope, scope_key, writing_task_id, status, answers)
         VALUES ($1, $2, 'writing', $3, $4, 'draft', '{}'::jsonb)`,
        [randomUUID(), ACTOR_A, `writing:${TASK_A}`, TASK_A],
      ))).rejects.toThrow(/duplicate key|unique/i);
  });

  it("a second sealed sheet with the same revision number violates the revision unique constraint", async () => {
    await expect(inTx(ACTOR_A, (tx) =>
      tx.query(
        `INSERT INTO l3_submissions (id, user_id, scope, scope_key, writing_task_id, revision_no, status, seal_mode, sealed_at, answers)
         VALUES ($1, $2, 'writing', $3, $4, 1, 'sealed', 'full', now(), '{}'::jsonb)`,
        [randomUUID(), ACTOR_A, `writing:${TASK_A}`, TASK_A],
      ))).rejects.toThrow(/duplicate key|unique/i);
  });

  it("a second writing attempt on the same sheet violates the writing partial unique index", async () => {
    await inTx(ACTOR_A, (tx) =>
      tx.query(
        `INSERT INTO l3_question_attempts (id, user_id, question_id, sheet_id, venue, answer)
         VALUES ($1, $2, $3, $4, 'writing', $5::jsonb)`,
        [randomUUID(), ACTOR_A, QA, SEALED_A, JSON.stringify({ text: "正文一" })],
      ));
    await expect(inTx(ACTOR_A, (tx) =>
      tx.query(
        `INSERT INTO l3_question_attempts (id, user_id, question_id, sheet_id, venue, answer)
         VALUES ($1, $2, $3, $4, 'writing', $5::jsonb)`,
        [randomUUID(), ACTOR_A, QA, SEALED_A, JSON.stringify({ text: "正文二" })],
      ))).rejects.toThrow(/duplicate key|unique/i);
  });

  it("legacy file/paper rows still insert and keep multi-attempt semantics (extensions are writing-only)", async () => {
    // file 稿已在上文 seed 成功即为证据；再补两个 file-venue attempts（同 sheet 多行合法，
    // 部分唯一索引只覆盖 writing）。
    await inTx(ACTOR_A, (tx) =>
      tx.query(
        `INSERT INTO l3_question_attempts (id, user_id, question_id, sheet_id, venue, answer)
         VALUES ($1, $2, $3, $4, 'file', '{}'::jsonb), ($5, $2, $3, $4, 'file', '{}'::jsonb)`,
        [randomUUID(), ACTOR_A, QA, FILE_SHEET_A, randomUUID()],
      ));
    const count = await adminPool.query<{ n: string }>(
      "SELECT count(*) AS n FROM l3_question_attempts WHERE sheet_id = $1 AND venue = 'file'",
      [FILE_SHEET_A],
    );
    expect(Number(count.rows[0]!.n)).toBe(2);
  });

  it("CHECK constraints reject illegal writing rows (no task / revision semantics / venue)", async () => {
    // writing 稿缺 task。
    await expect(inTx(ACTOR_A, (tx) =>
      tx.query(
        `INSERT INTO l3_submissions (id, user_id, scope, scope_key, status, answers)
         VALUES ($1, $2, 'writing', $3, 'draft', '{}'::jsonb)`,
        [randomUUID(), ACTOR_A, `writing:${randomUUID()}`],
      ))).rejects.toThrow(/check|violates/i);
    // sealed writing 缺 revision_no。
    await expect(inTx(ACTOR_A, (tx) =>
      tx.query(
        `INSERT INTO l3_submissions (id, user_id, scope, scope_key, writing_task_id, status, seal_mode, sealed_at, answers)
         VALUES ($1, $2, 'writing', $3, $4, 'sealed', 'full', now(), '{}'::jsonb)`,
        [randomUUID(), ACTOR_A, `writing:${TASK_A}`, TASK_A],
      ))).rejects.toThrow(/check|violates|duplicate/i);
    // draft writing 不得带 revision_no。
    await expect(inTx(ACTOR_A, (tx) =>
      tx.query(
        `INSERT INTO l3_submissions (id, user_id, scope, scope_key, writing_task_id, revision_no, status, answers)
         VALUES ($1, $2, 'writing', $3, $4, 7, 'draft', '{}'::jsonb)`,
        [randomUUID(), ACTOR_A, `writing:${randomUUID()}`, TASK_A],
      ))).rejects.toThrow(/check|violates/i);
    // 非法 venue。
    await expect(inTx(ACTOR_A, (tx) =>
      tx.query(
        `INSERT INTO l3_question_attempts (id, user_id, question_id, venue, answer)
         VALUES ($1, $2, $3, 'bogus', '{}'::jsonb)`,
        [randomUUID(), ACTOR_A, QA],
      ))).rejects.toThrow(/check|violates/i);
    // 非 writing 行携带 writing 元数据。
    await expect(inTx(ACTOR_A, (tx) =>
      tx.query(
        `INSERT INTO l3_submissions (id, user_id, scope, scope_key, source_id, question_type, writing_task_id, status, answers)
         VALUES ($1, $2, 'file', $3, $4, 'long_essay', $5, 'draft', '{}'::jsonb)`,
        [randomUUID(), ACTOR_A, `file:${SOURCE_A}:long_essay`, SOURCE_A, TASK_A],
      ))).rejects.toThrow(/check|violates|duplicate/i);
  });

  it("owner A can write its own task/sheet/feedback through the restricted role (positive control)", async () => {
    await inTx(ACTOR_A, (tx) =>
      tx.query("UPDATE l3_writing_tasks SET title = 'RLS 任务 A（改）' WHERE id = $1", [TASK_A]));
    const after = await adminPool.query<{ title: string }>(
      "SELECT title FROM l3_writing_tasks WHERE id = $1",
      [TASK_A],
    );
    expect(after.rows[0]!.title).toBe("RLS 任务 A（改）");
  });
});
