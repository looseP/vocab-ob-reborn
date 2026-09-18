/**
 * L3WritingFeedbackRepository — 作文反馈持久化（W5，ADR《writing-workspace》§5）。
 *
 * 一稿一条 latest-wins（UNIQUE(user_id,sheet_id)）；绑定 text_sha256（换稿即失效）；
 * request_id 为幂等键；last_editor 服务端认定。只被 L3WritingFeedbackService 使用
 * （锁序 task→sheet 由 service 收口；本 repo 的 lockBySheet 为反馈行锁）。
 */

import type { L3WritingFeedbackRow } from "./l3-writing.types";
import { BaseRepository } from "./base";

export interface InsertWritingFeedbackInput {
  user_id: string;
  sheet_id: string;
  text_sha256: string;
  feedback_jsonb: string;
  request_id: string;
  last_editor: string;
}

export interface UpdateWritingFeedbackInput extends InsertWritingFeedbackInput {
  expected_version: number;
}

export interface IL3WritingFeedbackRepository {
  /** 读面（无锁）。 */
  findBySheet(userId: string, sheetId: string): Promise<L3WritingFeedbackRow | null>;
  /** 反馈行锁（幂等重放判定与并发写串行用）。requireTx。 */
  lockBySheet(userId: string, sheetId: string): Promise<L3WritingFeedbackRow | null>;
  /** 首写（无行时 INSERT；version=1）。首写无行可锁，由上层 sheet 锁串行保护。 */
  insertFirst(input: InsertWritingFeedbackInput): Promise<L3WritingFeedbackRow>;
  /** CAS 更新：WHERE version=$expected → version+1、覆写 feedback/text_sha256/request_id/last_editor。 */
  updateCas(input: UpdateWritingFeedbackInput): Promise<L3WritingFeedbackRow | null>;
}

export class L3WritingFeedbackRepository extends BaseRepository implements IL3WritingFeedbackRepository {
  async findBySheet(userId: string, sheetId: string): Promise<L3WritingFeedbackRow | null> {
    return this.queryOne<L3WritingFeedbackRow>(
      `SELECT * FROM l3_writing_feedback
        WHERE user_id = $1::uuid AND sheet_id = $2::uuid`,
      [userId, sheetId],
    );
  }

  async lockBySheet(userId: string, sheetId: string): Promise<L3WritingFeedbackRow | null> {
    this.requireTx();
    return this.queryOne<L3WritingFeedbackRow>(
      `SELECT * FROM l3_writing_feedback
        WHERE user_id = $1::uuid AND sheet_id = $2::uuid
        FOR UPDATE`,
      [userId, sheetId],
    );
  }

  async insertFirst(input: InsertWritingFeedbackInput): Promise<L3WritingFeedbackRow> {
    const row = await this.queryOne<L3WritingFeedbackRow>(
      `INSERT INTO l3_writing_feedback
         (user_id, sheet_id, text_sha256, schema_version, feedback, version, request_id, last_editor)
       VALUES ($1::uuid, $2::uuid, $3, 1, $4::jsonb, 1, $5::uuid, $6)
       RETURNING *`,
      [input.user_id, input.sheet_id, input.text_sha256, input.feedback_jsonb, input.request_id, input.last_editor],
    );
    if (!row) throw new Error("l3_writing_feedback insert returned no row");
    return row;
  }

  async updateCas(input: UpdateWritingFeedbackInput): Promise<L3WritingFeedbackRow | null> {
    return this.queryOne<L3WritingFeedbackRow>(
      `UPDATE l3_writing_feedback
          SET text_sha256 = $3, feedback = $4::jsonb, version = version + 1,
              request_id = $5::uuid, last_editor = $6, updated_at = now()
        WHERE user_id = $1::uuid AND sheet_id = $2::uuid AND version = $7
        RETURNING *`,
      [
        input.user_id,
        input.sheet_id,
        input.text_sha256,
        input.feedback_jsonb,
        input.request_id,
        input.last_editor,
        input.expected_version,
      ],
    );
  }
}
