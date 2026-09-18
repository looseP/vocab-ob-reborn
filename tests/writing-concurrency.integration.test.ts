/**
 * 作文稿件生命周期并发集成测试（W3，S§4）——真实 PostgreSQL + 可控两连接屏障。
 *
 * Run（独立验收库；先 migrate + converge，勿改库结构）：
 *   TEST_DATABASE_URL="<表属主角色@vocab_writing_test>" \
 *   TEST_APP_DATABASE_URL="<vocab_app@vocab_writing_test>" \
 *   DB_SSLMODE=disable npx vitest run --config vitest.integration.config.ts tests/writing-concurrency.integration.test.ts
 *
 * 覆盖（屏障用独立 app 角色连接 + set_config actor 重现生产事务环境）：
 * D1 保存先落（未提交）→ 旧版本 submit 阻塞后 409，不出现「旧正文被定格」；
 * D2 提交先落（锁 task + seal 未提交）→ 迟到的保存 409，不静默覆盖丢失；
 * 重复 submit 幂等（同 attempt、单行、稿号不重）；并发 createDraft 只建一稿；
 * 跨 owner 全部 404；discard→submit 409；sealed→save 409。
 */
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetPool } from "@/db/connection";
import { evaluateSubmitPrecheck } from "@/frontend/state/writingSubmitBarrier";
import { L3WritingSheetService } from "@/services/l3-writing-sheet.service";
import { L3WritingTaskService } from "@/services/l3-writing-task.service";
import { L3WritingFeedbackService } from "@/services/l3-writing-feedback.service";
import { sha256WritingText } from "@/services/l3-writing-text";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;

