/**
 * 作文正文清理 × 反馈写入并发集成测试（W9，S§7）——真实 PostgreSQL 两连接可控屏障。
 *
 * Run（独立验收库；勿改库结构）：
 *   TEST_DATABASE_URL="<表属主@vocab_writing_test>" \
 *   TEST_APP_DATABASE_URL="<vocab_app@vocab_writing_test>" \
 *   DB_SSLMODE=disable npx vitest run --config vitest.integration.config.ts tests/writing-cleanup.integration.test.ts
 *
 * 覆盖：
 * A. 反馈写入先持锁（在途）→ 清理阻塞 → 提交后清理继续 → **反馈被同事务删除**、
 *    attempt 软删，最终无残留摘要；清理后 feedback/context/export 全部 409 且不泄漏。
 * B. 清理先持锁（在途）→ 反馈写入阻塞 → 提交后写入看到正文已清理 → 409
 *    WRITING_CONTENT_CLEARED，**不得写入反馈**。
 * 断言均为 admin 直查库 + 服务调用；禁止以顺序调用或 mock 代替并发证据。
 */
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetPool } from "@/db/connection";
import { L3WritingExportService } from "@/services/l3-writing-export.service";
import { L3WritingFeedbackService } from "@/services/l3-writing-feedback.service";
import { L3WritingSheetService } from "@/services/l3-writing-sheet.service";
import { L3WritingTaskService } from "@/services/l3-writing-task.service";
import { sha256WritingText } from "@/services/l3-writing-text";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;

