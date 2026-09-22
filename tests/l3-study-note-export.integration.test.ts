/**
 * Task 10 · 导出只读纪律与生命周期闭环（**真实 PostgreSQL**）。
 *
 * 任务书 §3.2 B9/B10/B12 点名的真库证据：
 *  - 题纸不新增（`submissions` 行数不变）；
 *  - 作答不变化（`l3_question_attempts` 行数不变）；
 *  - 导出不产生业务写入（notes/venues/topics/refs 的 version / 行数 / updated_at 不变）。
 *
 * 隔离纪律（同 `tests/l3-study-notes.integration.test.ts`）：只在显式指定的验收库运行，
 * `TEST_DATABASE_URL` / `TEST_APP_DATABASE_URL` 缺失即失败——**不 skip**；fixture owner
 * 为随机 UUID，清理限定本任务记录，不 truncate 业务表。
 *
 * 运行（任务书 §3.3 C9 之外的本轮定向真库证据）：
 *   DATABASE_URL=...vocab_study_notes_task10_accept（vocab_app）
 *   TEST_DATABASE_URL=...vocab_study_notes_task10_accept（vocab_migration）
 *   TEST_APP_DATABASE_URL=...vocab_study_notes_task10_accept（vocab_app）
 *   npx --no-install vitest run --config vitest.integration.config.ts \
 *     tests/l3-study-note-export.integration.test.ts --maxWorkers=1
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetPool } from "@/db/connection";
import { withTransaction } from "@/db/transaction";
import { L3StudyNoteExportService } from "@/services/l3-study-note-export.service";
import { L3StudyReferenceService } from "@/services/l3-study-reference.service";
import { L3StudyNoteRepository } from "@/repositories/l3-study-notes.repository";
import { L3StudyTopicRepository } from "@/repositories/l3-study-topics.repository";
import { L3StudyReferenceRepository } from "@/repositories/l3-study-references.repository";
import {
  cleanupStudyFixture,
  requireStudyNoteTestUrls,
  seedStudyOwners,
  seedStudyQuestion,
  seedStudySource,
} from "./helpers/study-notes-db";

const { adminUrl, appUrl } = requireStudyNoteTestUrls();

const OWNER = randomUUID();
const SOURCE = randomUUID();
const QUESTION = randomUUID();
const NOTE = randomUUID();
const REF = randomUUID();
const TOPIC = randomUUID();
const SUBMISSION = randomUUID();
const PAPER = randomUUID();
const ATTEMPT = randomUUID();

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalPoolMax = process.env.DB_POOL_MAX;

const adminPool = new Pool({ connectionString: adminUrl, max: 2 });

/** 受限角色 + RLS 事务。 */
async function inTxAs<T>(actorId: string, fn: (tx: Parameters<Parameters<typeof withTransaction>[0]>[0]) => Promise<T>): Promise<T> {
  return withTransaction(async (tx) => fn(tx), { actorId });
}

function buildService(): L3StudyNoteExportService {
  return new L3StudyNoteExportService(
    withTransaction,
    (tx) => ({
      studyNotes: new L3StudyNoteRepository(tx),
      studyTopics: new L3StudyTopicRepository(tx),
      studyReferences: new L3StudyReferenceRepository(tx),
    }),
    new L3StudyReferenceService(),
  );
}

/** 关键业务表行数快照（导出前后必须逐项相等）。 */
async function businessCounts(): Promise<Record<string, number>> {
  const tables = [
    "l3_study_notes",
    "l3_study_note_venues",
    "l3_study_topics",
    "l3_study_topic_notes",
    "l3_study_note_references",
    "l3_submissions",
    "l3_question_attempts",
    "l3_practice_attempts",
    "l3_sources",
    "l3_questions",
  ];
  const out: Record<string, number> = {};
  for (const table of tables) {
    const res = await adminPool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
    out[table] = Number(res.rows[0]!.count);
  }
  return out;
}

