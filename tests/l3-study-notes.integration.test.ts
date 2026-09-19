/**
 * 学习笔记（N1）数据库合同集成测试（Task 02）——
 * 在真实 PostgreSQL 上以**受限应用角色**（vocab_app，NOBYPASSRLS、非表属主）
 * 验证 5 张表的 RLS、复合 owner FK、引用约束与删除保护（RESTRICT + 级联链）。
 *
 * 隔离纪律：只在显式指定的验收库运行（TEST_DATABASE_URL / TEST_APP_DATABASE_URL
 * 缺失即失败——不 skip）；fixture owner 为随机 UUID；清理限定本任务记录，
 * 不 truncate 业务表。运行：
 *   TEST_DATABASE_URL=...vocab_study_notes_accept（vocab_migration）
 *   TEST_APP_DATABASE_URL=...vocab_study_notes_accept（vocab_app）
 *   npx vitest run --config vitest.integration.config.ts tests/l3-study-notes.integration.test.ts --maxWorkers=1
 */
import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError } from "@/errors";
import { resetPool } from "@/db/connection";
import { withTransaction } from "@/db/transaction";
import { L3ContextService } from "@/services/l3-context.service";
import { L3PaperService } from "@/services/l3-paper.service";
import { L3StudyNoteService } from "@/services/l3-study-notes.service";
import { L3StudyReferenceService } from "@/services/l3-study-reference.service";
import type { SaveNoteInput } from "@/domain/l3-study-notes";
import type { L3QuestionType } from "@/domain/l3-question-types";
import { L3StudyNoteRepository } from "@/repositories/l3-study-notes.repository";
import { L3StudyTopicRepository } from "@/repositories/l3-study-topics.repository";
import { L3StudyReferenceRepository } from "@/repositories/l3-study-references.repository";
import type { StudyCursor } from "@/repositories/l3-study-cursor";
import {
  cleanupStudyFixture,
  requireStudyNoteTestUrls,
  seedStudyOwners,
  seedStudyQuestion,
  seedStudySource,
} from "./helpers/study-notes-db";

const { adminUrl, appUrl } = requireStudyNoteTestUrls();

const OWNER_A = randomUUID();
const OWNER_B = randomUUID();

const SOURCE_A = randomUUID();
const QUESTION_A = randomUUID();
const SOURCE_B = randomUUID();
const QUESTION_B = randomUUID();
const UNREFERENCED_SOURCE_A = randomUUID();

const SOURCE_A_TEXT = "The quick brown fox jumps over the lazy dog.";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalPoolMax = process.env.DB_POOL_MAX;

const adminPool = new Pool({ connectionString: adminUrl, max: 2 });

/** 在受限角色的 RLS 事务里执行（actorId 注入 request.jwt.claim.sub）。 */
async function inTxAs<T>(actorId: string, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(async (tx) => fn(tx), { actorId });
}

/** 创建一条笔记（受限角色、RLS 路径）。 */
async function createNoteAs(ownerId: string, overrides: { title?: string; body?: string } = {}): Promise<string> {
  const noteId = randomUUID();
  await inTxAs(ownerId, async (tx) => {
    await tx.query(
      `INSERT INTO l3_study_notes (id, user_id, title, body_md, status, pinned, version, create_request_id, create_input_hash)
       VALUES ($1, $2, $3, $4, 'active', false, 1, $5, $6)`,
      [noteId, ownerId, overrides.title ?? "", overrides.body ?? "", randomUUID(), "a".repeat(64)],
    );
  });
  return noteId;
}

/** 管理连接直插（绕过 RLS——复合 FK / CHECK / RESTRICT 的兜底证明）。 */
async function rawInsertNote(ownerId: string): Promise<string> {
  const noteId = randomUUID();
  await adminPool.query(
    `INSERT INTO l3_study_notes (id, user_id, title, body_md, status, pinned, version, create_request_id, create_input_hash)
     VALUES ($1, $2, '', '', 'active', false, 1, $3, $4)`,
    [noteId, ownerId, randomUUID(), "b".repeat(64)],
  );
  return noteId;
}

