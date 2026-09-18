/**
 * L3WritingRepository — 写作任务 / 首稿生命周期持久化（W2，ADR《writing-workspace》§1/§2/§4）。
 *
 * 只写 l3_writing_tasks 与 l3_submissions（writing scope 首稿）；内部题经 l3Paper 创建，
 * 由服务层编排在同一事务内（题面引用式：题不复制快照）。lockTask / lockQuestion 供
 * W3/W5/W9 统一 task→sheet 锁序（requireTx，必须在事务内调用）。
 *
 * 所有 SQL 用 snake_case 真实列名；行类型唯一真源见 l3-writing.types.ts 与 domain。
 */

import type { PoolClient } from "pg";
import type { Json } from "../domain";
import type {
  L3QuestionAttemptRow,
  L3QuestionRow,
  L3SubmissionRow,
  WritingDirection,
  WritingKind,
  WritingTaskStatus,
} from "../domain";
import type { L3WritingTaskRow } from "./l3-writing.types";
import { BaseRepository } from "./base";

/** 新建写作任务入参（服务已校验字段；repo 只负责落库）。 */
export interface NewL3WritingTask {
  id: string;
  user_id: string;
  question_id: string;
  title: string;
  kind: WritingKind;
  direction: WritingDirection;
  status: WritingTaskStatus;
  create_request_id: string;
  create_input_hash: string;
}

/** 新建写作首稿入参（writing scope draft；正文真源 answers 初始为 {}）。 */
export interface NewL3WritingDraft {
  user_id: string;
  task_id: string;
  question_id: string;
}

/**
 * 列表行：任务行 + 题面（question.stem）+ 该任务单 draft 的 sheetId +
 * 最新 sealed 稿 id 与 revision_no（LEFT JOIN LATERAL 单语句聚合，避免 N+1）。
 */
export interface L3WritingTaskListRow extends L3WritingTaskRow {
  prompt: string;
  draft_sheet_id: string | null;
  last_sheet_id: string | null;
  latest_revision_no: number | null;
}

export interface L3WritingTaskListInput {
  userId: string;
  status: WritingTaskStatus | null;
  q: string | null;
  /** keyset 游标（updated_at, id）解码值；null = 首页。 */
  cursor: { updatedAt: string; id: string } | null;
  /** 列表取 limit+1 行，由调用方判定 hasMore。 */
  limit: number;
}

export interface L3WritingTaskListResult {
  items: L3WritingTaskListRow[];
  total: number;
}

/**
 * 写作仓储契约（W2 自包含定义；W6 集成时并入 IRepositories 并以键名 `l3Writing` 注册）。
 * 服务层只依赖此窄接口，不依赖完整的 IRepositories，便于定向测试注入假对象。
 */
export interface IL3WritingRepository {
  insertTask(input: NewL3WritingTask): Promise<L3WritingTaskRow>;
  findTaskById(userId: string, taskId: string): Promise<L3WritingTaskRow | null>;
  findTaskByRequestId(userId: string, requestId: string): Promise<L3WritingTaskRow | null>;
  findActiveTaskByQuestion(
    userId: string,
    questionId: string,
    kind: WritingKind,
    direction: WritingDirection,
  ): Promise<L3WritingTaskRow | null>;
  /** 任务行锁（task→sheet 锁序第一步）。requireTx。 */
  lockTask(userId: string, taskId: string): Promise<L3WritingTaskRow | null>;
  /** owner+question 事务锁（题路径并发创建复用保护）。requireTx。 */
  lockQuestion(userId: string, questionId: string): Promise<L3QuestionRow | null>;
  updateTaskTitle(userId: string, taskId: string, title: string): Promise<L3WritingTaskRow | null>;
  setTaskStatus(
    userId: string,
    taskId: string,
    status: WritingTaskStatus,
  ): Promise<L3WritingTaskRow | null>;
  /** 仅刷新 updated_at（保存/提交/反馈写路径复用；W3/W5/W9 调用）。 */
  touchTask(userId: string, taskId: string): Promise<void>;
  insertDraft(input: NewL3WritingDraft): Promise<L3SubmissionRow>;
  findDraftByTask(userId: string, taskId: string): Promise<L3SubmissionRow | null>;
  countSealedByTask(userId: string, taskId: string): Promise<number>;
  findLatestSealedByTask(userId: string, taskId: string): Promise<L3SubmissionRow | null>;
  listTasks(input: L3WritingTaskListInput): Promise<L3WritingTaskListResult>;

