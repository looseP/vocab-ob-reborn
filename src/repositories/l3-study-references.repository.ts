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
  /** N2 第二条链：笔记互链（`kind='note'`）的目标笔记行，其余 kind 恒 null。 */
  target_note_id: string | null;
  /** N2 第三条链：sheet 引用（`kind='sheet'`）的目标稿次行，其余 kind 恒 null。 */
  submission_id: string | null;
  /** N2 第三条链：writing 稿次的 revision 半片身份；非 writing 恒 null。 */
  submission_revision_no: number | null;
  /** N2 第三条链：attempt 引用（`kind='attempt'`）的目标作答行，其余 kind 恒 null。 */
  attempt_id: string | null;
  /** N2 第五条链：写作任务引用（`kind='writing_task'`）的目标任务行，其余 kind 恒 null。 */
  writing_task_id: string | null;
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
  target_note_id: string | null;
  submission_id: string | null;
  submission_revision_no: number | null;
  attempt_id: string | null;
  /** N2 第五条链（ADR-0040）：写作任务 id（独立列；`target_note_id` 背着 RESTRICT FK，不能借）。 */
  writing_task_id: string | null;
  option_key: string | null;
  start_offset: number | null;
  end_offset: number | null;
  quote_snapshot: string | null;
  field_hash: string;
  display_snapshot: Json;
  captured_at: string;
}

export type ReferenceTargetKind =
  | "source"
  | "question"
  | "assessment"
  | "note"
  | "sheet"
  | "attempt"
  /** N2 第四条链（ADR-0039）：评卷。内部寻址用 `{sheetId}:{questionId}` 复合 id。 */
  | "grading"
  /** N2 第五条链（ADR-0040）：作文任务（单值 taskId）与评阅（单值 sheetId）。 */
  | "writing_task"
  | "writing_feedback";

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

/**
 * N2 第二条链：笔记目标。
 *
 * 装载**不按 status 过滤**——与 question 的 F3「非 active 不可装载」不同：
 * 笔记只会归档、不会硬删（无删除端点），目标归档后已存引用仍要解析出
 * current/changed。「必须 active 才能新建」由 capture 侧判定（见 service）。
 * `status` 因此随行带出，供 capture 判定使用。
 */
export interface LoadedNoteTarget {
  kind: "note";
  id: string;
  title: string;
  body_md: string;
  status: string;
}

/**
 * N2 第三条链：sheet 目标（`l3_submissions` 的 sealed 稿次）。
 *
 * 装载**只取 `status='sealed'`**（D1-a / K1）：draft / discarded 不是合法目标，
 * 直接取不到 → 404（不是 409）。`status` 仍随行带出，capture 侧再断言一次，
 * 防止日后放宽装载条件时 draft 被静默认为稳定身份（K2）。
 *
 * 白名单字段刻意**不含** `answers`（用户作答内容）与任何评卷列（K7 / K14）。
 */
export interface LoadedSheetTarget {
  kind: "sheet";
  id: string;
  scope: string;
  status: string;
  revision_no: number | null;
  summary: string | null;
}

/**
 * N2 第三条链：attempt 目标（`l3_question_attempts` 的作答记录）。
 *
 * 装载**只取 `status='active'`**（K10）：软删行取不到 → 已存引用按 `unavailable`
 * 呈现并保留快照；capture 也因此无法新建对已删 attempt 的引用。
 * `answer` 是 attempt 自有作答（attempt 表无判定列），不含标准答案 / 解析。
 */
export interface LoadedAttemptTarget {
  kind: "attempt";
  id: string;
  venue: string;
  answer: unknown;
  status: string;
}

/**
 * N2 第四条链（ADR-0039）：评卷目标（`l3_grading_results` 当前那一行）。
 *
 * 装载**必须 JOIN `l3_submissions` 且只取 `status='sealed'`**（决策 2 沿 K1）：
 * draft / discarded 不是合法目标，取不到即 404（不是 409）。
 *
 * 白名单字段 = `field_hash` 输入（`verdict` + `analysis_md`）+ 快照所需的归属事实
 * （`graded_by` / `graded_at`）+ 题干上下文（ordinal / question_type / source_title）。
 * 刻意**不取** `l3_questions.answer` / `explanation`（题面真源）—— 引用评卷不需要
 * 标准答案；也不递归装载题/稿次的其他字段（K5 / K7 同款：一次只展开一层）。
 */
