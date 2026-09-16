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

  async listPracticeFiles(input: L3PracticeFileLookup): Promise<L3PracticeFilePage> {
    const params: unknown[] = [input.userId];
    let where = " WHERE q.user_id = $1::uuid AND q.status = 'active'";
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
