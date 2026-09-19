/**
 * 题纸定格并发可靠性集成测试（Task B，2026-09-19）——真实 PostgreSQL + 可控两连接屏障。
 *
 * Run（独立验收库；先 migrate + converge，勿改库结构）：
 *   TEST_DATABASE_URL="<表属主角色@vocab_writing_test>" \
 *   TEST_APP_DATABASE_URL="<vocab_app@vocab_writing_test>" \
 *   DB_SSLMODE=disable npx vitest run --config vitest.integration.config.ts tests/l3-sheet-reliability.integration.test.ts
 *
 * 覆盖（屏障用独立 app 角色连接 + set_config actor 重现生产事务环境）：
 * R1 单连接happy path：PATCH A → 定格 full 成功，A 被物化进 attempt、题纸清空、状态 sealed；
 * R2 两连接复现（Task B 核心）：seal 读取 A（v=1）后阻塞，PATCH 写 B（v=2 提交），再释放
 *    seal —— seal 的 draft_version CAS 必须落空，拒绝固化旧 A 并**保留**并发写入 B（不丢）；
 *    库核：题纸仍 draft、answers=B、draft_version=2、无 attempt 物化。
 *    屏障可观测（2026-09-19 补强）：以 pg_locks 未授予 transactionid 锁为判据，确认被测
 *    请求已到达 CAS UPDATE 被行锁阻塞（读后竞争路径）后再提交屏障；超时即失败，
 *    不用固定 sleep 掩盖「读前冲突」的退化路径。
 *
 * 设计要点（与 writing 并发测试同律，但语义相反）：writing 测试里迟到提交因锁阻塞后 409；
 * 本题纸采用「读版本 + CAS 抢占」乐观并发，**不**用 FOR UPDATE 悲观锁——悲观锁会把
 * 「先读 A、后并发写 B」串行化为「先定格 A、B 落后 409」，反而丢弃更新的 B。故屏障以
 * FOR UPDATE 占位、让 seal 的 CAS UPDATE 阻塞，提交 B（版本前进）后 seal 的 CAS 落空。
 */
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetPool } from "@/db/connection";
import { L3SheetService } from "@/services/l3-sheets.service";
import { L3SheetExportService } from "@/services/l3-sheet-export.service";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL;

