/**
 * L3StudyReferenceRepository — 引用快照持久化与目标解析（N1）。
 *
 * 覆盖：listForNote/replaceForNote（整组替换）/searchTargets（单 kind 摘要，
 * 不含答案/解析/evidence）/loadTargets（批量白名单字段）/lockTargets（source
 * FOR SHARE + question advisory 锁；question 无 UPDATE 权限不能行锁——实测
 * permission denied，见 l3-writing.lockQuestion 同款先例）/listBacklinks
 * （按 note 去重聚合，默认不含归档）/删除 blockers（source 含子题引用去重）。
 *
 * F3：题目目标一律要求 `status='active'`——搜索与装载（capture/resolve 共同依赖）
 * 同条件；目标后来失效时，已保存引用按 unavailable 展示且保留快照/时间。
 */

import type { L3QuestionOption, L3QuestionType } from "../domain";
import type { ReferenceKind } from "../domain";
import type { Json } from "../domain";
import { normalizeStudyUuid } from "../domain/l3-study-notes";
import { ValidationError } from "../errors";
import { BaseRepository } from "./base";

export interface NewL3StudyNoteReference {
  id: string;
  note_id: string;
  user_id: string;
  kind: ReferenceKind;
  source_id: string | null;
  question_id: string | null;
  /** N2：评析引用（`kind='assessment'`）的目标行，其余 kind 恒 null。 */
  assessment_id: string | null;
  option_key: string | null;
  start_offset: number | null;
  end_offset: number | null;
  quote_snapshot: string | null;
  field_hash: string;
  display_snapshot: Json;
}

/**
 * replaceForNote 的载荷行：note_id/user_id 由方法参数注入（防载荷伪造归属），
 * 行对象不携带归属列；captured_at 随之携带（keep 保留原时间、capture 用服务端
 * 当前时间——"keep 不改变 capturedAt"）。
 */
export type StudyReferenceInsertRow = Omit<NewL3StudyNoteReference, "note_id" | "user_id"> & {
  captured_at: string;
};

export interface L3StudyNoteReferenceRow {
  id: string;
  note_id: string;
  user_id: string;
  kind: ReferenceKind;
  source_id: string | null;
  question_id: string | null;
  assessment_id: string | null;
  option_key: string | null;
  start_offset: number | null;
  end_offset: number | null;
  quote_snapshot: string | null;
  field_hash: string;
  display_snapshot: Json;
  captured_at: string;
}

export type ReferenceTargetKind = "source" | "question" | "assessment";

export interface LoadedSourceTarget {
  kind: "source";
  id: string;
  title: string;
  content_text: string | null;
}

export interface LoadedQuestionTarget {
  kind: "question";
  id: string;
  stem: string;
  options: L3QuestionOption[];
  question_type: L3QuestionType;
  source_id: string | null;
  source_title: string | null;
}

/**
 * N2：评析目标。评析是 `UNIQUE(user_id, question_id)` 的 latest-wins 记录
 * （内容可被覆写），因此装载时把 `content_md` / `updated_at` 一并取出——
 * `field_hash` 输入就是 `content_md`（A2 写死），覆写后旧引用转 `changed`。
 */
export interface LoadedAssessmentTarget {
  kind: "assessment";
  id: string;
  question_id: string;
  content_md: string;
  updated_at: string;
  question_stem: string;
  question_type: L3QuestionType;
  source_title: string | null;
}

export type LoadedTarget = LoadedSourceTarget | LoadedQuestionTarget | LoadedAssessmentTarget;

export interface StudySourceTargetRow {
  id: string;
  title: string;
  created_at: string;
}

export interface StudyQuestionTargetRow {
  id: string;
  stem: string;
  question_type: L3QuestionType;
  created_at: string;
}

export interface SearchTargetsInput {
  userId: string;
  kind: ReferenceTargetKind;
  q: string | null;
  /** 仅 question kind 生效（按题型过滤）；source 忽略。 */
  venue: L3QuestionType | null;
  cursor: { createdAt: string; id: string } | null;
  limit: number;
}

export interface StudyBacklinkRow {
  note_id: string;
  title: string;
  status: string;
  reference_count: number;
  ref_ids: string[];
  updated_at: string;
}