if (!adminDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required to seed the writing cleanup fixture");
}
if (!appDatabaseUrl) {
  throw new Error("TEST_APP_DATABASE_URL is required for the restricted writing cleanup session");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function feedbackPayload(summary: string) {
  return {
    schemaVersion: 1 as const,
    summary,
    strengths: ["立场明确"],
    dimensions: {
      task_response: { applicable: true, comment: "回应了题目。" },
      organization: { applicable: true, comment: "结构可辨。" },
      language: { applicable: true, comment: "基本通顺。" },
      expression: { applicable: false, comment: "本稿不评表达风格。" },
    },
    priorities: [],
  };
}

describe("Writing content cleanup × feedback concurrency (integration)", () => {
  const ACTOR_A = randomUUID();
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
  const ORIGINAL_POOL_MAX = process.env.DB_POOL_MAX;
  const adminPool = new Pool({ connectionString: adminDatabaseUrl, max: 2 });
  const barrierPool = new Pool({ connectionString: appDatabaseUrl!, max: 2 });
  const taskService = new L3WritingTaskService();
  const sheetService = new L3WritingSheetService();
  const feedbackService = new L3WritingFeedbackService();
  const exportService = new L3WritingExportService();

  async function actorClient(actorId: string): Promise<PoolClient> {
    const client = await barrierPool.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [actorId]);
    return client;
  }

  /** 服务化建任务 → 保存 → 提交（返回 sealed 稿与正文 hash）。 */
  async function createSealedRevision(text: string) {
    const result = await taskService.create(ACTOR_A, {
      requestId: randomUUID(),
      kind: "free",
      direction: "通用",
      forceNew: false,
    });
    if (!result.draft) throw new Error("expected first draft");
    await sheetService.saveDraft(ACTOR_A, result.task.id, result.draft.id, { expectedVersion: 0, text });
    const sealed = await sheetService.submit(ACTOR_A, result.task.id, result.draft.id, { expectedVersion: 1 });
    return { task: result.task, sheetId: sealed.sheet.id, textSha256: sha256WritingText(text) };
  }

  async function contentState(sheetId: string): Promise<{ attemptStatus: string | null; feedbackCount: number }> {
    const attempt = await adminPool.query<{ status: string }>(
      "SELECT status FROM l3_question_attempts WHERE sheet_id = $1 AND venue = 'writing' ORDER BY created_at DESC LIMIT 1",
      [sheetId],
    );
    const feedback = await adminPool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM l3_writing_feedback WHERE sheet_id = $1",
      [sheetId],
    );
    return { attemptStatus: attempt.rows[0]?.status ?? null, feedbackCount: feedback.rows[0]!.c };
  }

  beforeAll(async () => {
    await adminPool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)`,
      [ACTOR_A, `ws-cleanup-${ACTOR_A.slice(0, 8)}@example.test`],
    );
    await adminPool.query(
      `INSERT INTO profiles (id, email) VALUES ($1, $2)`,
      [ACTOR_A, `ws-cleanup-${ACTOR_A.slice(0, 8)}@example.test`],
    );
    await resetPool();
    process.env.DATABASE_URL = appDatabaseUrl!;
    process.env.DB_POOL_MAX = "2";
  });

  afterAll(async () => {
    try {
      await adminPool.query("DELETE FROM l3_writing_feedback WHERE user_id = $1::uuid", [ACTOR_A]);
      await adminPool.query("DELETE FROM l3_question_attempts WHERE user_id = $1::uuid", [ACTOR_A]);
      await adminPool.query("DELETE FROM l3_submissions WHERE user_id = $1::uuid", [ACTOR_A]);
      await adminPool.query("DELETE FROM l3_writing_tasks WHERE user_id = $1::uuid", [ACTOR_A]);
      await adminPool.query("DELETE FROM l3_questions WHERE user_id = $1::uuid", [ACTOR_A]);
      await adminPool.query("DELETE FROM profiles WHERE id = $1::uuid", [ACTOR_A]);
      await adminPool.query("DELETE FROM users WHERE id = $1::uuid", [ACTOR_A]);
    } finally {
      await resetPool();
      await barrierPool.end();
      await adminPool.end();
      if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
      if (ORIGINAL_POOL_MAX === undefined) delete process.env.DB_POOL_MAX;
      else process.env.DB_POOL_MAX = ORIGINAL_POOL_MAX;
    }
  });

  it("A. 反馈写入先持锁 → 清理阻塞后继续 → 反馈被同事务删除（无残留）", async () => {
    const text = "清理并发稿甲";
    const { task, sheetId, textSha256 } = await createSealedRevision(text);

    // 屏障：模拟“反馈写入”在途——按服务锁序持 task→sheet 锁，并写入反馈行（未提交）。
    const client = await actorClient(ACTOR_A);
    await client.query(`SELECT id FROM l3_writing_tasks WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`, [task.id, ACTOR_A]);
    await client.query(`SELECT * FROM l3_submissions WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`, [sheetId, ACTOR_A]);
    await client.query(
      `INSERT INTO l3_writing_feedback (user_id, sheet_id, text_sha256, feedback, version, request_id, last_editor)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, 1, $5::uuid, 'agent-a')`,
      [ACTOR_A, sheetId, textSha256, JSON.stringify(feedbackPayload("在途反馈")), randomUUID()],
    );

    // 并行清理：应在 task 锁上阻塞，直到屏障提交。
    const clearPromise = sheetService.clearRevisionContent(ACTOR_A, task.id, sheetId);
    await sleep(200);
    await client.query("COMMIT");
    client.release();

    const cleared = await clearPromise;
    expect(cleared.status).toBe("sealed"); // 清理不是状态迁移

    // 库核（admin 直查）：attempt 软删 + 反馈 0 行（同事务删除，无残留摘要）。
    const state = await contentState(sheetId);
    expect(state.attemptStatus).toBe("deleted");
    expect(state.feedbackCount).toBe(0);

    // 清理后：feedback / context / export 全部 409 且不泄漏；列表派生 unavailable。
    await expect(feedbackService.getFeedback(ACTOR_A, task.id, sheetId)).rejects.toMatchObject({
      httpStatus: 409, meta: { code: "WRITING_CONTENT_CLEARED" },
    });
    await expect(feedbackService.getContext(ACTOR_A, task.id, sheetId)).rejects.toMatchObject({
      httpStatus: 409, meta: { code: "WRITING_CONTENT_CLEARED" },
    });
    await expect(exportService.exportSheet(ACTOR_A, task.id, sheetId)).rejects.toMatchObject({
      httpStatus: 409, meta: { code: "WRITING_CONTENT_CLEARED" },
    });
    const revisions = await sheetService.listRevisions(ACTOR_A, task.id, { limit: 20 });
    const item = revisions.items.find((entry) => entry.sheet.id === sheetId)!;
    expect(item.contentStatus).toBe("cleared");
    expect(item.feedbackState).toBe("unavailable");
  });

  it("B. 清理先持锁 → 反馈写入阻塞后 409，不得写入反馈", async () => {
    const text = "清理并发稿乙";
    const { task, sheetId, textSha256 } = await createSealedRevision(text);

    // 屏障：模拟“清理”在途——持 task→sheet 锁并执行清理效果（未提交）。
    const client = await actorClient(ACTOR_A);
    await client.query(`SELECT id FROM l3_writing_tasks WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`, [task.id, ACTOR_A]);
    await client.query(`SELECT * FROM l3_submissions WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`, [sheetId, ACTOR_A]);
    await client.query(
      `UPDATE l3_question_attempts SET status = 'deleted', deleted_at = now()
        WHERE user_id = $1::uuid AND sheet_id = $2::uuid AND venue = 'writing' AND status = 'active'`,
      [ACTOR_A, sheetId],
    );
    await client.query(
      `DELETE FROM l3_writing_feedback WHERE user_id = $1::uuid AND sheet_id = $2::uuid`,
      [ACTOR_A, sheetId],
    );

    // 并行反馈写入：应在 task 锁上阻塞，直到屏障提交；随后看到正文已清理 → 409。
    const putPromise = feedbackService.putFeedback(ACTOR_A, task.id, sheetId, {
      expectedVersion: 0,
      textSha256,
      requestId: randomUUID(),
      feedback: feedbackPayload("迟到的反馈"),
    }, "agent-a");
    await sleep(200);
    await client.query("COMMIT");
    client.release();

    await expect(putPromise).rejects.toMatchObject({
      httpStatus: 409,
      meta: { code: "WRITING_CONTENT_CLEARED" },
    });

    // 库核：attempt deleted + 反馈 0 行（迟到写入不得落库）。
    const state = await contentState(sheetId);
    expect(state.attemptStatus).toBe("deleted");
    expect(state.feedbackCount).toBe(0);
  });
});
