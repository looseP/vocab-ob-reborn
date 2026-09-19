/**
 * N1 后端合同补修（F1–F5）· 真实 PostgreSQL 集成测试。
 *
 * 隔离纪律（与 tests/l3-study-notes.integration.test.ts 同款）：
 * - 只在显式指定的本批专属验收库运行（TEST_DATABASE_URL / TEST_APP_DATABASE_URL
 *   缺失即失败——不 skip、不退回个人 DATABASE_URL）；
 * - 目标库身份显式校验（默认 vocab_study_notes_repair_accept；可用 STUDY_NOTES_REPAIR_DB 覆盖）；
 * - fixture owner 为随机 UUID；清理限定本任务 owner 集合，不 truncate 业务表；
 * - 并发窗口用可观测屏障（pg_locks / pg_blocking_pids / 实际仓储 SQL 后的握手），
 *   不以固定 sleep 宣称覆盖；未到达目标窗口即失败。
 *
 * 运行：
 *   TEST_DATABASE_URL=...vocab_study_notes_repair_accept（vocab_migration）
 *   TEST_APP_DATABASE_URL=...vocab_study_notes_repair_accept（vocab_app）
 *   npx vitest run --config vitest.integration.config.ts tests/l3-study-notes-repair.integration.test.ts --maxWorkers=1
 */
import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "@/errors";
import { resetPool } from "@/db/connection";
import { withTransaction } from "@/db/transaction";
import {
  L3StudyNoteService,
  computeNoteCreateHash,
  computeTopicCreateHash,
  type StudyNoteRepos,
} from "@/services/l3-study-notes.service";
import { L3StudyReferenceService } from "@/services/l3-study-reference.service";
import { L3ContextService } from "@/services/l3-context.service";
import { L3PaperService } from "@/services/l3-paper.service";
import { L3StudyNoteRepository } from "@/repositories/l3-study-notes.repository";
import { L3StudyTopicRepository } from "@/repositories/l3-study-topics.repository";
import { L3StudyReferenceRepository } from "@/repositories/l3-study-references.repository";
import { L3ContextRepository } from "@/repositories/l3-context.repository";
import {
  cleanupStudyFixture,
  requireStudyNoteTestUrls,
  seedStudyOwners,
  seedStudyQuestion,
  seedStudySource,
} from "./helpers/study-notes-db";

// ── 目标库身份与既有 fixture 纪律 ───────────────────────────────────────────

const { adminUrl, appUrl } = requireStudyNoteTestUrls();
const EXPECTED_DB = process.env.STUDY_NOTES_REPAIR_DB ?? "vocab_study_notes_repair_accept";

function databaseName(url: string): string {
  return new URL(url).pathname.slice(1);
}

if (databaseName(adminUrl) !== databaseName(appUrl)) {
  throw new Error("TEST_DATABASE_URL 与 TEST_APP_DATABASE_URL 必须指向同一验收库");
}
if (databaseName(adminUrl) !== EXPECTED_DB) {
  throw new Error(
    `本批集成测试只允许在专属验收库 ${EXPECTED_DB} 运行（当前 ${databaseName(adminUrl)}）；`
    + "如确需更换，请设 STUDY_NOTES_REPAIR_DB 并先用仓库迁移/角色引导建库。",
  );
}

const OWNER_A = randomUUID();
const OWNER_B = randomUUID();

const adminPool = new Pool({ connectionString: adminUrl, max: 3 });

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalPoolMax = process.env.DB_POOL_MAX;

/** 以受限角色（vocab_app）打开独立连接并开启带 actor claim 的事务。 */
async function connectAs(actorId: string): Promise<Client> {
  const client = new Client({ connectionString: appUrl });
  await client.connect();
  await client.query("BEGIN");
  await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [actorId]);
  return client;
}

async function backendPid(client: Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
  return rows[0]!.pid;
}