export interface ListBacklinksInput {
  userId: string;
  targetKind: ReferenceTargetKind;
  targetId: string;
  includeArchived?: boolean;
  cursor: { updatedAt: string; id: string } | null;
  limit: number;
}

export interface DeleteBlockerRow {
  note_id: string;
  title: string;
  status: string;
  reference_count: number;
}

export interface IL3StudyReferenceRepository {
  listForNote(userId: string, noteId: string): Promise<L3StudyNoteReferenceRow[]>;
  /** 引用 id → 所属 note（跨笔记冲突判定：已被其他笔记使用的 id 返回 409）。 */
  findReferenceOwners(userId: string, ids: readonly string[]): Promise<Map<string, string>>;
  /** 整组替换（DELETE + jsonb_to_recordset 批量 INSERT；note_id/user_id 由参数注入）。requireTx。 */
  replaceForNote(
    userId: string,
    noteId: string,
    rows: readonly StudyReferenceInsertRow[],
  ): Promise<void>;
  searchTargets(input: SearchTargetsInput): Promise<{ items: StudySourceTargetRow[] | StudyQuestionTargetRow[]; total: number }>;
  /** 批量加载目标字段（白名单：quote 校验与快照组装所需，不含答案/解析/evidence）。 */
  loadTargets(userId: string, targets: readonly { kind: ReferenceTargetKind; id: string }[]): Promise<Map<string, LoadedTarget>>;
  /**
   * capture 前锁定引用目标（防捕获窗口内被删除/更新）：
   * source 批量 FOR SHARE（id 稳定顺序）；question 逐个事务级 advisory 锁
   * （无 UPDATE 授权，行锁 permission denied——l3-writing 先例同款）。requireTx。
   */
  lockTargets(userId: string, targets: readonly { kind: ReferenceTargetKind; id: string }[]): Promise<void>;
  listBacklinks(input: ListBacklinksInput): Promise<{ items: StudyBacklinkRow[]; total: number }>;
  /** source 删除 blocker：直接引用 + 其子题引用，去重 note 列表（含归档笔记）。 */
  getSourceDeleteBlockers(userId: string, sourceId: string): Promise<DeleteBlockerRow[]>;
  /** question 删除 blocker：直接引用其的 note（去重）。 */
  getQuestionDeleteBlockers(userId: string, questionId: string): Promise<DeleteBlockerRow[]>;
}

export class L3StudyReferenceRepository extends BaseRepository implements IL3StudyReferenceRepository {
  async listForNote(userId: string, noteId: string): Promise<L3StudyNoteReferenceRow[]> {
    return this.query<L3StudyNoteReferenceRow>(
      `SELECT * FROM l3_study_note_references
        WHERE note_id = $1::uuid AND user_id = $2::uuid
        ORDER BY captured_at ASC, id ASC`,
      [noteId, userId],
    );
  }

  async findReferenceOwners(userId: string, ids: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (ids.length === 0) return map;
    const rows = await this.query<{ id: string; note_id: string }>(
      `SELECT id, note_id FROM l3_study_note_references
        WHERE user_id = $1::uuid AND id = ANY($2::uuid[])`,
      [userId, [...ids]],
    );
    for (const row of rows) {
      map.set(row.id.toLowerCase(), row.note_id);
    }
    return map;
  }