/** 本 fixture 行的 version / updated_at 快照（零写=逐项不变）。 */
async function fixtureVersions(): Promise<Record<string, unknown>> {
  const note = await adminPool.query(
    `SELECT version, updated_at, status, pinned, title, body_md FROM l3_study_notes WHERE id = $1`,
    [NOTE],
  );
  const topic = await adminPool.query(
    `SELECT version, updated_at, title, status FROM l3_study_topics WHERE id = $1`,
    [TOPIC],
  );
  const ref = await adminPool.query(
    `SELECT captured_at, display_snapshot, quote_snapshot, field_hash FROM l3_study_note_references WHERE id = $1`,
    [REF],
  );
  const source = await adminPool.query(`SELECT title, content_text, updated_at FROM l3_sources WHERE id = $1`, [SOURCE]);
  return { note: note.rows[0], topic: topic.rows[0], ref: ref.rows[0], source: source.rows[0] };
}

beforeAll(async () => {
  await seedStudyOwners(adminPool, [OWNER]);
  await seedStudySource(adminPool, {
    id: SOURCE,
    userId: OWNER,
    title: "任务十真库来源",
    contentText: "The quick brown fox jumps over the lazy dog.",
  });
  await seedStudyQuestion(adminPool, {
    id: QUESTION,
    userId: OWNER,
    sourceId: SOURCE,
    questionType: "reading_choice",
    stem: "狐狸做了什么？",
    options: [{ key: "A", text: "跳过懒狗" }],
  });

  await adminPool.query(
    `INSERT INTO l3_study_notes (id, user_id, title, body_md, status, pinned, version, create_request_id, create_input_hash)
     VALUES ($1, $2, $3, $4, 'active', false, 1, $5, $6)`,
    [NOTE, OWNER, "真库导出笔记", `正文一\n\n[[ref:${REF}]]\n\n正文二`, randomUUID(), "d".repeat(64)],
  );
  await adminPool.query(
    `INSERT INTO l3_study_note_venues (note_id, user_id, question_type) VALUES ($1, $2, 'reading_choice')`,
    [NOTE, OWNER],
  );
  await adminPool.query(
    `INSERT INTO l3_study_topics (id, user_id, question_type, title, status, version, create_request_id, create_input_hash)
     VALUES ($1, $2, 'reading_choice', '真库专题', 'active', 1, $3, $4)`,
    [TOPIC, OWNER, randomUUID(), "f".repeat(64)],
  );
  await adminPool.query(
    `INSERT INTO l3_study_topic_notes (topic_id, note_id, user_id, position) VALUES ($1, $2, $3, 0)`,
    [TOPIC, NOTE, OWNER],
  );
  await adminPool.query(
    `INSERT INTO l3_study_note_references
       (id, note_id, user_id, kind, source_id, start_offset, end_offset, quote_snapshot, field_hash, display_snapshot, captured_at)
     VALUES ($1, $2, $3, 'source_quote', $4, 4, 19, $5, $6, $7::jsonb, now())`,
    [
      REF,
      NOTE,
      OWNER,
      SOURCE,
      "quick brown fox",
      "e".repeat(64),
      JSON.stringify({ kind: "source_quote", title: "任务十真库来源", quote: "quick brown fox" }),
    ],
  );
  // 一张空题纸 + 一条作答：导出绝不能让这两个计数 +1。
  await adminPool.query(
    `INSERT INTO l3_papers (id, user_id, title, metadata, payload, payload_version, status, created_by, input_hash)
     VALUES ($1, $2, '真库题纸', '{}'::jsonb, '{}'::jsonb, 1, 'active', $2::uuid, $3)`,
    [PAPER, OWNER, 'a'.repeat(64)],
  );
  await adminPool.query(
    `INSERT INTO l3_submissions (id, user_id, scope, scope_key, paper_id) VALUES ($1, $2, 'paper', $3, $4)`,
    [SUBMISSION, OWNER, PAPER, PAPER],
  );
  await adminPool.query(
    `INSERT INTO l3_question_attempts (id, user_id, question_id, sheet_id, venue, answer, status) VALUES ($1, $2, $3, $4, 'paper', '{}'::jsonb, 'active')`,
    [ATTEMPT, OWNER, QUESTION, SUBMISSION],
  );

  await resetPool();
  process.env.DATABASE_URL = appUrl;
  process.env.DB_POOL_MAX = "1";
});

