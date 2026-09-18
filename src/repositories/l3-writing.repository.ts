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
}