  async replaceForNote(
    userId: string,
    noteId: string,
    rows: readonly StudyReferenceInsertRow[],
  ): Promise<void> {
    this.requireTx();
    await this.query(
      `DELETE FROM l3_study_note_references WHERE note_id = $1::uuid AND user_id = $2::uuid`,
      [noteId, userId],
    );
    if (rows.length === 0) return;
    // JSON 载荷不含 note_id/user_id（列值由 $1/$2 注入，防载荷伪造归属）。
    const payload = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      source_id: row.source_id,
      question_id: row.question_id,
      assessment_id: row.assessment_id,
      option_key: row.option_key,
      start_offset: row.start_offset,
      end_offset: row.end_offset,
      quote_snapshot: row.quote_snapshot,
      field_hash: row.field_hash,
      display_snapshot: row.display_snapshot,
      captured_at: row.captured_at,
    }));
    await this.query(
      `INSERT INTO l3_study_note_references
         (id, note_id, user_id, kind, source_id, question_id, assessment_id, option_key,
          start_offset, end_offset, quote_snapshot, field_hash, display_snapshot, captured_at)
       SELECT x.id, $1::uuid, $2::uuid, x.kind, x.source_id, x.question_id, x.assessment_id, x.option_key,
              x.start_offset, x.end_offset, x.quote_snapshot, x.field_hash, x.display_snapshot, x.captured_at
         FROM jsonb_to_recordset($3::jsonb) AS x(
           id uuid, kind text, source_id uuid, question_id uuid, assessment_id uuid, option_key text,
           start_offset integer, end_offset integer, quote_snapshot text,
           field_hash text, display_snapshot jsonb, captured_at timestamptz
         )`,
      [noteId, userId, JSON.stringify(payload)],
    );
  }

  async searchTargets(
    input: SearchTargetsInput,
  ): Promise<{ items: StudySourceTargetRow[] | StudyQuestionTargetRow[]; total: number }> {
    // N2：评析不作为搜索目标（它的身份依附具体题，搜索面仍只有 source/question）；
    // 走到这里是调用方 bug，fail-closed 而不是退化成 question 查询。
    if (input.kind === "assessment") {
      throw new ValidationError("评析目标不支持搜索", "kind");
    }

    const params: unknown[] = [input.userId];
    const filters: string[] = ["user_id = $1::uuid"];
    if (input.q && input.q.trim()) {
      params.push(`%${input.q.trim().replace(/[\\%_]/g, "\\$&")}%`);
      filters.push(`title ILIKE $${params.length} ESCAPE '\\'`);
    }

    if (input.kind === "source") {
      const totalRow = await this.queryOne<{ total: string }>(
        `SELECT count(*) AS total FROM l3_sources WHERE ${filters.join(" AND ")}`,
        params,
      );
      let keyset = "";
      if (input.cursor) {
        params.push(input.cursor.createdAt, input.cursor.id);
        keyset = ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }
      params.push(input.limit);
      const items = await this.query<StudySourceTargetRow>(
        `SELECT id, title, created_at FROM l3_sources
          WHERE ${filters.join(" AND ")}${keyset}
          ORDER BY created_at DESC, id DESC
          LIMIT $${params.length}`,
        params,
      );
      return { items, total: Number(totalRow?.total ?? 0) };
    }

    // question：stem 搜索 + 可选题型过滤；摘要白名单不含 answer/explanation/evidence。
    // F3：仅 active 题可被搜索/装载（pending/rejected 目标对搜索、预览、capture 均按不可用）。
    const questionFilters: string[] = ["user_id = $1::uuid", "status = 'active'"];
    if (input.q && input.q.trim()) {
      questionFilters.push(`stem ILIKE $${params.length} ESCAPE '\\'`);
    }
    if (input.venue) {
      params.push(input.venue);
      questionFilters.push(`question_type = $${params.length}`);
    }
    const totalRow = await this.queryOne<{ total: string }>(
      `SELECT count(*) AS total FROM l3_questions WHERE ${questionFilters.join(" AND ")}`,
      params,
    );
    let keyset = "";
    if (input.cursor) {
      params.push(input.cursor.createdAt, input.cursor.id);
      keyset = ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(input.limit);
    const items = await this.query<StudyQuestionTargetRow>(
      `SELECT id, stem, question_type, created_at FROM l3_questions
        WHERE ${questionFilters.join(" AND ")}${keyset}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );
    return { items, total: Number(totalRow?.total ?? 0) };
  }

  async loadTargets(
    userId: string,
    targets: readonly { kind: ReferenceTargetKind; id: string }[],
  ): Promise<Map<string, LoadedTarget>> {
    const map = new Map<string, LoadedTarget>();
    if (targets.length === 0) return map;
    const sourceIds = [...new Set(targets.filter((t) => t.kind === "source").map((t) => t.id))];
    const questionIds = [...new Set(targets.filter((t) => t.kind === "question").map((t) => t.id))];
    const assessmentIds = [...new Set(targets.filter((t) => t.kind === "assessment").map((t) => t.id))];

    if (sourceIds.length > 0) {
      const rows = await this.query<{ id: string; title: string; content_text: string | null }>(
        `SELECT id, title, content_text FROM l3_sources
          WHERE user_id = $1::uuid AND id = ANY($2::uuid[])`,
        [userId, sourceIds],
      );
      for (const row of rows) {
        map.set(`source:${row.id}`, {
          kind: "source",
          id: row.id,
          title: row.title,
          content_text: row.content_text,
        });
      }
    }

    if (questionIds.length > 0) {
      const rows = await this.query<{
        id: string;
        stem: string;
        options: L3QuestionOption[];
        question_type: L3QuestionType;
        source_id: string | null;
        source_title: string | null;
      }>(
        `SELECT q.id, q.stem, q.options, q.question_type, q.source_id, s.title AS source_title
           FROM l3_questions q
           LEFT JOIN l3_sources s ON s.id = q.source_id AND s.user_id = q.user_id
          WHERE q.user_id = $1::uuid AND q.id = ANY($2::uuid[])
            AND q.status = 'active'`,
        [userId, questionIds],
      );
      for (const row of rows) {
        map.set(`question:${row.id}`, {
          kind: "question",
          id: row.id,
          stem: row.stem,
          options: Array.isArray(row.options) ? row.options : [],
          question_type: row.question_type,
          source_id: row.source_id,
          source_title: row.source_title,
        });
      }
    }
    if (assessmentIds.length > 0) {
      // JOIN 到所属题：既校验 question_id 一致（引用不能把 A 题评析挂到 B 题），
      // 又顺带取出题干上下文（stem / source_title）；q.status='active' 沿用 F3。
      const rows = await this.query<{
        id: string;
        question_id: string;
        content_md: string;
        updated_at: string;
        stem: string;
        question_type: L3QuestionType;
        source_title: string | null;
      }>(
        `SELECT a.id, a.question_id, a.content_md, a.updated_at,
                q.stem, q.question_type, s.title AS source_title
           FROM l3_question_assessments a
           JOIN l3_questions q ON q.id = a.question_id AND q.user_id = a.user_id
           LEFT JOIN l3_sources s ON s.id = q.source_id AND s.user_id = q.user_id
          WHERE a.user_id = $1::uuid AND a.id = ANY($2::uuid[])
            AND q.status = 'active'`,
        [userId, assessmentIds],
      );
      for (const row of rows) {
        map.set(`assessment:${row.id}`, {
          kind: "assessment",
          id: row.id,
          question_id: row.question_id,
          content_md: row.content_md,
          updated_at: row.updated_at,
          question_stem: row.stem,
          question_type: row.question_type,
          source_title: row.source_title,
        });
      }
    }
    return map;
  }

  async lockTargets(
    userId: string,
    targets: readonly { kind: ReferenceTargetKind; id: string }[],
  ): Promise<void> {
    this.requireTx();
    // F5：锁身份规范化——同一 UUID 的大小写是同一对象；capture 与 question 删除
    // 两端必须使用同一 advisory 键（`l3_question:<小写uuid>`），否则并发不再串行。
    const sourceIds = [...new Set(targets.filter((t) => t.kind === "source").map((t) => normalizeStudyUuid(t.id)))].sort();
    const questionIds = [...new Set(targets.filter((t) => t.kind === "question").map((t) => normalizeStudyUuid(t.id)))].sort();
    // N2：评析同样无 UPDATE 授权路径可依赖，且删除主要经「question 级联」发生——
    // 服务层对评析目标会同时给出所属 question 键，两把锁合起来覆盖「capture × 级联删」。
    const assessmentIds = [...new Set(targets.filter((t) => t.kind === "assessment").map((t) => normalizeStudyUuid(t.id)))].sort();

    if (sourceIds.length > 0) {
      // 稳定顺序（id ASC）批量共享锁；DELETE 的排他锁将等待锁释放。
      await this.query(
        `SELECT id FROM l3_sources
          WHERE user_id = $1::uuid AND id = ANY($2::uuid[])
          ORDER BY id ASC
          FOR SHARE`,
        [userId, sourceIds],
      );
    }
    // question 无 UPDATE 授权（FOR SHARE/FOR UPDATE 均 permission denied），
    // 用事务级 advisory 锁串行化「capture × question 删除」；FK RESTRICT 兜底。
    for (const questionId of questionIds) {
      await this.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `l3_question:${questionId}`,
      ]);
    }
    for (const assessmentId of assessmentIds) {
      await this.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `l3_assessment:${assessmentId}`,
      ]);
    }
  }

  async listBacklinks(input: ListBacklinksInput): Promise<{ items: StudyBacklinkRow[]; total: number }> {
    const params: unknown[] = [input.userId, input.targetId];
    const targetColumn = input.targetKind === "source" ? "r.source_id" : "r.question_id";
    const filters = [`r.user_id = $1::uuid`, `${targetColumn} = $2::uuid`];
    if (!input.includeArchived) filters.push(`n.status = 'active'`);
    const fromWhere = `
        FROM l3_study_note_references r
        JOIN l3_study_notes n ON n.id = r.note_id AND n.user_id = r.user_id
       WHERE ${filters.join(" AND ")}`;

    const totalRow = await this.queryOne<{ total: string }>(
      `SELECT count(DISTINCT n.id) AS total${fromWhere}`,
      params,
    );

    let keyset = "";
    if (input.cursor) {
      params.push(input.cursor.updatedAt, input.cursor.id);
      keyset = ` AND (n.updated_at, n.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    params.push(input.limit);
    const items = await this.query<StudyBacklinkRow>(
      `SELECT n.id AS note_id, n.title, n.status,
              count(r.id)::int AS reference_count,
              array_agg(r.id::text ORDER BY r.captured_at DESC, r.id) AS ref_ids,
              n.updated_at${fromWhere}${keyset}
        GROUP BY n.id, n.title, n.status, n.updated_at
        ORDER BY n.updated_at DESC, n.id DESC
        LIMIT $${params.length}`,
      params,
    );
    return { items, total: Number(totalRow?.total ?? 0) };
  }

  async getSourceDeleteBlockers(userId: string, sourceId: string): Promise<DeleteBlockerRow[]> {
    return this.query<DeleteBlockerRow>(
      `SELECT n.id AS note_id, n.title, n.status, count(r.id)::int AS reference_count
         FROM l3_study_note_references r
         JOIN l3_study_notes n ON n.id = r.note_id AND n.user_id = r.user_id
        WHERE r.user_id = $1::uuid
          AND (r.source_id = $2::uuid
               OR r.question_id IN (SELECT id FROM l3_questions WHERE user_id = $1::uuid AND source_id = $2::uuid))
        GROUP BY n.id, n.title, n.status, n.updated_at
        ORDER BY n.updated_at DESC, n.id DESC`,
      [userId, sourceId],
    );
  }

  /**
   * N2：题目删除会级联删掉它的评析（`l3_question_assessments.question_id` cascade），
   * 而引用评析的行又 RESTRICT 到评析——若无预检，question 删除会撞 FK 而不是给出
   * blocker。所以这里把「引用该题子评析」的笔记一并计入，与 source blocker 计入
   * 子题引用同款（A3）。
   */
  async getQuestionDeleteBlockers(userId: string, questionId: string): Promise<DeleteBlockerRow[]> {
    return this.query<DeleteBlockerRow>(
      `SELECT n.id AS note_id, n.title, n.status, count(r.id)::int AS reference_count
         FROM l3_study_note_references r
         JOIN l3_study_notes n ON n.id = r.note_id AND n.user_id = r.user_id
        WHERE r.user_id = $1::uuid
          AND (r.question_id = $2::uuid
               OR r.assessment_id IN (SELECT id FROM l3_question_assessments
                                       WHERE user_id = $1::uuid AND question_id = $2::uuid))
        GROUP BY n.id, n.title, n.status, n.updated_at
        ORDER BY n.updated_at DESC, n.id DESC`,
      [userId, questionId],
    );
  }
}