/** 观察指定 backend pid 是否存在未授予的锁请求（绑定被测连接的锁等待证据）。 */
async function waitForLockWait(targetPid: number, deadlineMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const { rows } = await adminPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND granted = false`,
      [targetPid],
    );
    if ((rows[0]?.n ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * 观察"存在被 blockerPid 阻塞的锁等待"（advisory/行锁/隐式 FK 锁均可），
 * 返回该等待者的 pid、锁定类型与（可能的）relation（供断言确实到达目标窗口）。
 * 注：pg_stat_activity.query 对非超管角色显示 <insufficient privilege>，故用
 * pg_locks 组合证据代替语句文本；FK 交叉检查表现为 transactionid 等待。
 */
async function waitForBlockedBy(
  blockerPid: number,
  deadlineMs = 5000,
): Promise<{ pid: number; locktype: string; relation: string | null; mode: string } | null> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const { rows } = await adminPool.query<{
      pid: number; locktype: string; relation: string | null; mode: string;
    }>(
      `SELECT l.pid, l.locktype, c.relname AS relation, l.mode
         FROM pg_locks l
         LEFT JOIN pg_class c ON c.oid = l.relation
        WHERE NOT l.granted AND $1 = ANY(pg_blocking_pids(l.pid))
        LIMIT 1`,
      [blockerPid],
    );
    if (rows.length > 0) return rows[0]!;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function expectCaseDifference(lower: string): string {
  const upper = lower.toUpperCase();
  expect(upper).not.toBe(lower); // 防纯数字 UUID 的大小写用例假绿
  return upper;
}

/** 轮询等待测试内屏障标志（未到达目标窗口返回 false → 用例失败）。 */
async function waitUntil(predicate: () => boolean, deadlineMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

beforeAll(async () => {
  await seedStudyOwners(adminPool, [OWNER_A, OWNER_B]);

  // 目标库身份显式校验（连接后实测）
  const { rows } = await adminPool.query<{ db: string }>(`SELECT current_database() AS db`);
  if (rows[0]?.db !== EXPECTED_DB) {
    throw new Error(`验收库身份不符：期望 ${EXPECTED_DB}，实测 ${rows[0]?.db}`);
  }

  // 切换到受限应用角色（与服务运行同款 env：DATABASE_URL 指向 vocab_app）
  await resetPool();
  process.env.DATABASE_URL = appUrl;
  process.env.DB_POOL_MAX = "1";
});

afterAll(async () => {
  try {
    await resetPool();
    await cleanupStudyFixture(adminPool, [OWNER_A, OWNER_B]);
  } finally {
    await adminPool.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPoolMax === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = originalPoolMax;
  }
});

// ── F5 · UUID 身份（真实 PG）───────────────────────────────────────────────

describe("F5 · UUID 身份（真实 PG）", () => {
  const SRC_CASE_U = "ABCDEFAB-2345-4789-8ABC-000000000001";
  const SRC_CASE_L = "abcdefab-2345-4789-8abc-000000000001";
  const Q_CASE_U = "BEEFCAFE-2345-4789-8ABC-000000000002";
  const Q_CASE_L = "beefcafe-2345-4789-8abc-000000000002";
  const REF_CASE_U = "DEADBEEF-2345-4789-8ABC-000000000003";
  const REF_CASE_L = "deadbeef-2345-4789-8abc-000000000003";
  const REQ1_CASE_U = "CAFEBABE-2345-4789-8ABC-000000000004";
  const REQ1_CASE_L = "cafebabe-2345-4789-8abc-000000000004";
  const Q_STEM = "What does the fox do?";

  it("preview / capture / keep / 幂等重试：大写 UUID 与小写同一身份（引用 id 落库为规范小写）", async () => {
    await seedStudySource(adminPool, { id: SRC_CASE_L, userId: OWNER_A, contentText: "The quick brown fox." });
    await seedStudyQuestion(adminPool, {
      id: Q_CASE_L, userId: OWNER_A, sourceId: SRC_CASE_L,
      stem: Q_STEM, options: [{ key: "A", text: "jumps over the lazy dog" }],
    });

    const service = new L3StudyNoteService();
    const refService = new L3StudyReferenceService();

    // 1) 大写 requestId 创建 → 幂等键落库为规范小写
    const created = await service.create(OWNER_A, { requestId: REQ1_CASE_U, venue: "reading_choice" });
    expect(created.created).toBe(true);
    const noteId = created.item.id;
    const row1 = await adminPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM l3_study_notes WHERE user_id = $1 AND create_request_id = $2`,
      [OWNER_A, REQ1_CASE_L],
    );
    expect(row1.rows[0]!.n).toBe(1);

    // 2) preview：大写目标 id 正常返回（不再 404）
    const preview = await refService.preview(OWNER_A, {
      kind: "stem_quote", questionId: Q_CASE_U, start: 0, end: 4, quote: "What",
    });
    expect(preview.preview.liveTitle).toBeTruthy();

    // 3) capture：大写 noteId / ref id / 目标 id → 落库规范小写，status=current
    const saved = await service.save(OWNER_A, noteId.toUpperCase(), {
      expectedVersion: 1,
      requestId: randomUUID(),
      title: "大小写引用",
      bodyMd: `正文\n\n[[ref:${REF_CASE_U}]]`,
      venues: ["reading_choice"],
      pinned: false,
      status: "active",
      references: [{
        id: REF_CASE_U, action: "capture",
        target: { kind: "stem_quote", questionId: Q_CASE_U, start: 0, end: 4, quote: "What" },
      }],
    });
    expect(saved.item.version).toBe(2);
    expect(saved.item.references).toHaveLength(1);
    expect(saved.item.references[0]!.id).toBe(REF_CASE_L);
    expect(saved.item.references[0]!.status).toBe("current");
    const capturedAt = saved.item.references[0]!.capturedAt;

    const refRow = await adminPool.query<{ id: string; question_id: string }>(
      `SELECT id, question_id FROM l3_study_note_references WHERE note_id = $1`,
      [noteId],
    );
    expect(refRow.rows).toEqual([{ id: REF_CASE_L, question_id: Q_CASE_L }]);

    // 4) keep：大写 ref id 与 noteId 重试 → 保留原摘录与 capturedAt
    const kept = await service.save(OWNER_A, noteId.toUpperCase(), {
      expectedVersion: 2,
      requestId: randomUUID(),
      title: "大小写引用",
      bodyMd: `正文\n\n[[ref:${REF_CASE_U}]]`,
      venues: ["reading_choice"],
      pinned: false,
      status: "active",
      references: [{ id: REF_CASE_U, action: "keep" }],
    });
    expect(kept.item.version).toBe(3);
    expect(kept.item.references[0]!.capturedAt).toBe(capturedAt);

    // 5) 幂等创建重试（大写 requestId）→ 返回同一对象、不新建
    const retried = await service.create(OWNER_A, { requestId: REQ1_CASE_U, venue: "reading_choice" });
    expect(retried.created).toBe(false);
    expect(retried.item.id).toBe(noteId);
    const noteCount = await adminPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM l3_study_notes WHERE user_id = $1 AND create_request_id = $2`,
      [OWNER_A, REQ1_CASE_L],
    );
    expect(noteCount.rows[0]!.n).toBe(1);

    // 6) get（大写 noteId）→ 同一对象、引用 id 规范小写
    const fetched = await service.get(OWNER_A, noteId.toUpperCase());
    expect(fetched.item.id).toBe(noteId);
    expect(fetched.item.references[0]!.id).toBe(REF_CASE_L);
  });

  it("成员移动：大写 noteId 只重排、不新增成员（真库行数与顺序断言）", async () => {
    const service = new L3StudyNoteService();
    const topic = await service.createTopic(OWNER_A, {
      requestId: randomUUID(), venue: "reading_choice", title: "大小写专题",
    });
    const topicId = topic.item.id;

    const n1 = (await service.create(OWNER_A, { requestId: randomUUID(), venue: "reading_choice" })).item.id;
    const n2 = (await service.create(OWNER_A, { requestId: randomUUID(), venue: "reading_choice" })).item.id;
    const n1Upper = expectCaseDifference(n1);

    const after1 = await service.moveTopicMember(OWNER_A, topicId, n1, {
      requestId: randomUUID(), expectedVersion: 1, beforeNoteId: null,
    });
    const after2 = await service.moveTopicMember(OWNER_A, topicId, n2, {
      requestId: randomUUID(), expectedVersion: after1.item.version, beforeNoteId: null,
    });
    expect(after2.item.memberCount).toBe(2);

    // 大写 n1 移到最后：应只重排为 [n2, n1]
    const moved = await service.moveTopicMember(OWNER_A, topicId, n1Upper, {
      requestId: randomUUID(), expectedVersion: after2.item.version, beforeNoteId: null,
    });
    expect(moved.item.memberCount).toBe(2);

    const members = await adminPool.query<{ note_id: string; position: number }>(
      `SELECT note_id, position FROM l3_study_topic_notes WHERE topic_id = $1 ORDER BY position, note_id`,
      [topicId],
    );
    expect(members.rowCount).toBe(2);
    expect(members.rows).toEqual([
      { note_id: n2, position: 0 },
      { note_id: n1, position: 1 },
    ]);
  });
});

// ── F1 · 创建幂等与删除事务恢复（真实 PG）────────────────────────────────────

describe("F1 · 创建幂等（真实 PG 两连接 + 可观测阻塞）", () => {
  it("同键同输入并发：INSERT 阻塞于并发事务 → 提交后冲突回读复用（仅一行、不重置内容）", async () => {
    const requestId = randomUUID();
    const venue = "reading_choice" as const;
    const hash = computeNoteCreateHash(venue);
    const c1 = await connectAs(OWNER_A);
    try {
      const noteRepo = new L3StudyNoteRepository(c1 as unknown as PoolClient);
      const c1NoteId = randomUUID();
      await noteRepo.create({
        id: c1NoteId, user_id: OWNER_A, title: "并发基线", body_md: "", status: "active",
        pinned: false, version: 1, create_request_id: requestId, create_input_hash: hash,
      });

      const service = new L3StudyNoteService();
      const serviceCall = service.create(OWNER_A, { requestId, venue });
      const c1Pid = await backendPid(c1);
      const blocked = await waitForBlockedBy(c1Pid);
      expect(blocked).not.toBeNull(); // 未到达目标窗口（阻塞在真实 INSERT）即失败

      await c1.query("COMMIT");
      const result = await serviceCall;
      expect(result.created).toBe(false);
      expect(result.item.id).toBe(c1NoteId);
      expect(result.item.title).toBe("并发基线"); // 复用当前内容，不重置

      const count = await adminPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM l3_study_notes WHERE user_id = $1 AND create_request_id = $2`,
        [OWNER_A, requestId],
      );
      expect(count.rows[0]!.n).toBe(1);
    } finally {
      await c1.end().catch(() => undefined);
    }
  });

  it("同键异输入并发：一成功一 409（仅一行）", async () => {
    const requestId = randomUUID();
    const c1 = await connectAs(OWNER_A);
    try {
      const noteRepo = new L3StudyNoteRepository(c1 as unknown as PoolClient);
      await noteRepo.create({
        id: randomUUID(), user_id: OWNER_A, title: "", body_md: "", status: "active",
        pinned: false, version: 1, create_request_id: requestId,
        create_input_hash: computeNoteCreateHash("reading_choice"),
      });

      const service = new L3StudyNoteService();
      const serviceCall = service.create(OWNER_A, { requestId, venue: "cloze" }); // 异输入
      const c1Pid = await backendPid(c1);
      expect(await waitForBlockedBy(c1Pid)).not.toBeNull();

      await c1.query("COMMIT");
      const error = await serviceCall.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);

      const count = await adminPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM l3_study_notes WHERE user_id = $1 AND create_request_id = $2`,
        [OWNER_A, requestId],
      );
      expect(count.rows[0]!.n).toBe(1);
    } finally {
      await c1.end().catch(() => undefined);
    }
  });

  it("已编辑后旧创建请求重试保留现内容；不同 owner 同 requestId 互不影响", async () => {
    const requestId = randomUUID();
    const service = new L3StudyNoteService();
    const created = await service.create(OWNER_A, { requestId, venue: "reading_choice" });
    const noteId = created.item.id;
    await service.save(OWNER_A, noteId, {
      expectedVersion: 1, requestId: randomUUID(), title: "已编辑", bodyMd: "编辑后正文",
      venues: ["reading_choice"], pinned: false, status: "active", references: [],
    });

    const retried = await service.create(OWNER_A, { requestId, venue: "reading_choice" });
    expect(retried.created).toBe(false);
    expect(retried.item.title).toBe("已编辑");
    expect(retried.item.bodyMd).toBe("编辑后正文");

    const otherOwner = await service.create(OWNER_B, { requestId, venue: "reading_choice" });
    expect(otherOwner.created).toBe(true);
    expect(otherOwner.item.id).not.toBe(noteId);
  });

  it("专题同键同输入并发：一成功一复用（仅一行）", async () => {
    const requestId = randomUUID();
    const c1 = await connectAs(OWNER_A);
    try {
      const topicRepo = new L3StudyTopicRepository(c1 as unknown as PoolClient);
      const c1TopicId = randomUUID();
      await topicRepo.create({
        id: c1TopicId, user_id: OWNER_A, question_type: "reading_choice", title: "并发专题",
        status: "active", version: 1, create_request_id: requestId,
        create_input_hash: computeTopicCreateHash("reading_choice", "并发专题"),
      });

      const service = new L3StudyNoteService();
      const serviceCall = service.createTopic(OWNER_A, { requestId, venue: "reading_choice", title: "并发专题" });
      const c1Pid = await backendPid(c1);
      expect(await waitForBlockedBy(c1Pid)).not.toBeNull();

      await c1.query("COMMIT");
      const result = await serviceCall;
      expect(result.created).toBe(false);
      expect(result.item.id).toBe(c1TopicId);

      const count = await adminPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM l3_study_topics WHERE user_id = $1 AND create_request_id = $2`,
        [OWNER_A, requestId],
      );
      expect(count.rows[0]!.n).toBe(1);
    } finally {
      await c1.end().catch(() => undefined);
    }
  });
});

