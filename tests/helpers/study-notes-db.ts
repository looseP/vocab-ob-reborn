/**
 * 学习笔记（N1）DB fixture —— 专属 owner（随机 UUID）、可追踪 id、
 * 清理限定本任务记录。**不 truncate 业务表**；只在显式指定的隔离库运行
 * （TEST_DATABASE_URL / TEST_APP_DATABASE_URL 缺失即失败，不 skip）。
 *
 * 连接语义（对齐 tests/l3-rls.integration.test.ts 基建）：
 * - admin（vocab_migration，表属主）——seed / cleanup / 绕过 RLS 的 FK 兜底测试；
 * - app（vocab_app，NOBYPASSRLS 非属主）——RLS 强制路径。
 */
import type { Pool } from "pg";

export function requireStudyNoteTestUrls(): { adminUrl: string; appUrl: string } {
  const adminUrl = process.env.TEST_DATABASE_URL;
  const appUrl = process.env.TEST_APP_DATABASE_URL;
  if (!adminUrl) {
    throw new Error("TEST_DATABASE_URL is required to seed the study-notes fixture");
  }
  if (!appUrl) {
    throw new Error("TEST_APP_DATABASE_URL is required for the restricted study-notes session");
  }
  return { adminUrl, appUrl };
}

/** users + profiles 双表播种（l3_* 的 user_id FK → profiles）。 */
export async function seedStudyOwners(pool: Pool, ownerIds: readonly string[]): Promise<void> {
  for (const id of ownerIds) {
    const email = `study-notes-${id.slice(0, 8)}@example.test`;
    await pool.query(`INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, email]);
    await pool.query(`INSERT INTO profiles (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, email]);
  }
}

/** 一个带 content_text 的 source（供 quote 引用目标）。 */
export async function seedStudySource(
  pool: Pool,
  input: { id: string; userId: string; title?: string; contentText?: string | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO l3_sources (id, user_id, source_type, title, content_text)
     VALUES ($1, $2, 'article', $3, $4)`,
    [input.id, input.userId, input.title ?? `study fixture ${input.id.slice(0, 8)}`, input.contentText ?? null],
  );
}

/** 一个挂在 source 下的 question（source_id 必填的题型，identity check 满足）。 */
export async function seedStudyQuestion(
  pool: Pool,
  input: {
    id: string;
    userId: string;
    sourceId: string | null;
    questionType?: string;
    stem?: string;
    options?: unknown[];
    fileKey?: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO l3_questions (id, user_id, source_id, file_key, space, question_type, stem, options, answer, evidence)
     VALUES ($1, $2, $3, $4, '阅读', $5, $6, $7::jsonb, '{}'::jsonb, '[]'::jsonb)`,
    [
      input.id,
      input.userId,
      input.sourceId,
      input.fileKey ?? null,
      input.questionType ?? "reading_choice",
      input.stem ?? `fixture stem ${input.id.slice(0, 8)}`,
      JSON.stringify(input.options ?? []),
    ],
  );
}

/**
 * 清理本任务 fixture（只按给定 owner 集合；顺序按引用依赖）。
 * 被 RESTRICT 保护的行先删引用（references）再删 source/question；
 * 不触碰任何 fixture owner 之外的行。
 */
export async function cleanupStudyFixture(pool: Pool, ownerIds: readonly string[]): Promise<void> {
  const ids = [...ownerIds];
  if (ids.length === 0) return;
  await pool.query(`DELETE FROM l3_study_note_references WHERE user_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM l3_study_topic_notes WHERE user_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM l3_study_note_venues WHERE user_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM l3_study_topics WHERE user_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM l3_study_notes WHERE user_id = ANY($1::uuid[])`, [ids]);
  // question→source 为 CASCADE；references 已清后可直接删。显式分两步利于报错定位。
  await pool.query(`DELETE FROM l3_questions WHERE user_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM l3_sources WHERE user_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM profiles WHERE id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
}
