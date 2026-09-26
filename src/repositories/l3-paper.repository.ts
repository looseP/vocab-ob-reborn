/**
 * L3PaperRepository — 题目 / 试卷持久化（ADR-0030）。
 *
 * 只写 l3_questions / l3_papers；题目与 l3_contexts 严格分离。卷面 sections
 * 存于 papers.payload（JSONB 有序引用），本仓储不解释 payload 业务语义——
 * 版本/归属/一致性校验在 service 与 domain 纯函数层。
 */

import type {
  Direction,
  L3EvidenceAnchor,
  L3PaperListItem,
  L3PaperListPage,
  L3PaperRow,
  L3PracticeFileListItem,
  L3PracticeFilePage,
  L3QuestionAnswer,
  L3QuestionOption,
  L3QuestionRow,
  L3QuestionType,
  L3QuestionStatus,
  L3SubSpace,
} from "../domain";
import { PAPER_PAYLOAD_VERSION, type L3PaperPayload } from "../domain/l3-question-types";
import type {
  IL3PaperRepository,
  L3PaperLookup,
  L3PaperRef,
  L3PracticeFileLookup,
  NewL3Paper,
  NewL3Question,
  UpdateL3Paper,
  UpdateL3Question,
} from "./interfaces";
import { BaseRepository } from "./base";

interface QuestionDbRow {
  id: string;
  user_id: string;
  source_id: string | null;
  file_key: string | null;
  space: L3SubSpace;
  question_type: L3QuestionType;
  ordinal: number;
  stem: string;
  options: unknown;
  answer: unknown;
  explanation: string | null;
  evidence: unknown;
  status: L3QuestionStatus;
  created_by: string;
  input_hash: string | null;
  created_at: string;
  updated_at: string;
}

function mapQuestionRow(row: QuestionDbRow): L3QuestionRow {
  return {
    ...row,
    ordinal: Number(row.ordinal),
    options: Array.isArray(row.options) ? (row.options as L3QuestionOption[]) : [],
    answer: (row.answer && typeof row.answer === "object" ? row.answer : {}) as L3QuestionAnswer,
    evidence: Array.isArray(row.evidence) ? (row.evidence as L3EvidenceAnchor[]) : [],
  };
}

interface PaperDbRow {
  id: string;
  user_id: string;
  title: string;
  direction: Direction | null;
  metadata: unknown;
  payload: L3PaperPayload;
  payload_version: number;
  status: L3PaperRow["status"];
  created_by: string;
  input_hash: string | null;
  created_at: string;
  updated_at: string;
}

function mapPaperRow(row: PaperDbRow): L3PaperRow {
  return {
    ...row,
    payload_version: Number(row.payload_version),
    metadata: (row.metadata ?? {}) as L3PaperRow["metadata"],
  };
}

export class L3PaperRepository extends BaseRepository implements IL3PaperRepository {
  async insertQuestion(input: NewL3Question): Promise<L3QuestionRow> {
    const row = await this.queryOne<QuestionDbRow>(
      `INSERT INTO l3_questions
         (user_id, source_id, file_key, space, question_type, ordinal, stem,
          options, answer, explanation, evidence, status, created_by, input_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb,
               COALESCE($12, 'active'), COALESCE($13, 'owner'), $14)
       RETURNING *`,
      [
        input.user_id,
        input.source_id,
        input.file_key,
        input.space,
        input.question_type,
        input.ordinal,
        input.stem,
        JSON.stringify(input.options ?? []),
        JSON.stringify(input.answer ?? {}),
        input.explanation ?? null,
        JSON.stringify(input.evidence ?? []),
        input.status ?? null,
        input.created_by ?? null,
        input.input_hash ?? null,
      ],
    );
    if (!row) throw new Error("L3 question insert returned no row");
    return mapQuestionRow(row);
  }

  async findQuestionById(userId: string, questionId: string): Promise<L3QuestionRow | null> {
    const row = await this.queryOne<QuestionDbRow>(
      `SELECT * FROM l3_questions WHERE id = $1::uuid AND user_id = $2::uuid`,
      [questionId, userId],
    );
    return row ? mapQuestionRow(row) : null;
  }