async function rawInsertReference(input: {
  noteId: string;
  userId: string;
  kind: string;
  sourceId?: string | null;
  questionId?: string | null;
  optionKey?: string | null;
  start?: number | null;
  end?: number | null;
  quote?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await adminPool.query(
    `INSERT INTO l3_study_note_references
       (id, note_id, user_id, kind, source_id, question_id, option_key, start_offset, end_offset, quote_snapshot, field_hash, display_snapshot, captured_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}'::jsonb, now())`,
    [
      id,
      input.noteId,
      input.userId,
      input.kind,
      input.sourceId ?? null,
      input.questionId ?? null,
      input.optionKey ?? null,
      input.start ?? null,
      input.end ?? null,
      input.quote ?? null,
      "c".repeat(64),
    ],
  );
  return id;
}

beforeAll(async () => {
  await seedStudyOwners(adminPool, [OWNER_A, OWNER_B]);
  await seedStudySource(adminPool, { id: SOURCE_A, userId: OWNER_A, contentText: SOURCE_A_TEXT });
  await seedStudyQuestion(adminPool, {
    id: QUESTION_A,
    userId: OWNER_A,
    sourceId: SOURCE_A,
    questionType: "reading_choice",
    stem: "What does the fox do?",
    options: [{ key: "A", text: "jumps over the lazy dog" }],
  });
  await seedStudySource(adminPool, { id: SOURCE_B, userId: OWNER_B, contentText: "B owner source text." });
  await seedStudyQuestion(adminPool, {
    id: QUESTION_B,
    userId: OWNER_B,
    sourceId: SOURCE_B,
    questionType: "reading_choice",
    stem: "B owner question?",
  });
  await seedStudySource(adminPool, { id: UNREFERENCED_SOURCE_A, userId: OWNER_A, contentText: "Never referenced." });

  // 切换到受限应用角色（生产同款 env：DATABASE_URL 指向 vocab_app）
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

describe("学习笔记存储 · RLS（受限角色）", () => {
  it("owner 可从零创建空白笔记（无 source/sheet/word 依赖）并归属题型", async () => {
    const noteId = await createNoteAs(OWNER_A, { title: "自由笔记", body: "# 标题\n\n正文" });
    await inTxAs(OWNER_A, async (tx) => {
      await tx.query(
        `INSERT INTO l3_study_note_venues (note_id, user_id, question_type) VALUES ($1, $2, 'reading_choice')`,
        [noteId, OWNER_A],
      );
    });
    const row = await adminPool.query<{ title: string; version: number }>(
      `SELECT title, version FROM l3_study_notes WHERE id = $1`,
      [noteId],
    );
    expect(row.rows[0]).toMatchObject({ title: "自由笔记", version: 1 });
  });

  it("B 读不到 A 的笔记（SELECT 被 RLS 过滤）且看不到 A 的归属行", async () => {
    const noteId = await createNoteAs(OWNER_A, { title: "A 的私有笔记" });
    const seen = await inTxAs(OWNER_B, async (tx) => {
      const notes = await tx.query(`SELECT id FROM l3_study_notes WHERE id = $1`, [noteId]);
      const venues = await tx.query(`SELECT note_id FROM l3_study_note_venues WHERE note_id = $1`, [noteId]);
      return { notes: notes.rowCount, venues: venues.rowCount };
    });
    expect(seen).toEqual({ notes: 0, venues: 0 });
  });

  it("冒名插入（actor=A 写 user_id=B）被 RLS WITH CHECK 拒绝", async () => {
    await expect(
      inTxAs(OWNER_A, async (tx) => {
        await tx.query(
          `INSERT INTO l3_study_notes (id, user_id, title, body_md, status, pinned, version, create_request_id, create_input_hash)
           VALUES ($1, $2, '', '', 'active', false, 1, $3, $4)`,
          [randomUUID(), OWNER_B, randomUUID(), "d".repeat(64)],
        );
      }),
    ).rejects.toThrow(/row-level security|violates row-level|new row violates/i);
  });
});

describe("学习笔记存储 · 复合 owner FK（绕 RLS 的数据库兜底）", () => {
  it("venue 的 note/user 不匹配（A 的 note + B 的 user_id）被复合 FK 拒绝", async () => {
    const noteId = await rawInsertNote(OWNER_A);
    await expect(
      adminPool.query(
        `INSERT INTO l3_study_note_venues (note_id, user_id, question_type) VALUES ($1, $2, 'cloze')`,
        [noteId, OWNER_B],
      ),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it("引用行 note/user 不匹配被复合 FK 拒绝", async () => {
    const noteId = await rawInsertNote(OWNER_A);
    await expect(
      rawInsertReference({ noteId, userId: OWNER_B, kind: "source", sourceId: SOURCE_B }),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it("引用他人 source（A 的 note 指向 B 的 source）被复合 FK 拒绝", async () => {
    const noteId = await rawInsertNote(OWNER_A);
    await expect(
      rawInsertReference({ noteId, userId: OWNER_A, kind: "source", sourceId: SOURCE_B }),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });
});

describe("学习笔记存储 · 约束（CHECK/UNIQUE/主键）", () => {
  it("venues：题型 CHECK 与重复主键拒绝", async () => {
    const noteId = await rawInsertNote(OWNER_A);
    await adminPool.query(
      `INSERT INTO l3_study_note_venues (note_id, user_id, question_type) VALUES ($1, $2, 'cloze')`,
      [noteId, OWNER_A],
    );
    await expect(
      adminPool.query(
        `INSERT INTO l3_study_note_venues (note_id, user_id, question_type) VALUES ($1, $2, 'not_a_venue')`,
        [noteId, OWNER_A],
      ),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      adminPool.query(
        `INSERT INTO l3_study_note_venues (note_id, user_id, question_type) VALUES ($1, $2, 'cloze')`,
        [noteId, OWNER_A],
      ),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("topics：空标题与非法题型被 CHECK 拒绝", async () => {
    await expect(
      adminPool.query(
        `INSERT INTO l3_study_topics (id, user_id, question_type, title, status, version, create_request_id, create_input_hash)
         VALUES ($1, $2, 'reading_choice', '', 'active', 1, $3, $4)`,
        [randomUUID(), OWNER_A, randomUUID(), "e".repeat(64)],
      ),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      adminPool.query(
        `INSERT INTO l3_study_topics (id, user_id, question_type, title, status, version, create_request_id, create_input_hash)
         VALUES ($1, $2, 'bad_type', '专题', 'active', 1, $3, $4)`,
        [randomUUID(), OWNER_A, randomUUID(), "e".repeat(64)],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("引用的 kind 五值枚举外被 CHECK 拒绝", async () => {
    const noteId = await rawInsertNote(OWNER_A);
    await expect(
      rawInsertReference({ noteId, userId: OWNER_A, kind: "attempt", sourceId: SOURCE_A }),
    ).rejects.toThrow(/check constraint/i);
  });

  it("引用恰一 target：source 类带 question_id 拒绝；question 类带 source_id 拒绝", async () => {
    const noteId = await rawInsertNote(OWNER_A);
    await expect(
      rawInsertReference({ noteId, userId: OWNER_A, kind: "source", sourceId: SOURCE_A, questionId: QUESTION_A }),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      rawInsertReference({ noteId, userId: OWNER_A, kind: "question", questionId: QUESTION_A, sourceId: SOURCE_A }),
    ).rejects.toThrow(/check constraint/i);
  });

  it("quote 类必须带 offset 与 quote 快照（source_quote 缺坐标拒绝）", async () => {
    const noteId = await rawInsertNote(OWNER_A);
    await expect(
      rawInsertReference({ noteId, userId: OWNER_A, kind: "source_quote", sourceId: SOURCE_A }),
    ).rejects.toThrow(/check constraint/i);
  });

  it("option_quote 必须带 option_key；非 option_quote 不得携带", async () => {
    const noteId = await rawInsertNote(OWNER_A);
    await expect(
      rawInsertReference({
        noteId, userId: OWNER_A, kind: "option_quote", questionId: QUESTION_A,
        start: 0, end: 3, quote: "abc", optionKey: null,
      }),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      rawInsertReference({
        noteId, userId: OWNER_A, kind: "stem_quote", questionId: QUESTION_A,
        start: 0, end: 3, quote: "abc", optionKey: "A",
      }),
    ).rejects.toThrow(/check constraint/i);
  });

  it("端到端：五种合法引用均可落库（kind 覆盖）", async () => {
    const noteId = await rawInsertNote(OWNER_A);
    await rawInsertReference({ noteId, userId: OWNER_A, kind: "source", sourceId: SOURCE_A });
    await rawInsertReference({
      noteId, userId: OWNER_A, kind: "source_quote", sourceId: SOURCE_A,
      start: 0, end: 3, quote: "The",
    });
    await rawInsertReference({ noteId, userId: OWNER_A, kind: "question", questionId: QUESTION_A });
    await rawInsertReference({
      noteId, userId: OWNER_A, kind: "stem_quote", questionId: QUESTION_A,
      start: 0, end: 4, quote: "What",
    });
    await rawInsertReference({
      noteId, userId: OWNER_A, kind: "option_quote", questionId: QUESTION_A, optionKey: "A",
      start: 0, end: 5, quote: "jumps",
    });
    const count = await adminPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM l3_study_note_references WHERE note_id = $1`,
      [noteId],
    );
    expect(count.rows[0]!.n).toBe("5");
    // fixture 纪律：本用例引用即清，避免跨用例污染后续删除保护场景。
    await adminPool.query(`DELETE FROM l3_study_note_references WHERE note_id = $1`, [noteId]);
  });
});

describe("学习笔记存储 · 删除保护（RESTRICT + 级联链截断）", () => {
  it("被直接引用的 source 删除被 RESTRICT 阻止；清引用后可删（非误杀）", async () => {
    const src = randomUUID();
    await seedStudySource(adminPool, { id: src, userId: OWNER_A, contentText: "restrict direct case" });
    const noteId = await rawInsertNote(OWNER_A);
    await rawInsertReference({ noteId, userId: OWNER_A, kind: "source", sourceId: src });
    await expect(
      adminPool.query(`DELETE FROM l3_sources WHERE id = $1`, [src]),
    ).rejects.toThrow(/violates foreign key constraint|update or delete/i);
    await adminPool.query(`DELETE FROM l3_study_note_references WHERE note_id = $1`, [noteId]);
    await adminPool.query(`DELETE FROM l3_sources WHERE id = $1`, [src]);
    const gone = await adminPool.query(`SELECT id FROM l3_sources WHERE id = $1`, [src]);
    expect(gone.rowCount).toBe(0);
  });

  it("仅被其子题引用（直接 source 引用为空）的 source 删除同样被阻止（级联链截断）", async () => {
    const src = randomUUID();
    const q = randomUUID();
    await seedStudySource(adminPool, { id: src, userId: OWNER_A, contentText: "restrict cascade case" });
    await seedStudyQuestion(adminPool, { id: q, userId: OWNER_A, sourceId: src, stem: "child question" });
    const noteId = await rawInsertNote(OWNER_A);
    await rawInsertReference({
      noteId, userId: OWNER_A, kind: "stem_quote", questionId: q,
      start: 0, end: 5, quote: "child",
    });
    // 前置断言：该 source 无直接引用（本用例只证明子题链条也能截断级联删除）
    const direct = await adminPool.query(`SELECT id FROM l3_study_note_references WHERE source_id = $1`, [src]);
    expect(direct.rowCount).toBe(0);
    await expect(
      adminPool.query(`DELETE FROM l3_sources WHERE id = $1`, [src]),
    ).rejects.toThrow(/violates foreign key constraint|update or delete/i);
    // 清引用后整条链可删
    await adminPool.query(`DELETE FROM l3_study_note_references WHERE note_id = $1`, [noteId]);
    await adminPool.query(`DELETE FROM l3_questions WHERE id = $1`, [q]);
    await adminPool.query(`DELETE FROM l3_sources WHERE id = $1`, [src]);
  });

  it("未被引用的对象删除仍按原合同运行（回归）", async () => {
    await adminPool.query(`DELETE FROM l3_sources WHERE id = $1`, [UNREFERENCED_SOURCE_A]);
    const gone = await adminPool.query(`SELECT id FROM l3_sources WHERE id = $1`, [UNREFERENCED_SOURCE_A]);
    expect(gone.rowCount).toBe(0);
  });

  it("笔记删除级联清空其 venue/引用（CASCADE 方向）", async () => {
    const noteId = await rawInsertNote(OWNER_A);
    await adminPool.query(
      `INSERT INTO l3_study_note_venues (note_id, user_id, question_type) VALUES ($1, $2, 'cloze')`,
      [noteId, OWNER_A],
    );
    await rawInsertReference({ noteId, userId: OWNER_A, kind: "source", sourceId: SOURCE_A });
    await adminPool.query(`DELETE FROM l3_study_notes WHERE id = $1`, [noteId]);
    const venues = await adminPool.query(`SELECT note_id FROM l3_study_note_venues WHERE note_id = $1`, [noteId]);
    const refs = await adminPool.query(`SELECT id FROM l3_study_note_references WHERE note_id = $1`, [noteId]);
    expect(venues.rowCount).toBe(0);
    expect(refs.rowCount).toBe(0);
  });
});

// ── Task 03：并发窗口与规模（deferred/锁观测屏障，不依赖 sleep 断言）────────

/** 以受限角色打开独立连接并开启 RLS 事务（并发测试专用，不走 pool）。 */
async function connectAs(actorId: string): Promise<Client> {
  const client = new Client({ connectionString: appUrl });
  await client.connect();
  await client.query("BEGIN");
  await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [actorId]);
  return client;
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

async function backendPid(client: Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
  return rows[0]!.pid;
}

describe("学习笔记存储 · 并发窗口（Task 03）", () => {
  it("同版本并发保存一胜一冲突：版本只推进一次（行锁 + CAS，pg_locks 观测到达路径）", async () => {
    const noteId = randomUUID();
    await adminPool.query(
      `INSERT INTO l3_study_notes (id, user_id, title, body_md, status, pinned, version, create_request_id, create_input_hash)
       VALUES ($1, $2, '并发基线', '', 'active', false, 1, $3, $4)`,
      [noteId, OWNER_A, randomUUID(), "f".repeat(64)],
    );
    const casSql = `UPDATE l3_study_notes
        SET title = $3, body_md = '', status = 'active', pinned = false,
            version = version + 1, last_write_request_id = $4::uuid, last_write_hash = $5, updated_at = now()
      WHERE id = $1::uuid AND user_id = $2::uuid AND version = 1`;

    const c1 = await connectAs(OWNER_A);
    const c2 = await connectAs(OWNER_A);
    try {
      const c1Res = await c1.query(casSql, [noteId, OWNER_A, "c1", randomUUID(), "1".repeat(64)]);
      expect(c1Res.rowCount).toBe(1);

      const c2Pid = await backendPid(c2);
      const c2Promise = c2.query(casSql, [noteId, OWNER_A, "c2", randomUUID(), "2".repeat(64)]);
      // 屏障：c2 的锁请求进入等待（绑定 c2 的 PID，非"集群任意锁等待"）
      expect(await waitForLockWait(c2Pid)).toBe(true);

      await c1.query("COMMIT");
      const c2Res = await c2Promise;
      expect(c2Res.rowCount).toBe(0); // CAS 失配（不再是 1）→ 0 行
      await c2.query("COMMIT");

      const { rows } = await adminPool.query<{ version: number; title: string }>(
        `SELECT version, title FROM l3_study_notes WHERE id = $1`,
        [noteId],
      );
      expect(rows[0]).toMatchObject({ version: 2, title: "c1" }); // 只推进一次、旧版本未覆盖新版本
    } finally {
      await c1.end().catch(() => undefined);
      await c2.end().catch(() => undefined);
    }
  });

  it("capture 持锁期间源删除被阻塞（FOR SHARE 屏障），提交后释放", async () => {
    const src = randomUUID();
    await seedStudySource(adminPool, { id: src, userId: OWNER_A, contentText: "lock target text" });
    const c1 = await connectAs(OWNER_A);
    const c2 = await connectAs(OWNER_A);
    try {
      await new L3StudyReferenceRepository(c1 as unknown as PoolClient).lockTargets(OWNER_A, [
        { kind: "source", id: src },
      ]);

      const c2Pid = await backendPid(c2);
      const deletePromise = c2.query(`DELETE FROM l3_sources WHERE id = $1`, [src]);
      expect(await waitForLockWait(c2Pid)).toBe(true); // 删除等待共享锁

      await c1.query("COMMIT");
      const deleteRes = await deletePromise;
      expect(deleteRes.rowCount).toBe(1); // 无引用冲突时释放后可删
      await c2.query("COMMIT");
    } finally {
      await c1.end().catch(() => undefined);
      await c2.end().catch(() => undefined);
    }
  });

  it("121 条笔记跨页完整访问：分页遍历无重复无遗漏（limit 50 × 3 页）", async () => {
    const seeded = await adminPool.query<{ id: string }>(
      `INSERT INTO l3_study_notes (id, user_id, title, body_md, status, pinned, version, create_request_id, create_input_hash)
       SELECT gen_random_uuid(), $1::uuid, '批量笔记 ' || g, '', 'active', false, 1, gen_random_uuid(), $2
         FROM generate_series(1, 121) AS g
       RETURNING id`,
      [OWNER_A, "3".repeat(64)],
    );
    const seededIds = seeded.rows.map((r) => r.id);
    await adminPool.query(
      `INSERT INTO l3_study_note_venues (note_id, user_id, question_type)
       SELECT unnest($2::uuid[]), $1::uuid, 'reading_choice'`,
      [OWNER_A, seededIds],
    );

    const collected: string[] = [];
    let cursor: StudyCursor | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result = await withTransaction(
        (tx) =>
          new L3StudyNoteRepository(tx).list({
            userId: OWNER_A, venue: "reading_choice", q: "批量笔记", status: null, pinned: null,
            topicId: null, unfiled: false, cursor, limit: 50,
          }),
        { actorId: OWNER_A },
      );
      expect(result.total).toBe(121); // 过滤总数不随翻页变化
      collected.push(...result.items.map((row) => row.id));
      if (result.items.length < 50) break;
      const last = result.items[result.items.length - 1]!;
      cursor = { sortKind: "updatedAt", lastSort: last.updated_at, id: last.id, filter: "0123456789abcdef" };
    }
    expect(collected.length).toBe(121);
    expect(new Set(collected).size).toBe(121);
    expect(new Set(collected)).toEqual(new Set(seededIds));
  });

  it("55 个专题跨页访问 + 成员重排 0..n-1（repo 层真实 PG）", async () => {
    // 55 专题 seed（reading_choice）
    const topicSeeded = await adminPool.query<{ id: string }>(
      `INSERT INTO l3_study_topics (id, user_id, question_type, title, status, version, create_request_id, create_input_hash)
       SELECT gen_random_uuid(), $1::uuid, 'reading_choice', '专题 ' || g, 'active', 1, gen_random_uuid(), $2
         FROM generate_series(1, 55) AS g
       RETURNING id`,
      [OWNER_A, "4".repeat(64)],
    );
    const topicIds = topicSeeded.rows.map((r) => r.id);

    const collected: string[] = [];
    let cursor: { updatedAt: string; id: string } | null = null;
    for (let page = 0; page < 4; page += 1) {
      const result = await withTransaction(
        (tx) =>
          new L3StudyTopicRepository(tx as unknown as PoolClient).list({
            userId: OWNER_A, questionType: "reading_choice", status: null, cursor, limit: 20,
          }),
        { actorId: OWNER_A },
      );
      expect(result.total).toBe(55);
      collected.push(...result.items.map((row) => row.id));
      if (result.items.length < 20) break;
      const last = result.items[result.items.length - 1]!;
      cursor = { updatedAt: last.updated_at, id: last.id };
    }
    expect(collected.length).toBe(55);
    expect(new Set(collected).size).toBe(55);

    // 成员重排：3 个成员按任意顺序重排为 0..n-1
    const topicId = topicIds[0]!;
    const noteSeeded = await adminPool.query<{ id: string }>(
      `INSERT INTO l3_study_notes (id, user_id, title, body_md, status, pinned, version, create_request_id, create_input_hash)
       SELECT gen_random_uuid(), $1::uuid, '重排笔记 ' || g, '', 'active', false, 1, gen_random_uuid(), $2
         FROM generate_series(1, 3) AS g
       RETURNING id`,
      [OWNER_A, "5".repeat(64)],
    );
    const [n1, n2, n3] = noteSeeded.rows.map((r) => r.id) as [string, string, string];
    await adminPool.query(
      `INSERT INTO l3_study_note_venues (note_id, user_id, question_type)
       SELECT unnest($2::uuid[]), $1::uuid, 'reading_choice'`,
      [OWNER_A, [n1, n2, n3]],
    );
    await adminPool.query(
      `INSERT INTO l3_study_topic_notes (topic_id, note_id, user_id, position)
       SELECT $1::uuid, unnest($2::uuid[]), $3::uuid, 0`,
      [topicId, [n1, n2, n3], OWNER_A],
    );
    await withTransaction(
      async (tx) => {
        const repo = new L3StudyTopicRepository(tx as unknown as PoolClient);
        await repo.replaceMemberPositions(OWNER_A, topicId, [n3, n1, n2]);
        const members = await repo.listMembers(OWNER_A, topicId);
        expect(members.map((m) => m.note_id)).toEqual([n3, n1, n2]);
        expect(members.map((m) => m.position)).toEqual([0, 1, 2]);
        expect(await repo.countMembers(OWNER_A, topicId)).toBe(3);
      },
      { actorId: OWNER_A },
    );
  });
});

// ── Task 04：引用保护与删除并发（service 预检查 + FK RESTRICT 兜底）─────────

describe("引用保护与删除（Task 04）", () => {
  it("被学习笔记引用的 source：删除 409（可读 blocker），清引用后按原合同可删", async () => {
    const src = randomUUID();
    await seedStudySource(adminPool, { id: src, userId: OWNER_A, contentText: "protected source text" });
    const noteId = await rawInsertNote(OWNER_A);
    await adminPool.query(`UPDATE l3_study_notes SET title = '受保护笔记' WHERE id = $1`, [noteId]);
    await rawInsertReference({ noteId, userId: OWNER_A, kind: "source", sourceId: src });

    // 真实 service（txRunner/factory 默认走 appUrl 受限连接）
    const service = new L3ContextService({} as never);
    const error = await service.deleteSource({ userId: OWNER_A, sourceId: src }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    const meta = (error as ConflictError).meta as {
      blockers?: { studyNotes?: { id: string; title: string; referenceCount: number }[] };
    };
    expect(meta.blockers?.studyNotes).toEqual([
      expect.objectContaining({ id: noteId, title: "受保护笔记", referenceCount: 1 }),
    ]);

    // 移除引用（或转普通摘录）后，删除回到原合同
    await adminPool.query(`DELETE FROM l3_study_note_references WHERE note_id = $1`, [noteId]);
    const result = await service.deleteSource({ userId: OWNER_A, sourceId: src });
    expect(result.deleted).toEqual({ entityType: "source", id: src });
  });

  it("被学习笔记引用的 question：删除 409，清引用后可删", async () => {
    const src = randomUUID();
    const q = randomUUID();
    await seedStudySource(adminPool, { id: src, userId: OWNER_A, contentText: "q source" });
    await seedStudyQuestion(adminPool, { id: q, userId: OWNER_A, sourceId: src, stem: "protected stem" });
    const noteId = await rawInsertNote(OWNER_A);
    await rawInsertReference({
      noteId, userId: OWNER_A, kind: "stem_quote", questionId: q,
      start: 0, end: 9, quote: "protected",
    });

    const service = new L3PaperService({} as never, {} as never);
    const error = await service.deleteQuestion({ userId: OWNER_A, questionId: q }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    const meta = (error as ConflictError).meta as {
      blockers?: { studyNotes?: { id: string; title: string }[] };
    };
    expect(meta.blockers?.studyNotes?.[0]).toMatchObject({ id: noteId });

    await adminPool.query(`DELETE FROM l3_study_note_references WHERE note_id = $1`, [noteId]);
    await expect(service.deleteQuestion({ userId: OWNER_A, questionId: q })).resolves.toEqual({ deleted: true });
  });

  it("并发交错 A：capture 持锁插入（未提交）时删除被 FK RESTRICT 阻止（无悬空引用）", async () => {
    const src = randomUUID();
    await seedStudySource(adminPool, { id: src, userId: OWNER_A, contentText: "concurrent A" });
    const c1 = await connectAs(OWNER_A);
    const c2 = await connectAs(OWNER_A);
    try {
      // c1（capture/保存事务）：FOR SHARE 锁目标 → 插入引用（未提交）
      const refRepo = new L3StudyReferenceRepository(c1 as unknown as PoolClient);
      await refRepo.lockTargets(OWNER_A, [{ kind: "source", id: src }]);
      const noteId = randomUUID();
      await c1.query(
        `INSERT INTO l3_study_notes (id, user_id, title, body_md, status, pinned, version, create_request_id, create_input_hash)
         VALUES ($1, $2, '', '', 'active', false, 1, $3, $4)`,
        [noteId, OWNER_A, randomUUID(), "7".repeat(64)],
      );
      await c1.query(
        `INSERT INTO l3_study_note_references (id, note_id, user_id, kind, source_id, field_hash, display_snapshot)
         VALUES ($1, $2, $3, 'source', $4, $5, '{}'::jsonb)`,
        [randomUUID(), noteId, OWNER_A, src, "8".repeat(64)],
      );

      // c2：删除 source —— 阻塞于 c1 的 FOR SHARE
      const c2Pid = await backendPid(c2);
      const deleteOutcome = c2
        .query(`DELETE FROM l3_sources WHERE id = $1`, [src])
        .then(() => ({ ok: true as const, code: null as string | null }))
        .catch((e: unknown) => ({ ok: false as const, code: (e as { code?: string }).code ?? null }));
      expect(await waitForLockWait(c2Pid)).toBe(true);

      // c1 提交（引用落库）→ c2 的删除被执行 → FK RESTRICT 拒绝
      await c1.query("COMMIT");
      const outcome = await deleteOutcome;
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe("23503");

      // 无悬空：source 仍在、引用完好
      const sourceStill = await adminPool.query(`SELECT id FROM l3_sources WHERE id = $1`, [src]);
      expect(sourceStill.rowCount).toBe(1);
      const refs = await adminPool.query(`SELECT id FROM l3_study_note_references WHERE source_id = $1`, [src]);
      expect(refs.rowCount).toBe(1);
    } finally {
      await c2.query("ROLLBACK").catch(() => undefined);
      await c1.end().catch(() => undefined);
      await c2.end().catch(() => undefined);
    }
  });

  it("并发交错 B：删除先行（未提交）时引用插入被 FK 阻止（不能产生悬空引用）", async () => {
    const src = randomUUID();
    await seedStudySource(adminPool, { id: src, userId: OWNER_A, contentText: "concurrent B" });
    const noteId = await rawInsertNote(OWNER_A);
    const c1 = await connectAs(OWNER_A);
    const c2 = await connectAs(OWNER_A);
    try {
      // c1：DELETE source（排他锁，未提交）
      await c1.query(`DELETE FROM l3_sources WHERE id = $1`, [src]);

      // c2：插入引用 —— FK 检查等待 c1 的排他锁
      const c2Pid = await backendPid(c2);
      const insertOutcome = c2
        .query(
          `INSERT INTO l3_study_note_references (id, note_id, user_id, kind, source_id, field_hash, display_snapshot)
           VALUES ($1, $2, $3, 'source', $4, $5, '{}'::jsonb)`,
          [randomUUID(), noteId, OWNER_A, src, "9".repeat(64)],
        )
        .then(() => ({ ok: true as const, code: null as string | null }))
        .catch((e: unknown) => ({ ok: false as const, code: (e as { code?: string }).code ?? null }));
      expect(await waitForLockWait(c2Pid)).toBe(true);

      // c1 提交（source 消失）→ c2 的 FK 校验失败
      await c1.query("COMMIT");
      const outcome = await insertOutcome;
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe("23503");

      const refs = await adminPool.query(`SELECT id FROM l3_study_note_references WHERE source_id = $1`, [src]);
      expect(refs.rowCount).toBe(0);
    } finally {
      await c2.query("ROLLBACK").catch(() => undefined);
      await c1.end().catch(() => undefined);
      await c2.end().catch(() => undefined);
    }
  });
});

// ── Task 05：笔记/专题服务全链（真实 PG，经受限连接与 RLS）─────────────────

describe("学习笔记服务 · 真实 PG（Task 05）", () => {
  it("全链：创建 → 保存（capture 引用）→ 读取预览 → 原文变化标 changed（旧摘录原样保留）", async () => {
    const src = randomUUID();
    const q = randomUUID();
    await seedStudySource(adminPool, { id: src, userId: OWNER_A, contentText: "Chain test source." });
    await seedStudyQuestion(adminPool, {
      id: q, userId: OWNER_A, sourceId: src, stem: "Original stem question?",
      options: [{ key: "A", text: "alpha" }],
    });

    const service = new L3StudyNoteService();
    const created = await service.create(OWNER_A, { requestId: randomUUID(), venue: "reading_choice" });
    const noteId = created.item.id;
    expect(created.created).toBe(true);

    const refId = randomUUID();
    const saveInput: SaveNoteInput = {
      expectedVersion: 1,
      requestId: randomUUID(),
      title: "全链笔记",
      bodyMd: `我的分析：\n\n[[ref:${refId}]]`,
      venues: ["reading_choice"],
      pinned: false,
      status: "active",
      references: [{
        id: refId,
        action: "capture",
        target: { kind: "stem_quote", questionId: q, start: 0, end: 8, quote: "Original" },
      }],
    };
    const saved = await service.save(OWNER_A, noteId, saveInput);
    expect(saved.item.version).toBe(2);
    expect(saved.item.references).toHaveLength(1);
    expect(saved.item.references[0]!.status).toBe("current");
    expect(saved.item.references[0]!.target).toEqual({
      kind: "stem_quote", questionId: q, start: 0, end: 8, quote: "Original",
    });

    // 原文改写 → changed：旧摘录与旧 offset 原样保留（不重定位）
    await adminPool.query(`UPDATE l3_questions SET stem = 'Rewritten entirely.' WHERE id = $1`, [q]);
    const after = await service.get(OWNER_A, noteId);
    expect(after.item.references[0]!.status).toBe("changed");
    expect(after.item.references[0]!.target).toMatchObject({ start: 0, end: 8, quote: "Original" });
    expect((after.item.references[0]!.displaySnapshot as { quote?: string }).quote).toBe("Original");
  });

  it("幂等与版本：同 requestId 重试不二次推进；旧版本新请求 409 只带 currentVersion", async () => {
    const service = new L3StudyNoteService();
    const created = await service.create(OWNER_A, { requestId: randomUUID(), venue: "cloze" });
    const noteId = created.item.id;
    const base: Omit<SaveNoteInput, "requestId"> = {
      expectedVersion: 1,
      title: "幂等真库",
      bodyMd: "",
      venues: ["cloze"],
      pinned: false,
      status: "active",
      references: [],
    };
    const req = randomUUID();
    const first = await service.save(OWNER_A, noteId, { ...base, requestId: req });
    expect(first.item.version).toBe(2);
    const retry = await service.save(OWNER_A, noteId, { ...base, requestId: req });
    expect(retry.item.version).toBe(2); // 不二次推进

    const stale = await service
      .save(OWNER_A, noteId, { ...base, requestId: randomUUID() })
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(ConflictError);
    expect((stale as ConflictError).meta).toMatchObject({ currentVersion: 2 });
  });

  it("专题成员真库：加入/计数、跨题型 409、归档后成员只读 409", async () => {
    const service = new L3StudyNoteService();
    const noteA = (await service.create(OWNER_A, { requestId: randomUUID(), venue: "reading_choice" })).item.id;
    const noteB = (await service.create(OWNER_A, { requestId: randomUUID(), venue: "cloze" })).item.id;
    const topic = (
      await service.createTopic(OWNER_A, { requestId: randomUUID(), venue: "reading_choice", title: "链路专题" })
    ).item;

    const moved = await service.moveTopicMember(OWNER_A, topic.id, noteA, {
      requestId: randomUUID(), expectedVersion: 1, beforeNoteId: null,
    });
    expect(moved.item.memberCount).toBe(1);
    expect(moved.item.version).toBe(2);

    await expect(
      service.moveTopicMember(OWNER_A, topic.id, noteB, {
        requestId: randomUUID(), expectedVersion: 2, beforeNoteId: null,
      }),
    ).rejects.toThrow(ConflictError); // 跨题型未归属

    await service.saveTopic(OWNER_A, topic.id, {
      requestId: randomUUID(), expectedVersion: 2, title: "链路专题", status: "archived",
    });
    await expect(
      service.moveTopicMember(OWNER_A, topic.id, noteA, {
        requestId: randomUUID(), expectedVersion: 3, beforeNoteId: null,
      }),
    ).rejects.toThrow(ConflictError); // 归档不能改成员
  });

  it("归属↔成员不变量（真库）：在专题中移归属 409；移归属后加入专题 409", async () => {
    const service = new L3StudyNoteService();
    const noteA = (await service.create(OWNER_A, { requestId: randomUUID(), venue: "reading_choice" })).item.id;
    const topic = (
      await service.createTopic(OWNER_A, { requestId: randomUUID(), venue: "reading_choice", title: "不变量专题" })
    ).item;
    await service.moveTopicMember(OWNER_A, topic.id, noteA, {
      requestId: randomUUID(), expectedVersion: 1, beforeNoteId: null,
    });

    // 方向一：note 仍在专题中 → 移除归属被 409 阻止（列出专题）
    await expect(
      service.save(OWNER_A, noteA, {
        expectedVersion: 1, requestId: randomUUID(), title: "", bodyMd: "",
        venues: ["cloze"], pinned: false, status: "active", references: [],
      }),
    ).rejects.toThrow(ConflictError);

    // 方向二：另一 note 先移除归属，再加入专题 → 409（跨题型）
    const noteC = (await service.create(OWNER_A, { requestId: randomUUID(), venue: "reading_choice" })).item.id;
    await service.save(OWNER_A, noteC, {
      expectedVersion: 1, requestId: randomUUID(), title: "", bodyMd: "",
      venues: ["cloze"], pinned: false, status: "active", references: [],
    });
    await expect(
      service.moveTopicMember(OWNER_A, topic.id, noteC, {
        requestId: randomUUID(), expectedVersion: 2, beforeNoteId: null,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("note 行锁互斥（save 与成员操作共享锁机制）：pg_locks 绑定 PID 观测", async () => {
    const service = new L3StudyNoteService();
    const noteId = (await service.create(OWNER_A, { requestId: randomUUID(), venue: "reading_choice" })).item.id;
    const c1 = await connectAs(OWNER_A);
    const c2 = await connectAs(OWNER_A);
    try {
      await c1.query(
        `SELECT id FROM l3_study_notes WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
        [noteId, OWNER_A],
      );
      const c2Pid = await backendPid(c2);
      const lockPromise = c2.query(
        `SELECT id FROM l3_study_notes WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
        [noteId, OWNER_A],
      );
      expect(await waitForLockWait(c2Pid)).toBe(true);
      await c1.query("COMMIT");
      const result = await lockPromise;
      expect(result.rowCount).toBe(1);
      await c2.query("COMMIT");
    } finally {
      await c1.end().catch(() => undefined);
      await c2.end().catch(() => undefined);
    }
  });

  it("search（question kind）与 backlinks 在真实 PG 上闭环（摘要不含答案）", async () => {
    const src = randomUUID();
    const q = randomUUID();
    await seedStudySource(adminPool, { id: src, userId: OWNER_A, contentText: "search source" });
    await seedStudyQuestion(adminPool, {
      id: q, userId: OWNER_A, sourceId: src, stem: "Unique-searchable-stem-xyz",
    });
    const refService = new L3StudyReferenceService();
    const found = await refService.search(OWNER_A, { kind: "question", q: "Unique-searchable-stem-xyz" });
    expect(found.items.some((item) => item.id === q)).toBe(true);
    expect(found.items[0]).not.toHaveProperty("answer");
    expect(found.total).toBeGreaterThanOrEqual(1);

    const noteId = await rawInsertNote(OWNER_A);
    await rawInsertReference({
      noteId, userId: OWNER_A, kind: "stem_quote", questionId: q, start: 0, end: 6, quote: "Unique",
    });
    const back = await refService.backlinks(OWNER_A, { targetKind: "question", targetId: q });
    expect(back.items.some((item) => item.note_id === noteId)).toBe(true);
    expect(back.items.find((item) => item.note_id === noteId)!.reference_count).toBeGreaterThanOrEqual(1);
    await adminPool.query(`DELETE FROM l3_study_note_references WHERE note_id = $1`, [noteId]);
  });
});