describe("F1 · 删除事务恢复（真实 PG 交错）", () => {
  it("来源删除：预检查（未提交引用不可见）后 DELETE 阻塞 → 引用提交 → FK RESTRICT → savepoint 恢复 → 409 含真实 blockers；S/Q/引用完整", async () => {
    const src = randomUUID();
    const q = randomUUID();
    await seedStudySource(adminPool, { id: src, userId: OWNER_A, contentText: "interleave source text" });
    await seedStudyQuestion(adminPool, {
      id: q, userId: OWNER_A, sourceId: src, stem: "interleave stem?",
      options: [{ key: "A", text: "alpha" }],
    });
    const noteId = (await new L3StudyNoteService().create(OWNER_A, {
      requestId: randomUUID(), venue: "reading_choice",
    })).item.id;

    const c1 = await connectAs(OWNER_A);
    try {
      // c1：插入 Q 引用（未提交）——对删除事务的预检查不可见
      await c1.query(
        `INSERT INTO l3_study_note_references (id, note_id, user_id, kind, question_id, field_hash, display_snapshot)
         VALUES ($1, $2, $3, 'question', $4, $5, '{}'::jsonb)`,
        [randomUUID(), noteId, OWNER_A, q, "8".repeat(64)],
      );

      const service = new L3ContextService({} as never);
      const deleteCall = service.deleteSource({ userId: OWNER_A, sourceId: src });
      const c1Pid = await backendPid(c1);
      const blocked = await waitForBlockedBy(c1Pid);
      expect(blocked).not.toBeNull(); // 未到达目标窗口即失败
      // 阻塞在 c1 的事务上（FK 交叉检查的 transactionid 等待）——预检查已通过、到达 DELETE 阶段
      expect(blocked!.locktype).toBe("transactionid");

      await c1.query("COMMIT"); // 引用落库 → 删除的 FK RESTRICT 触发
      const error = await deleteCall.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      const meta = (error as ConflictError).meta as { blockers?: { studyNotes?: { id: string }[] } };
      expect(meta.blockers?.studyNotes?.some((b) => b.id === noteId)).toBe(true);

      // S/Q/引用完整（无悬空、无误删）
      const s = await adminPool.query(`SELECT id FROM l3_sources WHERE id = $1`, [src]);
      const qq = await adminPool.query(`SELECT id FROM l3_questions WHERE id = $1`, [q]);
      const rr = await adminPool.query(
        `SELECT id FROM l3_study_note_references WHERE note_id = $1 AND question_id = $2`,
        [noteId, q],
      );
      expect(s.rowCount).toBe(1);
      expect(qq.rowCount).toBe(1);
      expect(rr.rowCount).toBe(1);
    } finally {
      await c1.end().catch(() => undefined);
    }
  });

  it("反向交错：删除先行（未提交）时引用插入被 FK 阻止 → 无悬空引用（记录实际错误码）", async () => {
    const src = randomUUID();
    const q = randomUUID();
    await seedStudySource(adminPool, { id: src, userId: OWNER_A, contentText: "reverse source" });
    await seedStudyQuestion(adminPool, { id: q, userId: OWNER_A, sourceId: src, stem: "reverse stem?" });
    const noteId = (await new L3StudyNoteService().create(OWNER_A, {
      requestId: randomUUID(), venue: "reading_choice",
    })).item.id;

    const c1 = await connectAs(OWNER_A);
    const c2 = await connectAs(OWNER_A);
    try {
      // c1：经实际仓储 SQL 删除 source（未提交；级联至 Q）
      const contextRepo = new L3ContextRepository(c1 as unknown as PoolClient);
      const deleted = await contextRepo.deleteSource(OWNER_A, src);
      expect(deleted).not.toBeNull();

      // c2：插入 Q 引用 → FK 检查等待 c1 的删除
      const c2Pid = await backendPid(c2);
      const insertOutcome = c2
        .query(
          `INSERT INTO l3_study_note_references (id, note_id, user_id, kind, question_id, field_hash, display_snapshot)
           VALUES ($1, $2, $3, 'question', $4, $5, '{}'::jsonb)`,
          [randomUUID(), noteId, OWNER_A, q, "9".repeat(64)],
        )
        .then(() => ({ ok: true as const, code: null as string | null }))
        .catch((e: unknown) => ({ ok: false as const, code: (e as { code?: string }).code ?? null }));
      expect(await waitForLockWait(c2Pid)).toBe(true);

      await c1.query("COMMIT"); // Q 消失 → c2 的 FK 校验失败
      const outcome = await insertOutcome;
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe("23503"); // 实际结果：FK 阻止（无应用层 409 可谈）

      const rr = await adminPool.query(`SELECT id FROM l3_study_note_references WHERE note_id = $1`, [noteId]);
      const s = await adminPool.query(`SELECT id FROM l3_sources WHERE id = $1`, [src]);
      expect(rr.rowCount).toBe(0); // 无悬空引用
      expect(s.rowCount).toBe(0);
    } finally {
      await c2.query("ROLLBACK").catch(() => undefined);
      await c1.end().catch(() => undefined);
      await c2.end().catch(() => undefined);
    }
  });

  it("题目删除 × capture 串行：advisory 锁键大小写归一后为同一把锁（阻塞窗口可观测，预检查路径 409）", async () => {
    const src = randomUUID();
    const q = randomUUID();
    await seedStudySource(adminPool, { id: src, userId: OWNER_A, contentText: "lock source" });
    await seedStudyQuestion(adminPool, { id: q, userId: OWNER_A, sourceId: src, stem: "lock stem?" });
    const noteId = (await new L3StudyNoteService().create(OWNER_A, {
      requestId: randomUUID(), venue: "reading_choice",
    })).item.id;

    const c1 = await connectAs(OWNER_A);
    try {
      // c1（capture 侧）：以实际仓储锁入口持 advisory 锁（大写目标 id —— 锁键归一化）
      const refRepo = new L3StudyReferenceRepository(c1 as unknown as PoolClient);
      await refRepo.lockTargets(OWNER_A, [{ kind: "question", id: expectCaseDifference(q) }]);

      const service = new L3PaperService({} as never, {} as never);
      const deleteCall = service.deleteQuestion({ userId: OWNER_A, questionId: q });
      const c1Pid = await backendPid(c1);
      expect(await waitForBlockedBy(c1Pid)).not.toBeNull(); // 阻塞在同一 advisory 键上

      // 放行：c1 插入引用并提交 → 删除进入预检查 → 409（预检查路径）
      await c1.query(
        `INSERT INTO l3_study_note_references (id, note_id, user_id, kind, question_id, field_hash, display_snapshot)
         VALUES ($1, $2, $3, 'question', $4, $5, '{}'::jsonb)`,
        [randomUUID(), noteId, OWNER_A, q, "7".repeat(64)],
      );
      await c1.query("COMMIT");
      const error = await deleteCall.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      const meta = (error as ConflictError).meta as { blockers?: { studyNotes?: { id: string }[] } };
      expect(meta.blockers?.studyNotes?.some((b) => b.id === noteId)).toBe(true);

      const qq = await adminPool.query(`SELECT id FROM l3_questions WHERE id = $1`, [q]);
      expect(qq.rowCount).toBe(1); // Q 完整
    } finally {
      await c1.end().catch(() => undefined);
    }
  });

  it("题目删除 FK 后备（事务级故障）：预检查不可见的未提交引用 → 23503 → savepoint 恢复 → 409", async () => {
    const src = randomUUID();
    const q = randomUUID();
    await seedStudySource(adminPool, { id: src, userId: OWNER_A, contentText: "fk fallback source" });
    await seedStudyQuestion(adminPool, { id: q, userId: OWNER_A, sourceId: src, stem: "fk fallback stem?" });
    const noteId = (await new L3StudyNoteService().create(OWNER_A, {
      requestId: randomUUID(), venue: "reading_choice",
    })).item.id;

    const c1 = await connectAs(OWNER_A);
    try {
      // c1：不经 advisory 锁直接插入引用（未提交）——删除预检查不可见
      await c1.query(
        `INSERT INTO l3_study_note_references (id, note_id, user_id, kind, question_id, field_hash, display_snapshot)
         VALUES ($1, $2, $3, 'question', $4, $5, '{}'::jsonb)`,
        [randomUUID(), noteId, OWNER_A, q, "6".repeat(64)],
      );

      const service = new L3PaperService({} as never, {} as never);
      const deleteCall = service.deleteQuestion({ userId: OWNER_A, questionId: q });
      const c1Pid = await backendPid(c1);
      const blocked = await waitForBlockedBy(c1Pid);
      expect(blocked).not.toBeNull();
      // 阻塞在 c1 的事务上（DELETE 题目阶段的 FK 交叉检查）——预检查已通过
      expect(blocked!.locktype).toBe("transactionid");

      await c1.query("COMMIT"); // 引用落库 → DELETE 触发 FK RESTRICT
      const error = await deleteCall.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      const meta = (error as ConflictError).meta as { blockers?: { studyNotes?: { id: string }[] } };
      expect(meta.blockers?.studyNotes?.some((b) => b.id === noteId)).toBe(true);

      const qq = await adminPool.query(`SELECT id FROM l3_questions WHERE id = $1`, [q]);
      expect(qq.rowCount).toBe(1);
    } finally {
      await c1.end().catch(() => undefined);
    }
  });
});