  /**
   * 改题面（2026-09-26）：条件 UPDATE 带**可改状态集合**谓词 —— 0 行返回 null，
   * 由 service 二次判别（404 不存在/非属主，409 状态不可改）。
   *
   * ⚠️ 2026-09-26（ADR-0037）：谓词由写死的 `status='active'` 改为
   * `status = ANY($10::text[])`，集合由 service 按角色给出（`editableQuestionStatuses`）：
   * owner = {active, pending}、agent = {pending}。闸门落在这一层是刻意的 ——
   * 「agent 只能改待录题」必须是**一次 UPDATE 谓词**，而不是先读后写的应用层判断
   * （后者有 TOCTOU 窗口：读时是 pending、改时已被采纳）。
   *
   * 只写题面列；`input_hash` 由调用方**沿用原值**（该列只参与部分唯一索引的建卷
   * 去重，从不被读作语义；改题面不换身份指纹，也就不可能撞唯一索引）。
   * **其余护栏在 service**：已有作答历史或被作文任务引用时不得改。
   */
  async updateQuestion(input: UpdateL3Question): Promise<L3QuestionRow | null> {
    const row = await this.queryOne<QuestionDbRow>(
      `UPDATE l3_questions
          SET stem = $3, options = $4::jsonb, answer = $5::jsonb, explanation = $6,
              evidence = $7::jsonb, ordinal = $8, input_hash = $9, updated_at = now()
        WHERE id = $1::uuid AND user_id = $2::uuid AND status = ANY($10::text[])
        RETURNING *`,
      [
        input.question_id,
        input.user_id,
        input.stem,
        JSON.stringify(input.options ?? []),
        JSON.stringify(input.answer ?? {}),
        input.explanation ?? null,
        JSON.stringify(input.evidence ?? []),
        input.ordinal,
        input.input_hash ?? null,
        [...input.editable_statuses],
      ],
    );
    return row ? mapQuestionRow(row) : null;
  }

  /**
   * 待录题列表（ADR-0037 决策 6）：owner 的核对面。**只**取 pending，按
   * created_at/ordinal 稳定排序（同一批 agent 产物顺序可预期，便于逐条核对）。
   * 读面一律过滤 active 是既有纪律；这里是唯一一处显式取 pending 的查询。
   */
  async listPendingQuestions(input: {
    user_id: string;
    limit: number;
    offset: number;
  }): Promise<{ items: L3QuestionRow[]; total: number }> {
    const countRow = await this.queryOne<{ total: string }>(
      `SELECT count(*)::bigint AS total FROM l3_questions
        WHERE user_id = $1::uuid AND status = 'pending'`,
      [input.user_id],
    );
    const rows = await this.query<QuestionDbRow>(
      `SELECT * FROM l3_questions
        WHERE user_id = $1::uuid AND status = 'pending'
        ORDER BY created_at ASC, ordinal ASC, id ASC
        LIMIT $2 OFFSET $3`,
      [input.user_id, input.limit, input.offset],
    );
    return { items: rows.map(mapQuestionRow), total: Number(countRow?.total ?? 0) };
  }

  /**
   * 批量采纳（ADR-0037 决策 4）：`pending → active` 的**单条** UPDATE，返回真正被
   * 改到的 id 集合。谓词含 `status='pending'` ⇒ 重复采纳是幂等的（第二次 0 行），
   * 且绝不把 rejected 捞回来。逐条结果由 service 用 `findQuestionById` 复判，
   * 不在本方法里猜（猜错就会把"别人的题"报成已采纳）。
   */
  async acceptPendingQuestions(userId: string, questionIds: readonly string[]): Promise<string[]> {
    if (questionIds.length === 0) return [];
    const rows = await this.query<{ id: string }>(
      `UPDATE l3_questions
          SET status = 'active', updated_at = now()
        WHERE user_id = $1::uuid AND status = 'pending' AND id = ANY($2::uuid[])
        RETURNING id`,
      [userId, [...questionIds]],
    );
    return rows.map((row) => row.id);
  }

  /** 驳回待录题（ADR-0037 决策 4）：`pending → rejected`，同样只动 pending。 */
  async rejectPendingQuestion(userId: string, questionId: string): Promise<boolean> {
    const row = await this.queryOne<{ id: string }>(
      `UPDATE l3_questions
          SET status = 'rejected', updated_at = now()
        WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'pending'
        RETURNING id`,
      [questionId, userId],
    );
    return row !== null;
  }

