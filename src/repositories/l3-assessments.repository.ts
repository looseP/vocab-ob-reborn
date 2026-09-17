/**
 * L3AssessmentRepository — 评析区持久化（批次二增补，0035）。
 *
 * 一题一条（(user_id, question_id) UNIQUE）：upsert 走 ON CONFLICT DO UPDATE
 * （latest-wins 覆写）；行级隔离由 RLS own_all policy 兜底，所有查询显式带 user_id。
 */
import type { L3QuestionAssessmentRow } from "../domain";
import type { IL3AssessmentRepository, NewL3QuestionAssessment } from "./interfaces";
import { BaseRepository } from "./base";

interface AssessmentDbRow {
  id: string;
  user_id: string;
  question_id: string;
  content_md: string;
  last_editor: "owner" | "agent";
  created_at: string;
  updated_at: string;
}

function mapAssessmentRow(row: AssessmentDbRow): L3QuestionAssessmentRow {
  return { ...row };
}

export class L3AssessmentRepository extends BaseRepository implements IL3AssessmentRepository {
  async findByQuestion(userId: string, questionId: string): Promise<L3QuestionAssessmentRow | null> {
    const row = await this.queryOne<AssessmentDbRow>(
      `SELECT * FROM l3_question_assessments
        WHERE user_id = $1::uuid AND question_id = $2::uuid`,
      [userId, questionId],
    );
    return row ? mapAssessmentRow(row) : null;
  }

  async upsert(input: NewL3QuestionAssessment): Promise<L3QuestionAssessmentRow> {
    const row = await this.queryOne<AssessmentDbRow>(
      `INSERT INTO l3_question_assessments (user_id, question_id, content_md, last_editor)
       VALUES ($1::uuid, $2::uuid, $3, $4)
       ON CONFLICT (user_id, question_id)
       DO UPDATE SET content_md = EXCLUDED.content_md,
                     last_editor = EXCLUDED.last_editor,
                     updated_at = now()
       RETURNING *`,
      [input.user_id, input.question_id, input.content_md, input.last_editor],
    );
    if (!row) throw new Error("assessment upsert returned no row");
    return mapAssessmentRow(row);
  }
}