  // ── 以下为 W3 稿件生命周期（sheet 域）：task→sheet 锁序、CAS、物化、稿次（ADR §4）──

  /** 稿行锁（task→sheet 锁序第二步）。requireTx。 */
  lockSheet(userId: string, taskId: string, sheetId: string): Promise<L3SubmissionRow | null>;
  /** 读面：精确归属的稿行（无锁）。 */
  findSheetById(userId: string, taskId: string, sheetId: string): Promise<L3SubmissionRow | null>;
  /** 第二稿父稿校验：同 task 且 sealed 的稿行（无锁）。 */
  findSealedSheetById(userId: string, taskId: string, sheetId: string): Promise<L3SubmissionRow | null>;
  /** CAS 保存草稿：WHERE status='draft' AND draft_version=$expected；失败返回 null（不 last-wins）。 */
  casSaveDraft(
    userId: string,
    taskId: string,
    sheetId: string,
    expectedVersion: number,
    answersJsonb: string,
  ): Promise<L3SubmissionRow | null>;
  /** 该 sheet 的写作 attempt（任意状态——sealed 重放需取 attemptId；软删行亦返回）。 */
  findWritingAttempt(userId: string, sheetId: string): Promise<L3QuestionAttemptRow | null>;
  /** 物化写作 attempt（提交事务内；一稿一 attempt 由 DB 部分唯一索引兜底）。 */
  insertWritingAttempt(input: {
    user_id: string;
    question_id: string;
    sheet_id: string;
    answerJsonb: string;
  }): Promise<L3QuestionAttemptRow>;
  /** 新建写作稿（首稿或第二稿）：支持 parent_sheet_id 与初始 answers（copy 种子）。 */
  createWritingDraft(input: {
    user_id: string;
    task_id: string;
    question_id: string;
    parent_sheet_id: string | null;
    answers: Record<string, unknown>;
  }): Promise<L3SubmissionRow>;
  /** 提交物化：同事务内（service 控制）已建 attempt，此处清空 answers、sealed、分配 revision_no。WHERE status='draft' AND draft_version=$expected。 */
  sealWritingSheet(
    userId: string,
    taskId: string,
    sheetId: string,
    expectedVersion: number,
    revisionNo: number,
  ): Promise<L3SubmissionRow | null>;
  /** 丢弃草稿：清空 answers、status='discarded'、revision_no 保持 NULL（不占号）。WHERE status='draft' AND draft_version=$expected。 */
  discardWritingDraft(
    userId: string,
    taskId: string,
    sheetId: string,
    expectedVersion: number,
  ): Promise<L3SubmissionRow | null>;
  /** 已提交稿号最大值（task 行锁下分配新号；无 sealed 返回 0）。不得用 count 充当 max。 */
  findMaxRevisionNo(userId: string, taskId: string): Promise<number>;
  /** sealed/discarded 历史（updatedAt DESC, id DESC keyset）；每行带 active attempt 计数与 feedback 计数（只读派生）。 */
  listRevisions(
    userId: string,
    taskId: string,
    input: { limit: number; cursor: { updatedAt: string; id: string } | null },
  ): Promise<{ items: WritingRevisionListRow[]; total: number }>;
}

/** listRevisions 投影行：稿行 + 派生计数（只读，不写反馈表）。 */
export interface WritingRevisionListRow extends L3SubmissionRow {
  active_attempt_count: number;
  feedback_count: number;
}

function mapWritingTaskRow(row: L3WritingTaskRow): L3WritingTaskRow {
  return { ...row };
}

