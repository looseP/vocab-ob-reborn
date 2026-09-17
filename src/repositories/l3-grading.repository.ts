/**
 * L3GradingRepository — 评卷结果持久化（批次三①，ADR-0035 §1）。
 *
 * UNIQUE(sheet_id, question_id) 同键覆写：改判 = INSERT ... ON CONFLICT DO UPDATE
 * + graded_at 刷新（latest-wins，无历史版本——评卷是消耗品不是资产）。
 * 行级隔离由 RLS own_all policy 兜底，所有查询显式带 user_id。
 */
import type { L3GradingResultRow } from "../domain";
import type { IL3GradingRepository, NewL3GradingResult } from "./interfaces";
import { BaseRepository } from "./base";

interface GradingDbRow {
  id: string;
  user_id: string;
  sheet_id: string;
  question_id: string;
  verdict: L3GradingResultRow["verdict"];
  analysis_md: string | null;
  graded_by: string;
  graded_at: string;
}

function mapGradingRow(row: GradingDbRow): L3GradingResultRow {
  return { ...row };
}

export class L3GradingRepository extends BaseRepository implements IL3GradingRepository {
  async listBySheet(userId: string, sheetId: string): Promise<L3GradingResultRow[]> {
    const rows = await this.query<GradingDbRow>(
      `SELECT * FROM l3_grading_results
        WHERE user_id = $1::uuid AND sheet_id = $2::uuid
        ORDER BY question_id, id`,
      [userId, sheetId],
    );
    return rows.map(mapGradingRow);
  }

  async upsertResults(inputs: readonly NewL3GradingResult[]): Promise<L3GradingResultRow[]> {
    if (inputs.length === 0) return [];
    const values = inputs
      .map((_, index) => {
        const base = index * 6;
        return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid, $${base + 4}, $${base + 5}, $${base + 6})`;
      })
      .join(", ");
    const params: unknown[] = inputs.flatMap((input) => [
      input.user_id,
      input.sheet_id,
      input.question_id,
      input.verdict,
      input.analysis_md,
      input.graded_by,
    ]);
    const rows = await this.query<GradingDbRow>(
      `INSERT INTO l3_grading_results
         (user_id, sheet_id, question_id, verdict, analysis_md, graded_by)
       VALUES ${values}
       ON CONFLICT (sheet_id, question_id)
       DO UPDATE SET verdict = EXCLUDED.verdict,
                     analysis_md = EXCLUDED.analysis_md,
                     graded_by = EXCLUDED.graded_by,
                     graded_at = now()
       RETURNING *`,
      params,
    );
    return rows.map(mapGradingRow);
  }
}