// Fail closed（同 writing-rls 先例）：缺接线必须报错而非静默跳过。
if (!adminDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required to seed the sheet reliability fixture");
}
if (!appDatabaseUrl) {
  throw new Error("TEST_APP_DATABASE_URL is required for the restricted sheet reliability session");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("L3 sheet seal concurrency (integration)", () => {
  const ACTOR_A = randomUUID();
  const ACTOR_B = randomUUID();
  const SOURCE = randomUUID();
  const QUESTION = randomUUID();
  const SCOPE_KEY = `file:${SOURCE}:reading_choice`;
  const WRITING_TASK = randomUUID();
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
  const ORIGINAL_POOL_MAX = process.env.DB_POOL_MAX;

  const adminPool = new Pool({ connectionString: adminDatabaseUrl, max: 2 });
  const barrierPool = new Pool({ connectionString: appDatabaseUrl!, max: 2 });
  const sheetService = new L3SheetService();
  const exportService = new L3SheetExportService();

  /** 独立 app 角色连接 + actor 注入（与 withTransaction 同键），用于可控屏障。 */
  async function actorClient(actorId: string): Promise<PoolClient> {
    const client = await barrierPool.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [actorId]);
    return client;
  }

  /**
   * 可观测屏障（审查建议）：轮询 pg_locks 直到出现「未授予的 transactionid 锁」——
   * 即被测请求已通过版本读取并到达 CAS UPDATE、被屏障事务的行锁阻塞（读后竞争路径
   * 已发生）。取代固定 sleep：慢调度下若请求未达 UPDATE，超时失败如实暴露而不是
   * 静默退化为「读前冲突」路径。
   */
  async function waitForCasLockWait(label: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await adminPool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM pg_locks WHERE NOT granted AND locktype = 'transactionid'`,
      );
      if (row.rows[0]!.c > 0) return;
      if (Date.now() > deadline) {
        throw new Error(`屏障超时：未观测到 CAS UPDATE 的行锁等待（${label}）`);
      }
      await sleep(50);
    }
  }

  /** 每个用例前清掉 A 的草稿（含 attempt），并以固定 scope_key 插入一张干净 draft。 */
  async function freshDraft(id: string): Promise<void> {
    await adminPool.query(
      "DELETE FROM l3_question_attempts WHERE user_id = $1",
      [ACTOR_A],
    );
    await adminPool.query(
      "DELETE FROM l3_submissions WHERE user_id = $1 AND scope_key = $2 AND status = 'draft'",
      [ACTOR_A, SCOPE_KEY],
    );
    await adminPool.query(
      `INSERT INTO l3_submissions
         (id, user_id, scope, scope_key, source_id, question_type, status, answers, draft_version)
       VALUES ($1::uuid, $2::uuid, 'file', $3, $4::uuid, 'reading_choice', 'draft', '{}'::jsonb, 0)`,
      [id, ACTOR_A, SCOPE_KEY, SOURCE],
    );
  }

  beforeAll(async () => {
    await adminPool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)`,
      [ACTOR_A, `sheet-rel-a-${ACTOR_A.slice(0, 8)}@example.test`],
    );
    await adminPool.query(
      `INSERT INTO profiles (id, email) VALUES ($1, $2)`,
      [ACTOR_A, `sheet-rel-a-${ACTOR_A.slice(0, 8)}@example.test`],
    );
    await adminPool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)`,
      [ACTOR_B, `sheet-rel-b-${ACTOR_B.slice(0, 8)}@example.test`],
    );
    await adminPool.query(
      `INSERT INTO profiles (id, email) VALUES ($1, $2)`,
      [ACTOR_B, `sheet-rel-b-${ACTOR_B.slice(0, 8)}@example.test`],
    );
    await adminPool.query(
      `INSERT INTO l3_sources (id, user_id, source_type, direction, title)
       VALUES ($1::uuid, $2::uuid, 'article', '通用', 'sheet reliability fixture')`,
      [SOURCE, ACTOR_A],
    );
    await adminPool.query(
      `INSERT INTO l3_questions
         (id, user_id, source_id, space, question_type, ordinal, stem, answer, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, '阅读', 'reading_choice', 0, '题干', '{}'::jsonb, 'active')`,
      [QUESTION, ACTOR_A, SOURCE],
    );

    await resetPool();
    process.env.DATABASE_URL = appDatabaseUrl!;
    process.env.DB_POOL_MAX = "2";
  });

  beforeEach(async () => {
    await adminPool.query("DELETE FROM l3_question_attempts WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
    await adminPool.query("DELETE FROM l3_submissions WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
    await adminPool.query("DELETE FROM l3_writing_tasks WHERE user_id = $1", [ACTOR_A]);
  });

  afterAll(async () => {
    try {
      await adminPool.query("DELETE FROM l3_question_attempts WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_submissions WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
      await adminPool.query("DELETE FROM l3_writing_tasks WHERE user_id = $1", [ACTOR_A]);
      await adminPool.query("DELETE FROM l3_questions WHERE user_id = $1", [ACTOR_A]);
      await adminPool.query("DELETE FROM l3_sources WHERE user_id = ANY($1::uuid[])", [[ACTOR_A, ACTOR_B]]);
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

  it("R1 happy path：PATCH A → 定格 full 成功，A 物化、题纸清空、状态 sealed", async () => {
    const sheetId = randomUUID();
    await freshDraft(sheetId);

    await sheetService.patchSheet({ userId: ACTOR_A, sheetId, expectedVersion: 0, answers: { [QUESTION]: { choice: "A" } } });

    const result = await sheetService.sealSheet({
      userId: ACTOR_A, sheetId, expectedVersion: 1, mode: "full", acknowledgeUnanswered: true,
    });
    expect(result.sheet.status).toBe("sealed");
    expect(result.materializedCount).toBe(1);

    // 库核：题纸清空、attempt 已物化 A 作答事实（choice 为客观字段，保留）。
    const row = await adminPool.query<{ status: string; answers: Record<string, unknown> }>(
      "SELECT status, answers FROM l3_submissions WHERE id = $1",
      [sheetId],
    );
    expect(row.rows[0]!.status).toBe("sealed");
    expect(row.rows[0]!.answers).toEqual({});
    const attempt = await adminPool.query<{ answer: { choice: string } }>(
      "SELECT answer FROM l3_question_attempts WHERE sheet_id = $1 AND status = 'active'",
      [sheetId],
    );
    expect(attempt.rows[0]!.answer.choice).toBe("A");
  });

  it("R2 两连接复现：seal 读取 A 后阻塞，PATCH 写 B 提交，seal 的 CAS 落空 → 不固化旧 A、不丢 B", async () => {
    const sheetId = randomUUID();
    await freshDraft(sheetId);

    // 先落 A（提交，v=1）。
    await sheetService.patchSheet({ userId: ACTOR_A, sheetId, expectedVersion: 0, answers: { [QUESTION]: { choice: "A" } } });

    // 屏障：模拟「并发 PATCH」在途——锁行并写入 B（v=2，未提交）。
    const client = await actorClient(ACTOR_A);
    await client.query(`SELECT * FROM l3_submissions WHERE id = $1::uuid FOR UPDATE`, [sheetId]);
    await client.query(
      `UPDATE l3_submissions
          SET answers = answers || $3::jsonb, draft_version = draft_version + 1, updated_at = now()
        WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'draft'`,
      [sheetId, ACTOR_A, JSON.stringify({ [QUESTION]: { choice: "B" } })],
    );

    // 并行 seal：读到 v=1 的 A，其 CAS UPDATE 在屏障行锁上阻塞，直到屏障提交。
    const sealPromise = sheetService.sealSheet({
      userId: ACTOR_A, sheetId, expectedVersion: 1, mode: "full", acknowledgeUnanswered: true,
    });
    // 可观测屏障：确认 seal 已到达 CAS UPDATE 且被行锁阻塞（读后竞争路径），再提交屏障。
    await waitForCasLockWait("R2 seal CAS UPDATE");
    await client.query("COMMIT");
    client.release();

    // seal 的 CAS（期望 v=1）因屏障已提交 v=2 而落空 → 409 DRAFT_VERSION_CONFLICT。
    await expect(sealPromise).rejects.toMatchObject({
      httpStatus: 409,
      meta: { code: "DRAFT_VERSION_CONFLICT" },
    });

    // 库核：题纸仍 draft、答案为 B（最新写入完好）、版本=2、无 attempt（旧 A 未物化）。
    const row = await adminPool.query<{ status: string; draft_version: number; answers: Record<string, { choice: string }> }>(
      "SELECT status, draft_version, answers FROM l3_submissions WHERE id = $1",
      [sheetId],
    );
    expect(row.rows[0]!.status).toBe("draft");
    expect(row.rows[0]!.draft_version).toBe(2);
    expect(row.rows[0]!.answers[QUESTION]!.choice).toBe("B");
    const attempts = await adminPool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM l3_question_attempts WHERE sheet_id = $1",
      [sheetId],
    );
    expect(attempts.rows[0]!.c).toBe(0);
  });

  it("R3 两端 PATCH 同初始版本：一个成功一个 409，版本只递增一次", async () => {
    const sheetId = randomUUID();
    await freshDraft(sheetId); // v0

    // 屏障连接以 v0 写入 A（未提交、锁行）——模拟另一端的在途 PATCH。
    const client = await actorClient(ACTOR_A);
    await client.query(`SELECT * FROM l3_submissions WHERE id = $1::uuid FOR UPDATE`, [sheetId]);
    await client.query(
      `UPDATE l3_submissions
          SET answers = answers || $3::jsonb, draft_version = draft_version + 1, updated_at = now()
        WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'draft'`,
      [sheetId, ACTOR_A, JSON.stringify({ [QUESTION]: { choice: "A" } })],
    );

    // 本端 PATCH（expectedVersion=0）阻塞在行锁上；屏障提交 v1 后条件落空 → 409。
    const patchPromise = sheetService.patchSheet({
      userId: ACTOR_A, sheetId, expectedVersion: 0, answers: { [QUESTION]: { choice: "B" } },
    });
    // 可观测屏障：确认本端 PATCH 已到达 CAS UPDATE 且被行锁阻塞，再提交屏障。
    await waitForCasLockWait("R3 patch CAS UPDATE");
    await client.query("COMMIT");
    client.release();

    await expect(patchPromise).rejects.toMatchObject({
      httpStatus: 409,
      meta: { code: "DRAFT_VERSION_CONFLICT" },
    });

    const row = await adminPool.query<{ draft_version: number; answers: Record<string, { choice: string }> }>(
      "SELECT draft_version, answers FROM l3_submissions WHERE id = $1",
      [sheetId],
    );
    expect(row.rows[0]!.draft_version).toBe(1); // 只有屏障那一次递增（本端未生效）
    expect(row.rows[0]!.answers[QUESTION]!.choice).toBe("A"); // 赢家是屏障侧的写入
  });

  it("R4 客户端确认后、seal 读取前的他处写入：seal(v1) 409 且不物化（答案保留 v2）", async () => {
    const sheetId = randomUUID();
    await freshDraft(sheetId);
    await sheetService.patchSheet({ userId: ACTOR_A, sheetId, expectedVersion: 0, answers: { [QUESTION]: { choice: "A" } } });
    // 另端在「本端确认 v1 之后」写入 B → v2（提交）——最坏时序：客户端以为 v1 是最新。
    await sheetService.patchSheet({ userId: ACTOR_A, sheetId, expectedVersion: 1, answers: { [QUESTION]: { choice: "B" } } });

    // 本端仍按 flush 回执 v1 定格 → 服务端读取即发现版本不符 → 立即 409，不物化。
    const rejected = await sheetService.sealSheet({
      userId: ACTOR_A, sheetId, expectedVersion: 1, mode: "full", acknowledgeUnanswered: true,
    }).catch((error: unknown) => error);
    expect(rejected).toMatchObject({ httpStatus: 409, meta: { code: "DRAFT_VERSION_CONFLICT" } });

    const row = await adminPool.query<{ status: string; draft_version: number; answers: Record<string, { choice: string }> }>(
      "SELECT status, draft_version, answers FROM l3_submissions WHERE id = $1",
      [sheetId],
    );
    expect(row.rows[0]!.status).toBe("draft");
    expect(row.rows[0]!.draft_version).toBe(2);
    expect(row.rows[0]!.answers[QUESTION]!.choice).toBe("B"); // 他处写入完好
    const attempts = await adminPool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM l3_question_attempts WHERE sheet_id = $1",
      [sheetId],
    );
    expect(attempts.rows[0]!.c).toBe(0);
  });

  it("R5 服务端先定格后，后续 PATCH 一律 409（不能再写入；A 已物化）", async () => {
    const sheetId = randomUUID();
    await freshDraft(sheetId);
    await sheetService.patchSheet({ userId: ACTOR_A, sheetId, expectedVersion: 0, answers: { [QUESTION]: { choice: "A" } } });
    const sealed = await sheetService.sealSheet({
      userId: ACTOR_A, sheetId, expectedVersion: 1, mode: "full", acknowledgeUnanswered: true,
    });
    expect(sealed.sheet.status).toBe("sealed");

    const rejected = await sheetService.patchSheet({
      userId: ACTOR_A, sheetId, expectedVersion: 2, answers: { [QUESTION]: { choice: "B" } },
    }).catch((error: unknown) => error);
    expect(rejected).toMatchObject({ httpStatus: 409 });
    expect((rejected as { meta?: { status?: string } }).meta?.status).toBe("sealed");

    const attempts = await adminPool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM l3_question_attempts WHERE sheet_id = $1 AND status = 'active'",
      [sheetId],
    );
    expect(attempts.rows[0]!.c).toBe(1);
  });

  it("R6 导出版本核对：draft 旧版本 409、缺版本 422；sealed 无需版本", async () => {
    const sheetId = randomUUID();
    await freshDraft(sheetId);
    await sheetService.patchSheet({ userId: ACTOR_A, sheetId, expectedVersion: 0, answers: { [QUESTION]: { choice: "A" } } }); // v1

    const stale = await exportService.exportSheet(ACTOR_A, sheetId, { expectedVersion: 0 }).catch((e: unknown) => e);
    expect(stale).toMatchObject({ httpStatus: 409, meta: { code: "DRAFT_VERSION_CONFLICT" } });
    const missing = await exportService.exportSheet(ACTOR_A, sheetId).catch((e: unknown) => e);
    expect(missing).toMatchObject({ httpStatus: 422 }); // ValidationError 惯例（对齐 withAnswers 非法值）
    const snapshot = await exportService.exportSheet(ACTOR_A, sheetId, { expectedVersion: 1 });
    expect(snapshot.schemaVersion).toBe(2);

    // sealed 归档导出不要求版本（旧回看/导出合同）。
    await sheetService.sealSheet({
      userId: ACTOR_A, sheetId, expectedVersion: 1, mode: "full", acknowledgeUnanswered: true,
    });
    const archive = await exportService.exportSheet(ACTOR_A, sheetId);
    expect(archive.schemaVersion).toBe(2);
  });

  it("R7 跨 owner 404 与 writing 旁路封堵（通用写面不服务写作稿/他人稿）", async () => {
    // 跨 owner：ACTOR_B 的题纸（自属 source 满足 (source_id,user_id) FK），以 ACTOR_A 调用 → 404（不泄露存在性）。
    const foreignSource = randomUUID();
    await adminPool.query(
      `INSERT INTO l3_sources (id, user_id, source_type, direction, title)
       VALUES ($1::uuid, $2::uuid, 'article', '通用', 'sheet reliability foreign fixture')`,
      [foreignSource, ACTOR_B],
    );
    const foreignId = randomUUID();
    await adminPool.query(
      `INSERT INTO l3_submissions
         (id, user_id, scope, scope_key, source_id, question_type, status, answers, draft_version)
       VALUES ($1::uuid, $2::uuid, 'file', $3, $4::uuid, 'reading_choice', 'draft', '{}'::jsonb, 0)`,
      [foreignId, ACTOR_B, `file:${foreignSource}:reading_choice`, foreignSource],
    );
    const notFound = await sheetService.patchSheet({
      userId: ACTOR_A, sheetId: foreignId, expectedVersion: 0, answers: { [QUESTION]: { choice: "A" } },
    }).catch((e: unknown) => e);
    expect(notFound).toMatchObject({ httpStatus: 404 });

    // writing scope：先补 (writing_task_id,user_id) FK 指到的任务行；专用写面之外一律 409 WRITING_ENDPOINT_REQUIRED。
    await adminPool.query(
      `INSERT INTO l3_writing_tasks (id, user_id, question_id, title, kind, direction, create_request_id, create_input_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, '旁路封堵夹具', 'free', '通用', $4, $5)`,
      [WRITING_TASK, ACTOR_A, QUESTION, randomUUID(), `hash-${WRITING_TASK.slice(0, 8)}`],
    );
    const writingId = randomUUID();
    await adminPool.query(
      `INSERT INTO l3_submissions
         (id, user_id, scope, scope_key, writing_task_id, status, answers, draft_version)
       VALUES ($1::uuid, $2::uuid, 'writing', $3, $4::uuid, 'draft', '{}'::jsonb, 0)`,
      [writingId, ACTOR_A, `writing:${WRITING_TASK}`, WRITING_TASK],
    );
    const patchBlocked = await sheetService.patchSheet({
      userId: ACTOR_A, sheetId: writingId, expectedVersion: 0, answers: { [QUESTION]: { choice: "A" } },
    }).catch((e: unknown) => e);
    expect(patchBlocked).toMatchObject({ httpStatus: 409, meta: { code: "WRITING_ENDPOINT_REQUIRED" } });
    const sealBlocked = await sheetService.sealSheet({
      userId: ACTOR_A, sheetId: writingId, expectedVersion: 0, mode: "full", acknowledgeUnanswered: true,
    }).catch((e: unknown) => e);
    expect(sealBlocked).toMatchObject({ httpStatus: 409, meta: { code: "WRITING_ENDPOINT_REQUIRED" } });

    const attempts = await adminPool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM l3_question_attempts WHERE sheet_id = $1",
      [writingId],
    );
    expect(attempts.rows[0]!.c).toBe(0);
  });

  it("R8 无冲突定格三档：full=sealed、incremental/summary=discarded（真库状态流转）", async () => {
    for (const mode of ["full", "incremental", "summary"] as const) {
      const sheetId = randomUUID();
      await freshDraft(sheetId);
      await sheetService.patchSheet({
        userId: ACTOR_A, sheetId, expectedVersion: 0, answers: { [QUESTION]: { choice: "A" } },
      });
      const result = await sheetService.sealSheet({
        userId: ACTOR_A, sheetId, expectedVersion: 1, mode,
        ...(mode === "summary" ? { summary: "本轮只留总结" } : {}),
        acknowledgeUnanswered: true,
      });
      const expected = mode === "full" ? "sealed" : "discarded";
      expect(result.sheet.status).toBe(expected);
      const row = await adminPool.query<{ status: string; answers: Record<string, unknown> }>(
        "SELECT status, answers FROM l3_submissions WHERE id = $1",
        [sheetId],
      );
      expect(row.rows[0]!.status).toBe(expected);
      expect(Object.keys(row.rows[0]!.answers)).toHaveLength(0); // 定格后 answers 清空（attempts 唯一真源）
    }
  });
});