afterAll(async () => {
  try {
    await resetPool();
    await adminPool.query(`DELETE FROM l3_question_attempts WHERE id = $1`, [ATTEMPT]);
    await adminPool.query(`DELETE FROM l3_submissions WHERE id = $1`, [SUBMISSION]);
    await adminPool.query(`DELETE FROM l3_papers WHERE id = $1`, [PAPER]);
    await adminPool.query(`DELETE FROM l3_study_topic_notes WHERE topic_id = $1`, [TOPIC]);
    await adminPool.query(`DELETE FROM l3_study_topics WHERE id = $1`, [TOPIC]);
    await cleanupStudyFixture(adminPool, [OWNER]);
  } finally {
    await adminPool.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPoolMax === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = originalPoolMax;
  }
});

describe("Task 10 · 导出只读纪律（真实 PG）", () => {
  it("export is read-only across notes venues topics and references", async () => {
    const before = await businessCounts();
    const versionsBefore = await fixtureVersions();

    const result = await buildService().export(OWNER, NOTE, { expectedVersion: 1 });

    const after = await businessCounts();
    const versionsAfter = await fixtureVersions();

    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.version).toBe(1);
    expect(result.markdown).toContain("quick brown fox");
    expect(after).toEqual(before);
    expect(versionsAfter).toEqual(versionsBefore);
  });

  it("export does not create submissions（题纸不新增）", async () => {
    const before = await adminPool.query<{ count: string }>(`SELECT count(*)::text AS count FROM l3_submissions`);
    await buildService().export(OWNER, NOTE, { expectedVersion: 1 });
    const after = await adminPool.query<{ count: string }>(`SELECT count(*)::text AS count FROM l3_submissions`);

    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it("export does not mutate attempts（作答不变化）", async () => {
    const before = await adminPool.query<{ count: string }>(`SELECT count(*)::text AS count FROM l3_question_attempts`);
    await buildService().export(OWNER, NOTE, { expectedVersion: 1 });
    const after = await adminPool.query<{ count: string }>(`SELECT count(*)::text AS count FROM l3_question_attempts`);

    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it("export does not advance the note version（零业务写入的可观测面）", async () => {
    const before = await adminPool.query<{ version: number; updated_at: unknown }>(
      `SELECT version, updated_at FROM l3_study_notes WHERE id = $1`,
      [NOTE],
    );
    const result = await buildService().export(OWNER, NOTE, { expectedVersion: 1 });
    const after = await adminPool.query<{ version: number; updated_at: unknown }>(
      `SELECT version, updated_at FROM l3_study_notes WHERE id = $1`,
      [NOTE],
    );

    expect(result.version).toBe(before.rows[0]!.version);
    expect(after.rows[0]!.version).toBe(before.rows[0]!.version);
    expect(String(after.rows[0]!.updated_at)).toBe(String(before.rows[0]!.updated_at));
  });

  it("rejects a stale expectedVersion with 409 carrying currentVersion only（真实 409）", async () => {
    await expect(buildService().export(OWNER, NOTE, { expectedVersion: 999 })).rejects.toMatchObject({
      name: "ConflictError",
      meta: expect.objectContaining({ currentVersion: 1 }),
    });
  });

  it("rejects an export of another owner's note with 404（真实 owner-only）", async () => {
    const other = randomUUID();
    await seedStudyOwners(adminPool, [other]);
    await expect(buildService().export(other, NOTE, { expectedVersion: 1 })).rejects.toMatchObject({
      name: "NotFoundError",
    });
    await adminPool.query(`DELETE FROM profiles WHERE id = $1`, [other]);
    await adminPool.query(`DELETE FROM users WHERE id = $1`, [other]);
  });
});
