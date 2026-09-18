/**
 * L3SheetRepository — 题纸（l3_submissions）与作答历史（l3_question_attempts）
 * 持久化（批次二，ADR-0034 §1/§2）。
 *
 * 题纸：开纸幂等（部分唯一索引 ON CONFLICT 冲突复用）；PATCH/seal 走条件
 * UPDATE（WHERE status='draft'）——0 行返回 null，service 借 getSheet 二次
 * 判别 404（不存在/非属主）与 409（非 draft）；定格清空 answers（attempts
 * 是唯一作答真源，拆双真相）。
 * attempts：题级历史链；软删（status/deleted_at）。两处分流：listForQuestions
 * 过滤 deleted（题历史列表）；listBySheet 全量含 deleted（结果页占位替换）。
 */

import type {
  Json,
  L3QuestionAttemptRow,
  L3QuestionType,
  L3SheetArchiveRow,
  L3SubmissionRow,
  SealMode,
  SheetScope,
} from "../domain";
import type {
  IL3SheetRepository,
  L3SheetSealUpdate,
  NewL3QuestionAttempt,
  NewL3Submission,
} from "./interfaces";
import { BaseRepository } from "./base";

interface SubmissionDbRow {
  id: string;
  user_id: string;
  scope: SheetScope;
  scope_key: string;
  source_id: string | null;
  question_type: L3QuestionType | null;
  paper_id: string | null;
  /** 作文四元数据（W1）：writing 行 task 必填；其余行前三者 NULL。 */
  writing_task_id: string | null;
  parent_sheet_id: string | null;
  revision_no: number | null;
  draft_version: number;
  status: L3SubmissionRow["status"];
  answers: unknown;
  seal_mode: SealMode | null;
  summary: string | null;
  sealed_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapSubmissionRow(row: SubmissionDbRow): L3SubmissionRow {
  const answers =
    row.answers && typeof row.answers === "object" && !Array.isArray(row.answers)
      ? (row.answers as Record<string, Json>)
      : {};
  return { ...row, answers };
}

interface AttemptDbRow {
  id: string;
  user_id: string;
  question_id: string;
  sheet_id: string | null;
  venue: SheetScope;
  answer: unknown;
  self_assessment: unknown;
  status: "active" | "deleted";
  deleted_at: string | null;
  created_at: string;
}

function mapAttemptRow(row: AttemptDbRow): L3QuestionAttemptRow {
  return {
    ...row,
    answer: row.answer as Json,
    self_assessment: row.self_assessment == null ? null : (row.self_assessment as Json),
  };
}

export class L3SheetRepository extends BaseRepository implements IL3SheetRepository {
  async findDraftByScopeKey(userId: string, scopeKey: string): Promise<L3SubmissionRow | null> {
    const row = await this.queryOne<SubmissionDbRow>(
      `SELECT * FROM l3_submissions
        WHERE user_id = $1::uuid AND scope_key = $2 AND status = 'draft'`,
      [userId, scopeKey],
    );
    return row ? mapSubmissionRow(row) : null;
  }

  async openSheet(input: NewL3Submission): Promise<{ row: L3SubmissionRow; created: boolean }> {
    const inserted = await this.queryOne<SubmissionDbRow>(
      `INSERT INTO l3_submissions (user_id, scope, scope_key, source_id, question_type, paper_id)
       VALUES ($1::uuid, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, scope_key) WHERE status = 'draft' DO NOTHING
       RETURNING *`,
      [input.user_id, input.scope, input.scope_key, input.source_id, input.question_type, input.paper_id],
    );
    if (inserted) return { row: mapSubmissionRow(inserted), created: true };
    const existing = await this.findDraftByScopeKey(input.user_id, input.scope_key);
    if (!existing) throw new Error("sheet insert returned no row");
    return { row: existing, created: false };
  }

  async patchAnswers(
    userId: string,
    sheetId: string,
    answers: Record<string, unknown>,
  ): Promise<L3SubmissionRow | null> {
    // W3（ADR《writing-workspace》§4）：通用 PATCH 只服务 file/paper 域——writing 稿
    // 必须走专用 saveDraft（CAS + 专用保存契约），通用写面不得成为旁路。
    const row = await this.queryOne<SubmissionDbRow>(
      `UPDATE l3_submissions
          SET answers = answers || $3::jsonb, updated_at = now()
        WHERE user_id = $1::uuid AND id = $2::uuid AND status = 'draft'
          AND scope IN ('file', 'paper')
        RETURNING *`,
      [userId, sheetId, JSON.stringify(answers)],
    );
    return row ? mapSubmissionRow(row) : null;
  }

  async sealSheet(
    userId: string,
    sheetId: string,
    seal: L3SheetSealUpdate,
  ): Promise<L3SubmissionRow | null> {
    this.requireTx();
    const row = await this.queryOne<SubmissionDbRow>(
      `UPDATE l3_submissions
          SET status = $3, seal_mode = $4, summary = $5, sealed_at = now(),
              answers = '{}'::jsonb, updated_at = now()
        WHERE user_id = $1::uuid AND id = $2::uuid AND status = 'draft'
        RETURNING *`,
      [userId, sheetId, seal.status, seal.seal_mode, seal.summary],
    );
    return row ? mapSubmissionRow(row) : null;
  }