// Fail closed（同 writing-rls 先例）：缺接线必须报错而非静默跳过。
if (!adminDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required to seed the writing concurrency fixture");
}
if (!appDatabaseUrl) {
  throw new Error("TEST_APP_DATABASE_URL is required for the restricted writing concurrency session");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Writing lifecycle concurrency (integration)", () => {
  const ACTOR_A = randomUUID();
  const ACTOR_B = randomUUID();
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
  const ORIGINAL_POOL_MAX = process.env.DB_POOL_MAX;
  const adminPool = new Pool({ connectionString: adminDatabaseUrl, max: 2 });
  const barrierPool = new Pool({ connectionString: appDatabaseUrl!, max: 2 });
  const taskService = new L3WritingTaskService();
  const sheetService = new L3WritingSheetService();
  const feedbackService = new L3WritingFeedbackService();

  /** 独立 app 角色连接 + actor 注入（与 withTransaction 同键），用于可控屏障。 */
  async function actorClient(actorId: string): Promise<PoolClient> {
    const client = await barrierPool.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [actorId]);
    return client;
  }

  /** 服务化建任务（自由写作）：返回首稿。 */
  async function createTask(actorId: string) {
    const result = await taskService.create(actorId, {
      requestId: randomUUID(),
      kind: "free",
      direction: "通用",
      forceNew: false,
    });
    if (!result.draft) throw new Error("expected first draft on creation");
    return { task: result.task, draft: result.draft, questionId: result.task.questionId };
  }

  beforeAll(async () => {
    await adminPool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)`,
      [ACTOR_A, `ws-conc-a-${ACTOR_A.slice(0, 8)}@example.test`, ACTOR_B, `ws-conc-b-${ACTOR_B.slice(0, 8)}@example.test`],
    );
    await adminPool.query(
      `INSERT INTO profiles (id, email) VALUES ($1, $2), ($3, $4)`,
      [ACTOR_A, `ws-conc-a-${ACTOR_A.slice(0, 8)}@example.test`, ACTOR_B, `ws-conc-b-${ACTOR_B.slice(0, 8)}@example.test`],
    );

    await resetPool();
    process.env.DATABASE_URL = appDatabaseUrl!;
    process.env.DB_POOL_MAX = "2";
  });

  afterAll(async () => {
    try {
      await adminPool.query("DELETE FROM l3_writing_feedback WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_question_attempts WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_submissions WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_writing_tasks WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_questions WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM profiles WHERE id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
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

  it("D1 屏障：保存先落（未提交）→ 旧版本 submit 阻塞后 409，绝不出现旧正文定格", async () => {
    const { task, draft, questionId } = await createTask(ACTOR_A);

    // 屏障：模拟“保存”在途——锁 sheet 行并写入新正文 v1（未提交）。
    const client = await actorClient(ACTOR_A);
    await client.query(`SELECT * FROM l3_submissions WHERE id = $1::uuid FOR UPDATE`, [draft.id]);
    await client.query(
      `UPDATE l3_submissions
          SET answers = $2::jsonb, draft_version = draft_version + 1, updated_at = now()
        WHERE id = $1::uuid AND status = 'draft' AND draft_version = 0`,
      [draft.id, JSON.stringify({ [questionId]: { text: "新正文v1" } })],
    );

    // 并行 submit（expectedVersion=0）：在 sheet 锁上阻塞，直到屏障提交。
    const submitPromise = sheetService.submit(ACTOR_A, task.id, draft.id, { expectedVersion: 0 });
    await sleep(200);
    await client.query("COMMIT");
    client.release();

    await expect(submitPromise).rejects.toMatchObject({
      httpStatus: 409,
      meta: { code: "DRAFT_VERSION_CONFLICT" },
    });

    // 库核：稿仍 draft、正文=新保存的 v1、无 attempt（旧版本没有定格）。
    const row = await adminPool.query<{ status: string; draft_version: number; answers: Record<string, { text: string }> }>(
      "SELECT status, draft_version, answers FROM l3_submissions WHERE id = $1",
      [draft.id],
    );
    expect(row.rows[0]!.status).toBe("draft");
    expect(row.rows[0]!.draft_version).toBe(1);
    expect(row.rows[0]!.answers[questionId]!.text).toBe("新正文v1");
    const attempts = await adminPool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM l3_question_attempts WHERE sheet_id = $1",
      [draft.id],
    );
    expect(attempts.rows[0]!.c).toBe(0);
  });

  it("D2 屏障：提交先落（锁 task + seal 未提交）→ 迟到的保存 409，不静默覆盖丢失", async () => {
    const { task, draft, questionId } = await createTask(ACTOR_A);
    await sheetService.saveDraft(ACTOR_A, task.id, draft.id, { expectedVersion: 0, text: "定稿正文" });

    // 屏障：模拟“提交”在途——锁 task 行，物化 attempt 并 seal（未提交）。
    const client = await actorClient(ACTOR_A);
    await client.query(`SELECT id FROM l3_writing_tasks WHERE id = $1::uuid FOR UPDATE`, [task.id]);
    await client.query(
      `INSERT INTO l3_question_attempts (user_id, question_id, sheet_id, venue, answer)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'writing', $4::jsonb)`,
      [ACTOR_A, questionId, draft.id, JSON.stringify({ text: "定稿正文" })],
    );
    await client.query(
      `UPDATE l3_submissions
          SET answers = '{}'::jsonb, status = 'sealed', seal_mode = 'full', sealed_at = now(),
              revision_no = 1, draft_version = draft_version + 1, updated_at = now()
        WHERE id = $1::uuid AND status = 'draft'`,
      [draft.id],
    );

    // 并行保存（expectedVersion=1）：在 task 锁上阻塞，直到屏障提交。
    const savePromise = sheetService.saveDraft(ACTOR_A, task.id, draft.id, {
      expectedVersion: 1,
      text: "迟到的修改",
    });
    await sleep(200);
    await client.query("COMMIT");
    client.release();

    await expect(savePromise).rejects.toMatchObject({ httpStatus: 409 });

    // 库核：已 sealed、正文事实=定稿正文（迟到保存未落任何字节）。
    const row = await adminPool.query<{ status: string; revision_no: number; answers: Record<string, unknown> }>(
      "SELECT status, revision_no, answers FROM l3_submissions WHERE id = $1",
      [draft.id],
    );
    expect(row.rows[0]!.status).toBe("sealed");
    expect(row.rows[0]!.revision_no).toBe(1);
    expect(row.rows[0]!.answers).toEqual({});
    const attempt = await adminPool.query<{ answer: { text: string } }>(
      "SELECT answer FROM l3_question_attempts WHERE sheet_id = $1 AND status = 'active'",
      [draft.id],
    );
    expect(attempt.rows[0]!.answer.text).toBe("定稿正文");
  });

  it("重复 submit 幂等：同 attemptId、attempt 单行、稿号不重", async () => {
    const { task, draft } = await createTask(ACTOR_A);
    await sheetService.saveDraft(ACTOR_A, task.id, draft.id, { expectedVersion: 0, text: "终稿" });
    const first = await sheetService.submit(ACTOR_A, task.id, draft.id, { expectedVersion: 1 });
    const second = await sheetService.submit(ACTOR_A, task.id, draft.id, { expectedVersion: 1 });
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.sheet.revisionNo).toBe(1);

    const attempts = await adminPool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM l3_question_attempts WHERE sheet_id = $1",
      [draft.id],
    );
    expect(attempts.rows[0]!.c).toBe(1);
    const sheets = await adminPool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM l3_submissions WHERE writing_task_id = $1 AND status = 'sealed'",
      [task.id],
    );
    expect(sheets.rows[0]!.c).toBe(1);
  });

  it("并发 createDraft（同 parent）：task 锁串行化，只建一稿", async () => {
    const { task, draft, questionId } = await createTask(ACTOR_A);
    await sheetService.saveDraft(ACTOR_A, task.id, draft.id, { expectedVersion: 0, text: "第一稿终稿" });
    const sealed = await sheetService.submit(ACTOR_A, task.id, draft.id, { expectedVersion: 1 });

    const [c1, c2] = await Promise.all([
      sheetService.createDraft(ACTOR_A, task.id, { parentSheetId: sealed.sheet.id, seed: "copy" }),
      sheetService.createDraft(ACTOR_A, task.id, { parentSheetId: sealed.sheet.id, seed: "copy" }),
    ]);
    expect(c1.sheet.id).toBe(c2.sheet.id);
    expect([c1.created, c2.created].sort()).toEqual([false, true]);

    const drafts = await adminPool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM l3_submissions WHERE writing_task_id = $1 AND status = 'draft'",
      [task.id],
    );
    expect(drafts.rows[0]!.c).toBe(1);
    const copy = await adminPool.query<{ answers: Record<string, { text: string }> }>(
      "SELECT answers FROM l3_submissions WHERE id = $1",
      [c1.sheet.id],
    );
    expect(copy.rows[0]!.answers[questionId]!.text).toBe("第一稿终稿");
  });

  it("跨 owner 隔离：B 读/存/提交 A 的稿全部 404", async () => {
    const { task, draft } = await createTask(ACTOR_A);
    await expect(sheetService.getSheet(ACTOR_B, task.id, draft.id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(sheetService.saveDraft(ACTOR_B, task.id, draft.id, { expectedVersion: 0, text: "x" }))
      .rejects.toMatchObject({ httpStatus: 404 });
    await expect(sheetService.submit(ACTOR_B, task.id, draft.id, { expectedVersion: 0 }))
      .rejects.toMatchObject({ httpStatus: 404 });
  });

  it("discard→submit 409；sealed→save 409（真库终态守卫）", async () => {
    const a = await createTask(ACTOR_A);
    await sheetService.saveDraft(ACTOR_A, a.task.id, a.draft.id, { expectedVersion: 0, text: "要丢弃的稿" });
    await sheetService.discard(ACTOR_A, a.task.id, a.draft.id, { expectedVersion: 1 });
    await expect(sheetService.submit(ACTOR_A, a.task.id, a.draft.id, { expectedVersion: 1 }))
      .rejects.toMatchObject({ httpStatus: 409 });

    const b = await createTask(ACTOR_A);
    await sheetService.saveDraft(ACTOR_A, b.task.id, b.draft.id, { expectedVersion: 0, text: "终稿" });
    await sheetService.submit(ACTOR_A, b.task.id, b.draft.id, { expectedVersion: 1 });
    await expect(sheetService.saveDraft(ACTOR_A, b.task.id, b.draft.id, { expectedVersion: 2, text: "不该落" }))
      .rejects.toMatchObject({ httpStatus: 409 });
  });

  it("反馈并发：相同 expectedVersion 两 writer 只有一个成功；重放同 request 不升版", async () => {
    const { task, draft } = await createTask(ACTOR_A);
    await sheetService.saveDraft(ACTOR_A, task.id, draft.id, { expectedVersion: 0, text: "终稿正文" });
    const sealed = await sheetService.submit(ACTOR_A, task.id, draft.id, { expectedVersion: 1 });

    const textSha256 = sha256WritingText("终稿正文");
    const r1 = randomUUID();
    const r2 = randomUUID();
    const payload = {
      schemaVersion: 1 as const,
      summary: "结构清楚。",
      strengths: ["立场明确"],
      dimensions: {
        task_response: { applicable: true, comment: "回应了题目。" },
        organization: { applicable: true, comment: "结构可辨。" },
        language: { applicable: true, comment: "基本通顺。" },
        expression: { applicable: false, comment: "本稿不评表达风格。" },
      },
      priorities: [],
    };

    const [p1, p2] = await Promise.allSettled([
      feedbackService.putFeedback(ACTOR_A, task.id, sealed.sheet.id, {
        expectedVersion: 0, textSha256, requestId: r1, feedback: payload,
      }, "agent-a"),
      feedbackService.putFeedback(ACTOR_A, task.id, sealed.sheet.id, {
        expectedVersion: 0, textSha256, requestId: r2, feedback: payload,
      }, "agent-b"),
    ]);
    const oks = [p1, p2].filter((r) => r.status === "fulfilled");
    const failed = [p1, p2].filter((r) => r.status === "rejected");
    expect(oks).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      httpStatus: 409,
      meta: { code: "FEEDBACK_VERSION_CONFLICT" },
    });

    // 重放获胜请求（同 requestId 同内容）→ 200 且版本不变。
    const winnerRequest = p1.status === "fulfilled" ? r1 : r2;
    const replay = await feedbackService.putFeedback(ACTOR_A, task.id, sealed.sheet.id, {
      expectedVersion: 0, textSha256, requestId: winnerRequest, feedback: payload,
    }, "agent-a");
    expect(replay.version).toBe(1);

    // 新请求但版本落后 → 409。
    await expect(feedbackService.putFeedback(ACTOR_A, task.id, sealed.sheet.id, {
      expectedVersion: 0, textSha256, requestId: randomUUID(), feedback: payload,
    }, "agent-a")).rejects.toMatchObject({ httpStatus: 409, meta: { code: "FEEDBACK_VERSION_CONFLICT" } });

    const rows = await adminPool.query<{ c: number; v: number }>(
      "SELECT count(*)::int AS c, max(version)::int AS v FROM l3_writing_feedback WHERE sheet_id = $1",
      [sealed.sheet.id],
    );
    expect(rows.rows[0]!.c).toBe(1);
    expect(rows.rows[0]!.v).toBe(1);
  });

  it("反馈更新并发：已有反馈上两 writer 相同 expectedVersion 只有一个成功，最终版本正确", async () => {
    const { task, draft } = await createTask(ACTOR_A);
    await sheetService.saveDraft(ACTOR_A, task.id, draft.id, { expectedVersion: 0, text: "更新并发稿" });
    const sealed = await sheetService.submit(ACTOR_A, task.id, draft.id, { expectedVersion: 1 });
    const textSha256 = sha256WritingText("更新并发稿");
    const payload = (summary: string) => ({
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
    });

    // 首写 → version 1。
    await feedbackService.putFeedback(ACTOR_A, task.id, sealed.sheet.id, {
      expectedVersion: 0, textSha256, requestId: randomUUID(), feedback: payload("首版评语"),
    }, "agent-a");

    // 两 writer 并发更新（相同 expectedVersion=1，不同 requestId）：只允许一个成功。
    const [q1, q2] = await Promise.allSettled([
      feedbackService.putFeedback(ACTOR_A, task.id, sealed.sheet.id, {
        expectedVersion: 1, textSha256, requestId: randomUUID(), feedback: payload("改判甲版"),
      }, "agent-a"),
      feedbackService.putFeedback(ACTOR_A, task.id, sealed.sheet.id, {
        expectedVersion: 1, textSha256, requestId: randomUUID(), feedback: payload("改判乙版"),
      }, "agent-b"),
    ]);
    const fulfilled = [q1, q2].filter((r) => r.status === "fulfilled");
    const rejected = [q1, q2].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<{ version: number }>).value.version).toBe(2);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      httpStatus: 409,
      meta: { code: "FEEDBACK_VERSION_CONFLICT", actualVersion: 2 },
    });

    const rows = await adminPool.query<{ c: number; v: number }>(
      "SELECT count(*)::int AS c, max(version)::int AS v FROM l3_writing_feedback WHERE sheet_id = $1",
      [sealed.sheet.id],
    );
    expect(rows.rows[0]!.c).toBe(1);
    expect(rows.rows[0]!.v).toBe(2);
  });

  it("提交屏障交错（真实服务端）：核对通过后第三方保存 → CAS 409；不采纳最新版本、不自动重试", async () => {
    const { task, draft } = await createTask(ACTOR_A);
    await sheetService.saveDraft(ACTOR_A, task.id, draft.id, { expectedVersion: 0, text: "我的确认稿" });

    // flush 回执：已确认正文 + 版本 1（提交屏障的核对基线）。
    const receipt = { text: "我的确认稿", version: 1 };

    // 核对阶段：权威读面与回执**一致** → 允许提交（真实 getSheet + 真实纯函数）。
    const before = await sheetService.getSheet(ACTOR_A, task.id, draft.id);
    expect(evaluateSubmitPrecheck(receipt, {
      status: before.sheet.status, text: before.text, draftVersion: before.sheet.draftVersion,
    })).toEqual({ ok: true, expectedVersion: 1 });

    // 核对与 submit 之间：另一标签页保存（版本推进、正文替换）。
    await sheetService.saveDraft(ACTOR_A, task.id, draft.id, { expectedVersion: 1, text: "另一标签页的改动" });

    // 提交走 CAS：409；不自动重试；未定格任何正文。
    await expect(sheetService.submit(ACTOR_A, task.id, draft.id, { expectedVersion: 1 }))
      .rejects.toMatchObject({ httpStatus: 409, meta: { code: "DRAFT_VERSION_CONFLICT" } });

    const row = await adminPool.query<{ status: string; answers: Record<string, { text: string }> }>(
      "SELECT status, answers FROM l3_submissions WHERE id = $1",
      [draft.id],
    );
    expect(row.rows[0]!.status).toBe("draft"); // 未定格
    expect(row.rows[0]!.answers[task.questionId]!.text).toBe("另一标签页的改动"); // 第三方正文完好
    const attempts = await adminPool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM l3_question_attempts WHERE sheet_id = $1",
      [draft.id],
    );
    expect(attempts.rows[0]!.c).toBe(0);
  });

  it("提交屏障：核对发现他人修订 → 拒绝路径；盲采最新版本会定格未确认正文（危害对照）", async () => {
    // 正确路径：核对发现服务器上是别人修订 → precheck 拒绝（不提交，故不发生封印）。
    const a = await createTask(ACTOR_A);
    await sheetService.saveDraft(ACTOR_A, a.task.id, a.draft.id, { expectedVersion: 0, text: "我的确认稿" });
    await sheetService.saveDraft(ACTOR_A, a.task.id, a.draft.id, { expectedVersion: 1, text: "别人的改动" });
    const latest = await sheetService.getSheet(ACTOR_A, a.task.id, a.draft.id);
    expect(evaluateSubmitPrecheck(
      { text: "我的确认稿", version: 1 },
      { status: latest.sheet.status, text: latest.text, draftVersion: latest.sheet.draftVersion },
    )).toEqual({ ok: false, reason: "text-mismatch" });

    // 危害对照（独立第二稿）：若客户端盲采最新版本提交，会把「别人的改动」定格——
    // 证明上述拒绝是**必要保护**（服务端无法从版本号区分客户端意图）。
    const b = await createTask(ACTOR_A);
    await sheetService.saveDraft(ACTOR_A, b.task.id, b.draft.id, { expectedVersion: 0, text: "我的确认稿" });
    await sheetService.saveDraft(ACTOR_A, b.task.id, b.draft.id, { expectedVersion: 1, text: "别人的改动" });
    const blind = await sheetService.getSheet(ACTOR_A, b.task.id, b.draft.id);
    const sealed = await sheetService.submit(ACTOR_A, b.task.id, b.draft.id, {
      expectedVersion: blind.sheet.draftVersion, // ← 盲采：危害演示
    });
    expect(sealed.sheet.status).toBe("sealed");
    const attempt = await adminPool.query<{ answer: { text: string } }>(
      "SELECT answer FROM l3_question_attempts WHERE sheet_id = $1 AND status = 'active'",
      [b.draft.id],
    );
    expect(attempt.rows[0]!.answer.text).toBe("别人的改动");
  });
});