// ── F2 · 详情一致快照（真实 PG 交错）────────────────────────────────────────

describe("F2 · 详情一致快照（真实 PG）", () => {
  it("GET 读出 note 行后暂停 → 另一连接提交新正文/引用/归属 → 响应完整属于旧版或新版", async () => {
    const src = randomUUID();
    await seedStudySource(adminPool, { id: src, userId: OWNER_A, contentText: "snapshot source text" });

    const baseline = new L3StudyNoteService();
    const created = await baseline.create(OWNER_A, { requestId: randomUUID(), venue: "reading_choice" });
    const noteId = created.item.id;

    const ref1 = randomUUID();
    const ref2 = randomUUID();
    const bodyV1 = `# V1\n\n[[ref:${ref1}]]`;
    const bodyV2 = `# V2\n\n[[ref:${ref1}]]\n\n[[ref:${ref2}]]`;

    await baseline.save(OWNER_A, noteId, {
      expectedVersion: 1, requestId: randomUUID(), title: "v1", bodyMd: bodyV1,
      venues: ["reading_choice"], pinned: false, status: "active",
      references: [{ id: ref1, action: "capture", target: { kind: "source", sourceId: src } }],
    });

    // GET 交错：在实际仓储 SQL（读出 note 行）之后设可观测屏障。
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let reached = false;
    let getCount = 0;
    const wrappedService = new L3StudyNoteService(
      withTransaction,
      (tx) => {
        const real = {
          studyNotes: new L3StudyNoteRepository(tx),
          studyTopics: new L3StudyTopicRepository(tx),
          studyReferences: new L3StudyReferenceRepository(tx),
        };
        const originalGet = real.studyNotes.get.bind(real.studyNotes);
        real.studyNotes.get = async (userId: string, id: string) => {
          const row = await originalGet(userId, id);
          getCount += 1;
          if (getCount === 1) {
            reached = true; // 屏障：note 行已读出、后续 venues/references 读取尚未发生
            await barrier;
          }
          return row;
        };
        return real as unknown as StudyNoteRepos;
      },
      new L3StudyReferenceService(),
    );

    const getCall = wrappedService.get(OWNER_A, noteId);
    expect(await waitUntil(() => reached)).toBe(true); // 未到达目标窗口即失败

    // 另一连接提交 v2（独立 app 连接，不受 service pool max=1 限制）
    const c2 = await connectAs(OWNER_A);
    try {
      const saveService = new L3StudyNoteService(
        (async (callback: (tx: unknown) => Promise<unknown>) => callback(c2)) as never,
      );
      await saveService.save(OWNER_A, noteId, {
        expectedVersion: 2, requestId: randomUUID(), title: "v2", bodyMd: bodyV2,
        venues: ["reading_choice", "cloze"], pinned: false, status: "active",
        references: [
          { id: ref1, action: "keep" },
          { id: ref2, action: "capture", target: { kind: "source", sourceId: src } },
        ],
      });
      await c2.query("COMMIT");
    } finally {
      await c2.end().catch(() => undefined);
    }

    releaseBarrier();
    const result = await getCall;

    // 响应必须完整属于一个提交：正文 marker 集合 == 引用集合，version/venues 同版
    // （create=1；v1 保存后 version=2；v2 保存后 version=3）
    const dto = result.item;
    const markerIds = [...dto.bodyMd.matchAll(/\[\[ref:([0-9a-fA-F-]{36})\]\]/g)]
      .map((match) => match[1]!.toLowerCase())
      .sort();
    const refIds = dto.references.map((ref) => ref.id).sort();
    expect(markerIds).toEqual(refIds); // 旧正文不得拼新引用（反之亦然）

    if (dto.version === 2) {
      expect(dto.bodyMd).toContain("# V1");
      expect(dto.venues).toEqual(["reading_choice"]);
      expect(refIds).toEqual([ref1]);
    } else {
      expect(dto.version).toBe(3);
      expect(dto.bodyMd).toContain("# V2");
      expect(dto.venues).toEqual(["reading_choice", "cloze"]);
      expect(refIds).toEqual([ref1, ref2].sort());
    }
  });

  it("GET 零写、跨 owner 404、重开读取一致、连接归还后普通写事务仍可写", async () => {
    const svc = new L3StudyNoteService();
    const created = await svc.create(OWNER_A, { requestId: randomUUID(), venue: "reading_choice" });
    const noteId = created.item.id;

    const counts = async (): Promise<Record<string, number>> => {
      const result: Record<string, number> = {};
      for (const table of ["l3_study_notes", "l3_study_note_venues", "l3_study_note_references", "l3_papers", "l3_submissions"]) {
        const row = await adminPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        result[table] = row.rows[0]!.n;
      }
      return result;
    };

    const before = await counts();
    const first = await svc.get(OWNER_A, noteId);
    const second = await svc.get(OWNER_A, noteId); // 重开/恢复读取
    expect(second.item).toEqual(first.item);
    const after = await counts();
    expect(after).toEqual(before); // GET 零写（题纸/作答等计数不变）

    // 跨 owner → 404（RLS 下不可见）
    await expect(svc.get(OWNER_B, noteId)).rejects.toBeInstanceOf(NotFoundError);

    // 连接归还后普通写事务仍可写（READ ONLY 不泄漏到池连接）
    const saved = await svc.save(OWNER_A, noteId, {
      expectedVersion: first.item.version, requestId: randomUUID(), title: "写回",
      bodyMd: "ok", venues: ["reading_choice"], pinned: false, status: "active", references: [],
    });
    expect(saved.item.version).toBe(first.item.version + 1);
  });
});