export interface LoadedGradingTarget {
  kind: "grading";
  /** 内部复合寻址串 `"{sheetId}:{questionId}"`（uuid 不含 `:`，拆分无歧义）。 */
  id: string;
  sheet_id: string;
  question_id: string;
  sheet_status: string;
  verdict: string;
  analysis_md: string | null;
  graded_by: string;
  graded_at: string;
  question_ordinal: number;
  question_type: L3QuestionType;
  source_title: string | null;
}

/**
 * N2 第五条链（ADR-0040）：作文任务目标（`l3_writing_tasks` 的某一行）。
 *
 * 装载**不按 status 过滤**（沿 `LoadedNoteTarget`：任务只归档不硬删；「必须 active
 * 才能新建」由 capture 侧判定）。`status` 随行带出供 capture 使用。
 * 刻意**不 JOIN 所属题目**：题干另有 `question` kind 可引，不拼第二份真源。
 */
export interface LoadedWritingTaskTarget {
  kind: "writing_task";
  id: string;
  title: string;
  task_kind: string;
  direction: string;
  status: string;
}

/**
 * N2 第五条链（ADR-0040）：评阅目标（`l3_writing_feedback` 当前那一行）。
 *
 * `UNIQUE(user_id, sheet_id)` 使一纸恰一行（latest-wins，同款 grading）⇒ 改判
 * 必然可达 changed。装载**必须 JOIN `l3_submissions` 且只取 `status='sealed'`**
 * （D1-a 落地：反馈在业务上就不存在于草稿上，取不到即 404）。
 *
 * 白名单 = hash 输入（`feedback` 全文）+ 快照（`summary` 全文）。刻意**不取**
 * `version` / `last_editor`（CAS 与归属，不进 hash）与稿次正文（评阅不需要原文）。
 */
export interface LoadedWritingFeedbackTarget {
  kind: "writing_feedback";
  /** 内部寻址即 sheetId（一纸一行，无复合串）。 */
  id: string;
  sheet_id: string;
  sheet_status: string;
  feedback: unknown;
  summary: string;
}