function mapSubmissionRow(row: L3SubmissionRow): L3SubmissionRow {
  return {
    ...row,
    answers: (row.answers && typeof row.answers === "object" ? row.answers : {}) as Record<string, Json>,
  };
}

export class L3WritingRepository extends BaseRepository implements IL3WritingRepository {
  async insertTask(input: NewL3WritingTask): Promise<L3WritingTaskRow> {
    const row = await this.queryOne<L3WritingTaskRow>(
      `INSERT INTO l3_writing_tasks
         (id, user_id, question_id, title, kind, direction, status,
          create_request_id, create_input_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        input.id,
        input.user_id,
        input.question_id,
        input.title,
        input.kind,
        input.direction,
        input.status,
        input.create_request_id,
        input.create_input_hash,
      ],
    );
    if (!row) throw new Error("l3_writing_tasks insert returned no row");
    return mapWritingTaskRow(row);
  }

  async findTaskById(userId: string, taskId: string): Promise<L3WritingTaskRow | null> {
    const row = await this.queryOne<L3WritingTaskRow>(
      `SELECT * FROM l3_writing_tasks WHERE id = $1::uuid AND user_id = $2::uuid`,
      [taskId, userId],
    );
    return row ? mapWritingTaskRow(row) : null;
  }

  async findTaskByRequestId(userId: string, requestId: string): Promise<L3WritingTaskRow | null> {
    const row = await this.queryOne<L3WritingTaskRow>(
      `SELECT * FROM l3_writing_tasks
        WHERE user_id = $1::uuid AND create_request_id = $2::uuid`,
      [userId, requestId],
    );
    return row ? mapWritingTaskRow(row) : null;
  }

  async findActiveTaskByQuestion(
    userId: string,
    questionId: string,
    kind: WritingKind,
    direction: WritingDirection,
  ): Promise<L3WritingTaskRow | null> {
    const row = await this.queryOne<L3WritingTaskRow>(
      `SELECT * FROM l3_writing_tasks
        WHERE user_id = $1::uuid AND question_id = $2::uuid
          AND kind = $3 AND direction = $4 AND status = 'active'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [userId, questionId, kind, direction],
    );
    return row ? mapWritingTaskRow(row) : null;
  }

  async lockTask(userId: string, taskId: string): Promise<L3WritingTaskRow | null> {
    const tx = this.requireTx();
    const row = await this.queryOne<L3WritingTaskRow>(
      `SELECT * FROM l3_writing_tasks
        WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
      [taskId, userId],
    );
    void tx;
    return row ? mapWritingTaskRow(row) : null;
  }

  async lockQuestion(userId: string, questionId: string): Promise<L3QuestionRow | null> {
    const tx = this.requireTx();
    const row = await this.queryOne<L3QuestionRow>(
      `SELECT * FROM l3_questions
        WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
      [questionId, userId],
    );
    void tx;
    return row ?? null;
  }

  async updateTaskTitle(userId: string, taskId: string, title: string): Promise<L3WritingTaskRow | null> {
    const row = await this.queryOne<L3WritingTaskRow>(
      `UPDATE l3_writing_tasks
        SET title = $3, updated_at = now()
        WHERE id = $1::uuid AND user_id = $2::uuid
        RETURNING *`,
      [taskId, userId, title],
    );
    return row ? mapWritingTaskRow(row) : null;
  }

  async setTaskStatus(
    userId: string,
    taskId: string,
    status: WritingTaskStatus,
  ): Promise<L3WritingTaskRow | null> {
    const row = await this.queryOne<L3WritingTaskRow>(
      `UPDATE l3_writing_tasks
        SET status = $3, updated_at = now()
        WHERE id = $1::uuid AND user_id = $2::uuid
        RETURNING *`,
      [taskId, userId, status],
    );
    return row ? mapWritingTaskRow(row) : null;
  }

  async touchTask(userId: string, taskId: string): Promise<void> {
    await this.query(
      `UPDATE l3_writing_tasks SET updated_at = now()
        WHERE id = $1::uuid AND user_id = $2::uuid`,
      [taskId, userId],
    );
  }

