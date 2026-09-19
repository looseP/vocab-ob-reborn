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
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetPool } from "@/db/connection";
import { withTransaction } from "@/db/transaction";
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