  /** 题面是否已有作答历史（改题面护栏：答案历史不可改写，见 service.updateQuestion）。 */
  async countQuestionAttempts(userId: string, questionId: string): Promise<number> {
    const row = await this.queryOne<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM l3_question_attempts
        WHERE user_id = $1::uuid AND question_id = $2::uuid`,
      [userId, questionId],
    );
    return Number(row?.count ?? 0);
  }

  /** 改卷（2026-09-26）：标题/方向/元信息/payload。条件 UPDATE 带 `status='active'`。 */
  async updatePaper(input: UpdateL3Paper): Promise<L3PaperRow | null> {
    const row = await this.queryOne<PaperDbRow>(
      `UPDATE l3_papers
          SET title = $3, direction = $4, metadata = $5::jsonb, payload = $6::jsonb,
              input_hash = $7, updated_at = now()
        WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'active'
        RETURNING *`,
      [
        input.paper_id,
        input.user_id,
        input.title,
        input.direction ?? null,
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.payload),
        input.input_hash ?? null,
      ],
    );
    return row ? mapPaperRow(row) : null;
  }

  async findActiveQuestionsByIds(userId: string, questionIds: readonly string[]): Promise<L3QuestionRow[]> {
    if (questionIds.length === 0) return [];
    const rows = await this.query<QuestionDbRow>(
      `SELECT * FROM l3_questions
        WHERE user_id = $1::uuid AND status = 'active' AND id = ANY($2::uuid[])`,
      [userId, questionIds],
    );
    return rows.map(mapQuestionRow);
  }

  async listActiveQuestionsForFile(
    userId: string,
    identity: { sourceId?: string | null; fileKey?: string | null; questionType: string },
  ): Promise<L3QuestionRow[]> {
    if (identity.sourceId) {
      const rows = await this.query<QuestionDbRow>(
        `SELECT * FROM l3_questions
          WHERE user_id = $1::uuid AND status = 'active'
            AND source_id = $2::uuid AND question_type = $3
          ORDER BY ordinal ASC, created_at ASC, id ASC`,
        [userId, identity.sourceId, identity.questionType],
      );
      return rows.map(mapQuestionRow);
    }
    if (!identity.fileKey) return [];
    const rows = await this.query<QuestionDbRow>(
      `SELECT * FROM l3_questions
        WHERE user_id = $1::uuid AND status = 'active'
          AND file_key = $2 AND question_type = $3
        ORDER BY ordinal ASC, created_at ASC, id ASC`,
      [userId, identity.fileKey, identity.questionType],
    );
    return rows.map(mapQuestionRow);
  }

  /**
   * 内部写作题排除判定（双条件）：file_key 以 'writing:' 前缀 **且** 存在关联的
   * l3_writing_tasks 行。用于 practice-files 聚合排除「作文子空间自建题」——
   * 既有导入题（含 short_essay/long_essay）无此前缀 + 无关联写作任务，不受影响。
   * SQL 层实现，不依赖任何用户可输入字符串判断。
   */
  private isInternalWritingQuestionClause(): string {
    return "(q.file_key LIKE 'writing:%' AND EXISTS (SELECT 1 FROM l3_writing_tasks wt WHERE wt.question_id = q.id AND wt.user_id = q.user_id))";
  }

  async listPracticeFiles(input: L3PracticeFileLookup): Promise<L3PracticeFilePage> {
    const params: unknown[] = [input.userId];
    let where = ` WHERE q.user_id = $1::uuid AND q.status = 'active' AND NOT ${this.isInternalWritingQuestionClause()}`;
    if (input.questionType) {
      params.push(input.questionType);
      where += ` AND q.question_type = $${params.length}`;
    }
    if (input.direction) {
      params.push(input.direction);
      where += ` AND s.direction = $${params.length}`;
    }
    if (input.q && input.q.trim()) {
      params.push(`%${input.q.trim().replace(/[\\%_]/g, "\\$&")}%`);
      where += ` AND COALESCE(s.title, q.file_key) ILIKE $${params.length} ESCAPE '\\'`;
    }
    // R3：精确来源过滤（精确读面——单文件方向/标题不依赖 limit 扫描）。
    if (input.sourceId) {
      params.push(input.sourceId);
      where += ` AND q.source_id = $${params.length}::uuid`;
    }
    if (input.fileKey) {
      params.push(input.fileKey);
      where += ` AND q.file_key = $${params.length}`;
    }
    const grouped = `
      SELECT q.question_type, q.source_id, q.file_key,
             COALESCE(NULLIF(s.title, ''), q.file_key) AS title,
             s.direction,
             count(*)::int AS question_count,
             max(q.created_at) AS latest_created_at
        FROM l3_questions q
        LEFT JOIN l3_sources s ON s.id = q.source_id AND s.user_id = q.user_id
        ${where}
       GROUP BY q.question_type, q.source_id, q.file_key, s.title, s.direction`;

    const totalRow = await this.queryOne<{ total: string }>(
      `SELECT count(*) AS total FROM (${grouped}) f`,
      params,
    );
    const rows = await this.query<L3PracticeFileListItem>(
      `${grouped} ORDER BY latest_created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, input.limit, input.offset],
    );
    return {
      items: rows.map((r) => ({ ...r, question_count: Number(r.question_count) })),
      total: Number(totalRow?.total ?? 0),
      limit: input.limit,
      offset: input.offset,
    };
  }

  /**
   * 删题护栏（作文子空间 V1，W2）：返回引用该 question 的全部当前 owner 写作任务
   * （id + 标题）。owner 作用域，不泄露任何他人信息。空数组表示该题未被写作任务引用。
   */
  async listWritingTaskRefs(userId: string, questionId: string): Promise<Array<{ id: string; title: string }>> {
    return this.query<{ id: string; title: string }>(
      `SELECT t.id, t.title
         FROM l3_writing_tasks t
        WHERE t.question_id = $1::uuid AND t.user_id = $2::uuid
        ORDER BY t.created_at ASC, t.id ASC`,
      [questionId, userId],
    );
  }

  async deleteQuestion(userId: string, questionId: string): Promise<boolean> {
    const row = await this.queryOne<{ id: string }>(
      `DELETE FROM l3_questions WHERE id = $1::uuid AND user_id = $2::uuid RETURNING id`,
      [questionId, userId],
    );
    return Boolean(row);
  }

  async listActivePaperRefsWithPayload(
    userId: string,
  ): Promise<Array<L3PaperRef & { payload: unknown }>> {
    return this.query<L3PaperRef & { payload: unknown }>(
      `SELECT id, title, payload FROM l3_papers WHERE user_id = $1::uuid AND status = 'active'`,
      [userId],
    );
  }

  async insertPaper(input: NewL3Paper): Promise<L3PaperRow> {
    const row = await this.queryOne<PaperDbRow>(
      `INSERT INTO l3_papers
         (user_id, title, direction, metadata, payload, payload_version,
          status, created_by, input_hash)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,COALESCE($8,'owner'),$9)
       RETURNING *`,
      [
        input.user_id,
        input.title,
        input.direction,
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.payload),
        input.payload_version,
        input.status,
        input.created_by ?? null,
        input.input_hash ?? null,
      ],
    );
    if (!row) throw new Error("L3 paper insert returned no row");
    return mapPaperRow(row);
  }

  async findPaperById(userId: string, paperId: string): Promise<L3PaperRow | null> {
    const row = await this.queryOne<PaperDbRow>(
      `SELECT * FROM l3_papers WHERE id = $1::uuid AND user_id = $2::uuid`,
      [paperId, userId],
    );
    return row ? mapPaperRow(row) : null;
  }

  async listPapers(input: L3PaperLookup): Promise<L3PaperListPage> {
    const params: unknown[] = [input.userId];
    let where = " WHERE p.user_id = $1::uuid";
    if (input.status) {
      params.push(input.status);
      where += ` AND p.status = $${params.length}`;
    }
    if (input.q && input.q.trim()) {
      params.push(`%${input.q.trim().replace(/[\\%_]/g, "\\$&")}%`);
      where += ` AND p.title ILIKE $${params.length} ESCAPE '\\'`;
    }
    const totalRow = await this.queryOne<{ total: string }>(
      `SELECT count(*) AS total FROM l3_papers p ${where}`,
      params,
    );
    const rows = await this.query<L3PaperListItem>(
      `SELECT p.id, p.title, p.direction, p.status, p.created_at, p.updated_at,
              (SELECT count(*) FROM jsonb_array_elements(p.payload->'sections'))::int AS section_count,
              (SELECT count(*)
                 FROM jsonb_array_elements(p.payload->'sections') AS sec,
                      jsonb_array_elements(sec.value->'questionIds'))::int AS question_count
         FROM l3_papers p
         ${where}
        ORDER BY p.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, input.limit, input.offset],
    );
    const items = rows.map((r) => ({
      ...r,
      section_count: Number(r.section_count),
      question_count: Number(r.question_count),
    }));
    return {
      items,
      total: Number(totalRow?.total ?? 0),
      limit: input.limit,
      offset: input.offset,
    };
  }
}
