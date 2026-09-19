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
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetPool } from "@/db/connection";
import { L3StudyNoteService } from "@/services/l3-study-notes.service";
import { L3StudyReferenceService } from "@/services/l3-study-reference.service";
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
 * 并返回该等待者的 pid 与其当前语句（供断言确实到达目标窗口）。
 */
async function waitForBlockedBy(
  blockerPid: number,
  deadlineMs = 5000,
): Promise<{ pid: number; query: string } | null> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const { rows } = await adminPool.query<{ pid: number; query: string }>(
      `SELECT l.pid, a.query
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
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