  async getSheet(userId: string, sheetId: string): Promise<L3SubmissionRow | null> {
    const row = await this.queryOne<SubmissionDbRow>(
      `SELECT * FROM l3_submissions
        WHERE user_id = $1::uuid AND id = $2::uuid`,
      [userId, sheetId],
    );
    return row ? mapSubmissionRow(row) : null;
  }

  async insertAttempts(
    userId: string,
    attempts: readonly NewL3QuestionAttempt[],
  ): Promise<L3QuestionAttemptRow[]> {
    if (attempts.length === 0) return [];
    const values = attempts
      .map((_, index) => {
        const base = index * 6;
        return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid, $${base + 4}, $${base + 5}::jsonb, $${base + 6}::jsonb)`;
      })
      .join(", ");
    const params: unknown[] = attempts.flatMap((attempt) => [
      userId,
      attempt.question_id,
      attempt.sheet_id,
      attempt.venue,
      JSON.stringify(attempt.answer),
      attempt.self_assessment == null ? null : JSON.stringify(attempt.self_assessment),
    ]);
    const rows = await this.query<AttemptDbRow>(
      `INSERT INTO l3_question_attempts
         (user_id, question_id, sheet_id, venue, answer, self_assessment)
       VALUES ${values}
       RETURNING *`,
      params,
    );
    return rows.map(mapAttemptRow);
  }

  async listForQuestions(userId: string, questionIds: readonly string[]): Promise<L3QuestionAttemptRow[]> {
    if (questionIds.length === 0) return [];
    const rows = await this.query<AttemptDbRow>(
      `SELECT * FROM l3_question_attempts
        WHERE user_id = $1::uuid AND status = 'active' AND question_id = ANY($2::uuid[])
        ORDER BY question_id, created_at, id`,
      [userId, questionIds as string[]],
    );
    return rows.map(mapAttemptRow);
  }

  async softDeleteAttempt(userId: string, attemptId: string): Promise<boolean> {
    // W3（旁路封堵）：通用删历史只服务 file/paper——writing attempt 的删除必须走
    // 专用流程（同事务清理 feedback，W9）；此处过滤后 writing attempt 表现为
    // 「不可经通用面删除」（返回 false → 上层 404 语义）。
    const row = await this.queryOne<{ id: string }>(
      `UPDATE l3_question_attempts
          SET status = 'deleted', deleted_at = now()
        WHERE user_id = $1::uuid AND id = $2::uuid AND status = 'active'
          AND venue <> 'writing'
        RETURNING id`,
      [userId, attemptId],
    );
    return Boolean(row);
  }

  async listBySheet(userId: string, sheetId: string): Promise<L3QuestionAttemptRow[]> {
    const rows = await this.query<AttemptDbRow>(
      `SELECT * FROM l3_question_attempts
        WHERE user_id = $1::uuid AND sheet_id = $2::uuid
        ORDER BY created_at, id`,
      [userId, sheetId],
    );
    return rows.map(mapAttemptRow);
  }

  async countAnsweredBySheet(userId: string, sheetId: string): Promise<number> {
    const row = await this.queryOne<{ answered_count: number }>(
      `SELECT count(*)::int AS answered_count
         FROM l3_submissions s, jsonb_object_keys(s.answers) AS k
        WHERE s.user_id = $1::uuid AND s.id = $2::uuid`,
      [userId, sheetId],
    );
    return row ? Number(row.answered_count) : 0;
  }

  /**
   * F-1：题纸档案列表（回看闭环入口）——新→旧，仅 draft/sealed（弃档墓碑不进档案）。
   * graded_count 由子查询现算（grading_results 无冗余计数列）；venue_title 按域取
   * 来源/卷标题展示（两外键均 CASCADE，理论上恒有值，保留 null 兜底）。
   */
  async listArchive(userId: string, limit: number): Promise<L3SheetArchiveRow[]> {
    const rows = await this.query<{
      id: string;
      scope: SheetScope;
      source_id: string | null;
      question_type: L3QuestionType | null;
      paper_id: string | null;
      status: L3SubmissionRow["status"];
      seal_mode: SealMode | null;
      sealed_at: string | null;
      created_at: string;
      graded_count: number;
      venue_title: string | null;
    }>(
      `SELECT s.id, s.scope, s.source_id, s.question_type, s.paper_id, s.status,
              s.seal_mode, s.sealed_at, s.created_at,
              (SELECT count(*)::int FROM l3_grading_results g WHERE g.sheet_id = s.id) AS graded_count,
              COALESCE(src.title, p.title) AS venue_title
         FROM l3_submissions s
         LEFT JOIN l3_sources src ON src.id = s.source_id
         LEFT JOIN l3_papers p ON p.id = s.paper_id
        WHERE s.user_id = $1::uuid AND s.status IN ('draft', 'sealed')
          AND s.scope IN ('file', 'paper')
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $2`,
      [userId, limit],
    );
    return rows.map((row) => ({ ...row, graded_count: Number(row.graded_count) }));
  }

  /**
   * W3：写作任务 → question_id 只读查询（仅供作用域解析器 writing 分支；
   * 不触发任何创建；W6 注册 l3Writing 后可迁至写作 repo）。
   */
  async findWritingTaskQuestionId(userId: string, taskId: string): Promise<string | null> {
    const row = await this.queryOne<{ question_id: string }>(
      `SELECT question_id FROM l3_writing_tasks WHERE id = $1::uuid AND user_id = $2::uuid`,
      [taskId, userId],
    );
    return row?.question_id ?? null;
  }
}