export type LoadedTarget =
  | LoadedSourceTarget
  | LoadedQuestionTarget
  | LoadedAssessmentTarget
  | LoadedNoteTarget
  | LoadedSheetTarget
  | LoadedAttemptTarget
  | LoadedGradingTarget
  | LoadedWritingTaskTarget
  | LoadedWritingFeedbackTarget;

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
  /**
   * N2 第三条链：attempt 软删 blocker——只按 `attempt_id` 聚合引用它的笔记。
   * attempt 删除端点真实存在且是软删，不会撞 RESTRICT，因此删除面必须预检。
   */
  getAttemptDeleteBlockers(userId: string, attemptId: string): Promise<DeleteBlockerRow[]>;
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
      target_note_id: row.target_note_id,
      submission_id: row.submission_id,
      submission_revision_no: row.submission_revision_no,
      attempt_id: row.attempt_id,
      writing_task_id: row.writing_task_id,
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
         (id, note_id, user_id, kind, source_id, question_id, assessment_id, target_note_id,
          submission_id, submission_revision_no, attempt_id, writing_task_id, option_key,
          start_offset, end_offset, quote_snapshot, field_hash, display_snapshot, captured_at)
       SELECT x.id, $1::uuid, $2::uuid, x.kind, x.source_id, x.question_id, x.assessment_id, x.target_note_id,
              x.submission_id, x.submission_revision_no, x.attempt_id, x.writing_task_id, x.option_key,
              x.start_offset, x.end_offset, x.quote_snapshot, x.field_hash, x.display_snapshot, x.captured_at
         FROM jsonb_to_recordset($3::jsonb) AS x(
           id uuid, kind text, source_id uuid, question_id uuid, assessment_id uuid, target_note_id uuid,
           submission_id uuid, submission_revision_no integer, attempt_id uuid, writing_task_id uuid, option_key text,
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
    // N2 第二条链：笔记互链同样不作为搜索目标（与评析同款 fail-closed）。
    // 调用方改走既有的 GET /study-notes?q= 列表选取目标笔记，不在这里另起一套搜索面。
    if (input.kind === "note") {
      throw new ValidationError("笔记目标不支持搜索", "kind");
    }
    // N2 第三条链：sheet / attempt 同样不作为搜索目标（fail-closed）。
    // 本链**不新增**搜索面——HTTP 查询枚举仍只有 source/question（R-2 同款纪律）。
    if (input.kind === "sheet" || input.kind === "attempt") {
      throw new ValidationError("该目标型不支持搜索", "kind");
    }
    // N2 第四条链：grading 同样不作为搜索目标（fail-closed）。
    if (input.kind === "grading") {
      throw new ValidationError("该目标型不支持搜索", "kind");
    }
    // N2 第五条链：writing_task / writing_feedback 同样不作为搜索目标（fail-closed）。
    // 任务走既有任务列表选取，评阅从 sealed 稿次进入 —— 不在这里另起搜索面。
    if (input.kind === "writing_task" || input.kind === "writing_feedback") {
      throw new ValidationError("该目标型不支持搜索", "kind");
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
    const noteIds = [...new Set(targets.filter((t) => t.kind === "note").map((t) => t.id))];
    const submissionIds = [...new Set(targets.filter((t) => t.kind === "sheet").map((t) => t.id))];
    const attemptIds = [...new Set(targets.filter((t) => t.kind === "attempt").map((t) => t.id))];
    // N2 第四条链：grading 的内部 id 是 `"{sheetId}:{questionId}"` 复合串（uuid 无 `:`）。
    const gradingRefs = [...new Set(targets.filter((t) => t.kind === "grading").map((t) => t.id))];
    const gradingSheetIds = [
      ...new Set(gradingRefs.map((ref) => ref.split(":")[0]).filter((id): id is string => Boolean(id))),
    ];
    // N2 第五条链（ADR-0040）：任务单值 id；评阅单值 sheetId（与 grading 不同，
    // 无复合串 —— 一纸一行，无需配对过滤）。
    const writingTaskIds = [...new Set(targets.filter((t) => t.kind === "writing_task").map((t) => t.id))];
    const writingFeedbackSheetIds = [
      ...new Set(targets.filter((t) => t.kind === "writing_feedback").map((t) => t.id)),
    ];

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

    if (noteIds.length > 0) {
      // N2 第二条链：笔记目标白名单只取 id/title/body_md/status。
      // **不按 status 过滤**（见 LoadedNoteTarget 注释）、**不 JOIN**、**不取目标
      // 笔记自身的引用集合**——互链快照只展开一层，不递归。
      const rows = await this.query<{
        id: string;
        title: string;
        body_md: string;
        status: string;
      }>(
        `SELECT id, title, body_md, status FROM l3_study_notes
          WHERE user_id = $1::uuid AND id = ANY($2::uuid[])`,
        [userId, noteIds],
      );
      for (const row of rows) {
        map.set(`note:${row.id}`, {
          kind: "note",
          id: row.id,
          title: row.title,
          body_md: row.body_md,
          status: row.status,
        });
      }
    }

    if (submissionIds.length > 0) {
      // N2 第三条链：sheet 目标白名单只取 id/scope/status/revision_no/summary。
      // **只装载 sealed**（D1-a / K1）：draft / discarded 不是合法目标，取不到即
      // 404（不是 409）。刻意**不取** `answers`（用户作答内容）与任何评卷列（K7）。
      // 不 JOIN、不按 writing task / parent sheet / 题目兜底（K5）。
      const rows = await this.query<{
        id: string;
        scope: string;
        status: string;
        revision_no: number | null;
        summary: string | null;
      }>(
        `SELECT id, scope, status, revision_no, summary FROM l3_submissions
          WHERE user_id = $1::uuid AND id = ANY($2::uuid[])
            AND status = 'sealed'`,
        [userId, submissionIds],
      );
      for (const row of rows) {
        map.set(`sheet:${row.id}`, {
          kind: "sheet",
          id: row.id,
          scope: row.scope,
          status: row.status,
          revision_no: row.revision_no,
          summary: row.summary,
        });
      }
    }

    if (attemptIds.length > 0) {
      // N2 第三条链：attempt 目标白名单只取 id/venue/answer/status。
      // **只装载 active**（K10）：软删行取不到 → 已存引用按 unavailable 呈现，
      // 也无法新建对已删 attempt 的引用。attempt 表无判定列（verdict 真源在
      // l3_grading_results），故 answer 不含标准答案/解析（K7 / K14）。
      const rows = await this.query<{
        id: string;
        venue: string;
        answer: unknown;
        status: string;
      }>(
        `SELECT id, venue, answer, status FROM l3_question_attempts
          WHERE user_id = $1::uuid AND id = ANY($2::uuid[])
            AND status = 'active'`,
        [userId, attemptIds],
      );
      for (const row of rows) {
        map.set(`attempt:${row.id}`, {
          kind: "attempt",
          id: row.id,
          venue: row.venue,
          answer: row.answer,
          status: row.status,
        });
      }
    }

    if (gradingSheetIds.length > 0) {
      // N2 第四条链（ADR-0039 决策 2/3）：按 **sheet 集合**一次查全，再按请求的
      // (sheet, question) 配对 —— 避免用 `sheet_id::text || ':' || question_id::text
      // = ANY(...)` 这种不可走索引的表达式。一张题纸的评卷行数量级很小（≤ 题数）。
      //
      // JOIN `l3_submissions` 且 `s.status='sealed'`：draft/discarded 不是合法目标。
      // JOIN `l3_questions` 取题干上下文（ordinal / question_type / source_title）。
      const wanted = new Set(gradingRefs);
      const rows = await this.query<{
        sheet_id: string;
        question_id: string;
        sheet_status: string;
        verdict: string;
        analysis_md: string | null;
        graded_by: string;
        graded_at: string;
        question_ordinal: number;
        question_type: L3QuestionType;
        source_title: string | null;
      }>(
        `SELECT g.sheet_id, g.question_id, s.status AS sheet_status,
                g.verdict, g.analysis_md, g.graded_by, g.graded_at,
                q.ordinal AS question_ordinal, q.question_type,
                src.title AS source_title
           FROM l3_grading_results g
           JOIN l3_submissions s ON s.id = g.sheet_id AND s.user_id = g.user_id
           JOIN l3_questions q ON q.id = g.question_id AND q.user_id = g.user_id
           LEFT JOIN l3_sources src ON src.id = q.source_id AND src.user_id = q.user_id
          WHERE g.user_id = $1::uuid AND g.sheet_id = ANY($2::uuid[])
            AND s.status = 'sealed'`,
        [userId, gradingSheetIds],
      );
      for (const row of rows) {
        const composite = `${row.sheet_id}:${row.question_id}`;
        if (!wanted.has(composite)) continue;
        map.set(`grading:${composite}`, {
          kind: "grading",
          id: composite,
          sheet_id: row.sheet_id,
          question_id: row.question_id,
          sheet_status: row.sheet_status,
          verdict: row.verdict,
          analysis_md: row.analysis_md,
          graded_by: row.graded_by,
          graded_at: row.graded_at,
          question_ordinal: Number(row.question_ordinal),
          question_type: row.question_type,
          source_title: row.source_title,
        });
      }
    }

    if (writingTaskIds.length > 0) {
      // N2 第五条链（ADR-0040 决策 4）：任务目标白名单只取四列，不 JOIN、不取题干。
      // **不按 status 过滤**（沿 note：任务只归档不硬删；「必须 active 才能新建」
      // 由 capture 侧判定）。`status` 随行带出供 capture 使用。
      const rows = await this.query<{
        id: string;
        title: string;
        kind: string;
        direction: string;
        status: string;
      }>(
        `SELECT id, title, kind, direction, status FROM l3_writing_tasks
          WHERE user_id = $1::uuid AND id = ANY($2::uuid[])`,
        [userId, writingTaskIds],
      );
      for (const row of rows) {
        map.set(`writing_task:${row.id}`, {
          kind: "writing_task",
          id: row.id,
          title: row.title,
          task_kind: row.kind,
          direction: row.direction,
          status: row.status,
        });
      }
    }

    if (writingFeedbackSheetIds.length > 0) {
      // N2 第五条链（ADR-0040 决策 1/4）：评阅一纸一行，按 sheet 批量取。
      // JOIN `l3_submissions` 且只取 `status='sealed'` —— 反馈在业务上就不存在于
      // 草稿上（反馈服务读前置 draft 409），取不到即 404（不是 409）。
      // 白名单刻意**不取** `version` / `last_editor`（CAS 与归属，不进 hash）与
      // 稿次正文（评阅不需要原文）；`summary` 全文取出（快照 headline）。
      const rows = await this.query<{
        sheet_id: string;
        sheet_status: string;
        feedback: unknown;
        summary: string;
      }>(
        `SELECT f.sheet_id, s.status AS sheet_status, f.feedback,
                f.feedback->>'summary' AS summary
           FROM l3_writing_feedback f
           JOIN l3_submissions s ON s.id = f.sheet_id AND s.user_id = f.user_id
          WHERE f.user_id = $1::uuid AND f.sheet_id = ANY($2::uuid[])
            AND s.status = 'sealed'`,
        [userId, writingFeedbackSheetIds],
      );
      for (const row of rows) {
        map.set(`writing_feedback:${row.sheet_id}`, {
          kind: "writing_feedback",
          id: row.sheet_id,
          sheet_id: row.sheet_id,
          sheet_status: row.sheet_status,
          feedback: row.feedback,
          summary: row.summary,
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
    const noteIds = [...new Set(targets.filter((t) => t.kind === "note").map((t) => normalizeStudyUuid(t.id)))].sort();
    // N2 第三条链（K17）：sheet 用 `l3_submission:<id>`、attempt 用 `l3_attempt:<id>`。
    // attempt 软删端点真实存在，capture 与软删必须共用 `l3_attempt:<id>`，
    // 否则「引用刚写入 / 软删刚执行」会漏过预检。sheet 侧当前没有删除端点
    // （sealed 不可弃），这把锁是同款串行化准备，不依赖任何尚不存在的路径。
    const submissionIds = [...new Set(targets.filter((t) => t.kind === "sheet").map((t) => normalizeStudyUuid(t.id)))].sort();
    const attemptIds = [...new Set(targets.filter((t) => t.kind === "attempt").map((t) => normalizeStudyUuid(t.id)))].sort();

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
    // N2 第二条链：笔记目标用同款事务级 advisory 键。当前没有笔记硬删除端点，
    // 这把锁是「未来若引入删除」时的串行化准备，不依赖任何尚不存在的路径。
    for (const noteId of noteIds) {
      await this.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `l3_study_note:${noteId}`,
      ]);
    }
    for (const submissionId of submissionIds) {
      await this.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `l3_submission:${submissionId}`,
      ]);
    }
    for (const attemptId of attemptIds) {
      await this.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `l3_attempt:${attemptId}`,
      ]);
    }
  }

  async listBacklinks(input: ListBacklinksInput): Promise<{ items: StudyBacklinkRow[]; total: number }> {
    const params: unknown[] = [input.userId, input.targetId];
    const targetColumn =
      input.targetKind === "source"
        ? "r.source_id"
        : input.targetKind === "note"
          ? "r.target_note_id"
          : input.targetKind === "sheet"
            ? "r.submission_id"
            : input.targetKind === "attempt"
              ? "r.attempt_id"
              : "r.question_id";
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

  /**
   * N2 第三条链：attempt 软删 blocker（K11 / A3）。
   *
   * attempt 有**真实**的删除端点（`DELETE /api/l3/attempts/:id`，服务侧软删），
   * 而软删只是改 `status`/`deleted_at`，**不会**撞 RESTRICT 外键（真库探针 F9 已证实
   * UPDATE 1 通过）。所以删除面上必须有预检：命中引用就 409 + 可读 blocker 列表，
   * 由用户先清理引用，而不是让笔记里的引用悄悄变成 unavailable。
   *
   * 口径（V-21）：只按 `r.attempt_id` 聚合——attempt 身份就是 attempt_id 本身，
   * **不**按 question_id / submission_id / sheet_id 兜底计引用（K9）。
   * 归档笔记同样计入（与既有 blocker 同款，不做 status 过滤）。
   */
  async getAttemptDeleteBlockers(userId: string, attemptId: string): Promise<DeleteBlockerRow[]> {
    return this.query<DeleteBlockerRow>(
      `SELECT n.id AS note_id, n.title, n.status, count(r.id)::int AS reference_count
         FROM l3_study_note_references r
         JOIN l3_study_notes n ON n.id = r.note_id AND n.user_id = r.user_id
        WHERE r.user_id = $1::uuid
          AND r.attempt_id = $2::uuid
        GROUP BY n.id, n.title, n.status, n.updated_at
        ORDER BY n.updated_at DESC, n.id DESC`,
      [userId, attemptId],
    );
  }
}