  async insertDraft(input: NewL3WritingDraft): Promise<L3SubmissionRow> {
    const row = await this.queryOne<L3SubmissionRow>(
      `INSERT INTO l3_submissions
         (user_id, scope, scope_key, source_id, question_type, paper_id,
          writing_task_id, parent_sheet_id, revision_no, draft_version,
          status, answers, seal_mode, summary)
       VALUES ($1, 'writing', $2, NULL, NULL, NULL,
               $3, NULL, NULL, 0, 'draft', '{}'::jsonb, NULL, NULL)
       RETURNING *`,
      [input.user_id, `writing:${input.task_id}`, input.task_id],
    );
    if (!row) throw new Error("l3_submissions (writing draft) insert returned no row");
    return mapSubmissionRow(row);
  }

  async findDraftByTask(userId: string, taskId: string): Promise<L3SubmissionRow | null> {
    const row = await this.queryOne<L3SubmissionRow>(
      `SELECT * FROM l3_submissions
        WHERE user_id = $1::uuid AND writing_task_id = $2::uuid AND status = 'draft'
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [userId, taskId],
    );
    return row ? mapSubmissionRow(row) : null;
  }

  async countSealedByTask(userId: string, taskId: string): Promise<number> {
    const row = await this.queryOne<{ c: string }>(
      `SELECT count(*)::int AS c FROM l3_submissions
        WHERE user_id = $1::uuid AND writing_task_id = $2::uuid AND status = 'sealed'`,
      [userId, taskId],
    );
    return Number(row?.c ?? 0);
  }

  async findLatestSealedByTask(userId: string, taskId: string): Promise<L3SubmissionRow | null> {
    const row = await this.queryOne<L3SubmissionRow>(
      `SELECT * FROM l3_submissions
        WHERE user_id = $1::uuid AND writing_task_id = $2::uuid AND status = 'sealed'
        ORDER BY revision_no DESC, created_at DESC, id DESC
        LIMIT 1`,
      [userId, taskId],
    );
    return row ? mapSubmissionRow(row) : null;
  }

  async listTasks(input: L3WritingTaskListInput): Promise<L3WritingTaskListResult> {
    const params: unknown[] = [input.userId];
    let where = " WHERE t.user_id = $1::uuid";
    if (input.status) {
      params.push(input.status);
      where += ` AND t.status = $${params.length}`;
    }
    if (input.q && input.q.trim()) {
      params.push(`%${input.q.trim().replace(/[\\%_]/g, "\\$&")}%`);
      where += ` AND (t.title ILIKE $${params.length} ESCAPE '\\' OR q.stem ILIKE $${params.length} ESCAPE '\\')`;
    }
    if (input.cursor) {
      params.push(input.cursor.updatedAt, input.cursor.id);
      // 列表排序 (updated_at DESC, id DESC) 的 keyset 续页：取下一组更小的行。
      where += ` AND (t.updated_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }

    const totalRow = await this.queryOne<{ total: string }>(
      `SELECT count(*) AS total
         FROM l3_writing_tasks t
         JOIN l3_questions q ON q.id = t.question_id AND q.user_id = t.user_id
         ${where}`,
      params,
    );

    const rows = await this.query<L3WritingTaskListRow>(
      `SELECT t.*, q.stem AS prompt,
              d.id AS draft_sheet_id,
              s.id AS last_sheet_id,
              s.revision_no AS latest_revision_no
         FROM l3_writing_tasks t
         JOIN l3_questions q ON q.id = t.question_id AND q.user_id = t.user_id
         LEFT JOIN LATERAL (
           SELECT id FROM l3_submissions
           WHERE user_id = t.user_id AND writing_task_id = t.id AND status = 'draft'
           LIMIT 1
         ) d ON true
         LEFT JOIN LATERAL (
           SELECT id, revision_no FROM l3_submissions
           WHERE user_id = t.user_id AND writing_task_id = t.id AND status = 'sealed'
           ORDER BY revision_no DESC, created_at DESC, id DESC
           LIMIT 1
         ) s ON true
         ${where}
         ORDER BY t.updated_at DESC, t.id DESC
         LIMIT $${params.length + 1}`,
      [...params, input.limit],
    );

    return {
      items: rows.map((r) => ({ ...r, prompt: r.prompt ?? "" })),
      total: Number(totalRow?.total ?? 0),
    };
  }

  // ── W3 稿件生命周期实现（sheet 域；锁序 task→sheet 由 service 持锁调用）──────────

  async lockSheet(userId: string, taskId: string, sheetId: string): Promise<L3SubmissionRow | null> {
    this.requireTx();
    const row = await this.queryOne<L3SubmissionRow>(
      `SELECT * FROM l3_submissions
        WHERE id = $3::uuid AND user_id = $2::uuid AND writing_task_id = $1::uuid
        FOR UPDATE`,
      [taskId, userId, sheetId],
    );
    return row ? mapSubmissionRow(row) : null;
  }

  async findSheetById(userId: string, taskId: string, sheetId: string): Promise<L3SubmissionRow | null> {
    const row = await this.queryOne<L3SubmissionRow>(
      `SELECT * FROM l3_submissions
        WHERE id = $3::uuid AND user_id = $2::uuid AND writing_task_id = $1::uuid`,
      [taskId, userId, sheetId],
    );
    return row ? mapSubmissionRow(row) : null;
  }

  async findSealedSheetById(userId: string, taskId: string, sheetId: string): Promise<L3SubmissionRow | null> {
    const row = await this.queryOne<L3SubmissionRow>(
      `SELECT * FROM l3_submissions
        WHERE id = $3::uuid AND user_id = $2::uuid AND writing_task_id = $1::uuid
          AND status = 'sealed'`,
      [taskId, userId, sheetId],
    );
    return row ? mapSubmissionRow(row) : null;
  }

  async casSaveDraft(
    userId: string,
    taskId: string,
    sheetId: string,
    expectedVersion: number,
    answersJsonb: string,
  ): Promise<L3SubmissionRow | null> {
    const row = await this.queryOne<L3SubmissionRow>(
      `UPDATE l3_submissions
          SET answers = $4::jsonb, draft_version = draft_version + 1, updated_at = now()
        WHERE id = $3::uuid AND user_id = $2::uuid AND writing_task_id = $1::uuid
          AND status = 'draft' AND draft_version = $5
        RETURNING *`,
      [taskId, userId, sheetId, answersJsonb, expectedVersion],
    );
    return row ? mapSubmissionRow(row) : null;
  }

  async findWritingAttempt(userId: string, sheetId: string): Promise<L3QuestionAttemptRow | null> {
    const row = await this.queryOne<L3QuestionAttemptRow>(
      `SELECT * FROM l3_question_attempts
        WHERE user_id = $1::uuid AND sheet_id = $2::uuid AND venue = 'writing'
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [userId, sheetId],
    );
    return row ?? null;
  }

  async insertWritingAttempt(input: {
    user_id: string;
    question_id: string;
    sheet_id: string;
    answerJsonb: string;
  }): Promise<L3QuestionAttemptRow> {
    const row = await this.queryOne<L3QuestionAttemptRow>(
      `INSERT INTO l3_question_attempts (user_id, question_id, sheet_id, venue, answer)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'writing', $4::jsonb)
       RETURNING *`,
      [input.user_id, input.question_id, input.sheet_id, input.answerJsonb],
    );
    if (!row) throw new Error("l3_question_attempts (writing) insert returned no row");
    return row;
  }

  async createWritingDraft(input: {
    user_id: string;
    task_id: string;
    question_id: string;
    parent_sheet_id: string | null;
    answers: Record<string, unknown>;
  }): Promise<L3SubmissionRow> {
    const row = await this.queryOne<L3SubmissionRow>(
      `INSERT INTO l3_submissions
         (user_id, scope, scope_key, source_id, question_type, paper_id,
          writing_task_id, parent_sheet_id, revision_no, draft_version,
          status, answers, seal_mode, summary)
       VALUES ($1::uuid, 'writing', $2, NULL, NULL, NULL,
               $3::uuid, $4::uuid, NULL, 0,
               'draft', $5::jsonb, NULL, NULL)
       RETURNING *`,
      [input.user_id, `writing:${input.task_id}`, input.task_id, input.parent_sheet_id, JSON.stringify(input.answers)],
    );
    if (!row) throw new Error("l3_submissions (writing revision draft) insert returned no row");
    return mapSubmissionRow(row);
  }

  async sealWritingSheet(
    userId: string,
    taskId: string,
    sheetId: string,
    expectedVersion: number,
    revisionNo: number,
  ): Promise<L3SubmissionRow | null> {
    const row = await this.queryOne<L3SubmissionRow>(
      `UPDATE l3_submissions
          SET answers = '{}'::jsonb, status = 'sealed', seal_mode = 'full',
              sealed_at = now(), revision_no = $5, draft_version = draft_version + 1,
              updated_at = now()
        WHERE id = $3::uuid AND user_id = $2::uuid AND writing_task_id = $1::uuid
          AND status = 'draft' AND draft_version = $4
        RETURNING *`,
      [taskId, userId, sheetId, expectedVersion, revisionNo],
    );
    return row ? mapSubmissionRow(row) : null;
  }

  async discardWritingDraft(
    userId: string,
    taskId: string,
    sheetId: string,
    expectedVersion: number,
  ): Promise<L3SubmissionRow | null> {
    // 终态丢弃：清空 answers、不改 draft_version（无后续写路径）、不占稿号。
    const row = await this.queryOne<L3SubmissionRow>(
      `UPDATE l3_submissions
          SET answers = '{}'::jsonb, status = 'discarded', updated_at = now()
        WHERE id = $3::uuid AND user_id = $2::uuid AND writing_task_id = $1::uuid
          AND status = 'draft' AND draft_version = $4
        RETURNING *`,
      [taskId, userId, sheetId, expectedVersion],
    );
    return row ? mapSubmissionRow(row) : null;
  }

  async findMaxRevisionNo(userId: string, taskId: string): Promise<number> {
    const row = await this.queryOne<{ m: number }>(
      `SELECT COALESCE(max(revision_no), 0)::int AS m FROM l3_submissions
        WHERE user_id = $1::uuid AND writing_task_id = $2::uuid AND status = 'sealed'`,
      [userId, taskId],
    );
    return Number(row?.m ?? 0);
  }

  async listRevisions(
    userId: string,
    taskId: string,
    input: { limit: number; cursor: { updatedAt: string; id: string } | null },
  ): Promise<{ items: WritingRevisionListRow[]; total: number }> {
    const params: unknown[] = [userId, taskId];
    let where = `s.user_id = $1::uuid AND s.writing_task_id = $2::uuid
                 AND s.status IN ('sealed', 'discarded')`;
    if (input.cursor) {
      params.push(input.cursor.updatedAt, input.cursor.id);
      where += ` AND (s.updated_at, s.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }

    const totalRow = await this.queryOne<{ total: string }>(
      `SELECT count(*) AS total FROM l3_submissions s WHERE ${where}`,
      params,
    );

    const rows = await this.query<WritingRevisionListRow>(
      `SELECT s.*,
              COALESCE(a.cnt, 0)::int AS active_attempt_count,
              COALESCE(f.cnt, 0)::int AS feedback_count
         FROM l3_submissions s
         LEFT JOIN (
           SELECT sheet_id, count(*)::int AS cnt FROM l3_question_attempts
            WHERE venue = 'writing' AND status = 'active'
            GROUP BY sheet_id
         ) a ON a.sheet_id = s.id
         LEFT JOIN (
           SELECT sheet_id, count(*)::int AS cnt FROM l3_writing_feedback
            GROUP BY sheet_id
         ) f ON f.sheet_id = s.id
        WHERE ${where}
        ORDER BY s.updated_at DESC, s.id DESC
        LIMIT $${params.length + 1}`,
      [...params, input.limit],
    );

    return { items: rows.map((r) => mapSubmissionRow(r) as WritingRevisionListRow), total: Number(totalRow?.total ?? 0) };
  }
}
