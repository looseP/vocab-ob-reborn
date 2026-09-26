/**
 * L3StudyReferenceService — 引用解析、capture 快照与只读预览（N1，设计 §3/§4）。
 *
 * 合同要点：
 * - capture：**服务端**读取真实目标生成 field_hash 与 display_snapshot（客户端
 *   不得指定出处/hash/快照）；quote 必须严格等于原字段 slice(start,end)
 *   （UTF-16 code unit，不 trim、不归一化、不拆代理对）。
 * - hash 口径：source/source_quote=完整 content_text（NULL 按空字符串）；
 *   stem_quote=stem；option_quote=对应 option.text；question={stem,options}
 *   固定键序 JSON（options 保持题面顺序、显式重建对象保序）。
 * - resolve：已存引用行 → 预览（current/changed/unavailable + liveTitle）；
 *   changed 时保留旧摘录、不按旧 offset 重定位。
 * - preview：只读（独立 actor 事务、零写、不持久化）。
 * - 并发：capture 应运行在调用方（保存流程）已 lockTargets 的事务内——
 *   本 service 不自行取锁，锁序由保存编排统一持有（source FOR SHARE /
 *   question advisory，见 L3StudyReferenceRepository.lockTargets）。
 */

import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import {
  validateQuote,
  normalizeStudyUuid,
  STUDY_PAGE_LIMIT_DEFAULT,
  STUDY_PAGE_LIMIT_MAX,
  STUDY_SOURCE_EXCERPT_MAX,
  STUDY_ASSESSMENT_EXCERPT_MAX,
  STUDY_NOTE_EXCERPT_MAX,
  STUDY_SHEET_EXCERPT_MAX,
  STUDY_ATTEMPT_EXCERPT_MAX,
  STUDY_GRADING_EXCERPT_MAX,
  STUDY_FEEDBACK_EXCERPT_MAX,
  type ReferenceDisplaySnapshot,
  type ReferencePreview,
  type ReferenceStatus,
  type ReferenceTarget,
  type ReferenceTargetPreview,
  type ReferenceKind,
  type StudyBacklinkItem,
  type StudyNoteStatus,
  type StudyPage,
  type StudyQuestionTargetItem,
  type StudySourceTargetItem,
} from "../domain/l3-study-notes";
import type { L3QuestionType } from "../domain/l3-question-types";
import {
  L3StudyReferenceRepository,
  type IL3StudyReferenceRepository,
  type L3StudyNoteReferenceRow,
  type LoadedAttemptTarget,
  type LoadedQuestionTarget,
  type LoadedSheetTarget,
  type LoadedTarget,
  type ReferenceTargetKind,
  type StudyReferenceInsertRow,
} from "../repositories/l3-study-references.repository";
import {
  decodeStudyCursor,
  encodeStudyCursor,
  studyFilterFingerprint,
} from "../repositories/l3-study-cursor";

type TxRunner = typeof withTransaction;

/** 本 service 在事务内使用的窄仓库集合。 */
export interface StudyReferenceRepos {
  studyReferences: IL3StudyReferenceRepository;
}

export type StudyReferenceReposFactory = (tx?: PoolClient) => StudyReferenceRepos;

export interface CaptureReferenceInput {
  id: string;
  target: ReferenceTarget;
}

// ── 纯函数（可独立单测）──────────────────────────────────────────────────

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** question 的 hash 字段文本：固定键序 {stem, options}，options 显式重建保序。 */
export function questionFieldText(target: LoadedQuestionTarget): string {
  return JSON.stringify({
    stem: target.stem,
    options: target.options.map((option) => ({ key: option.key, text: option.text })),
  });
}

/**
 * N2 第二条链：笔记引用的 hash 输入 = 服务端存储的**标题 + 正文**（固定键序 JSON）。
 *
 * 与 `questionFieldText` 同款规范化；**不含** version（CAS 并发版本，按 D1-3 同款
 * 理由不作身份/版本）、不含归档状态与更新时间——后者变化不应让引用转 changed。
 */
export function noteFieldText(target: Extract<LoadedTarget, { kind: "note" }>): string {
  return JSON.stringify({ title: target.title, bodyMd: target.body_md });
}

/**
 * 递归稳定化 JSON（对象键按字典序，数组保序）。
 *
 * hash 输入必须**可复算**：PG `jsonb` 的输出键序是实现细节（按长度再按字节序），
 * 直接 stringify 解析结果会把「同一份 JSON 换一个键序」误判成 changed；而 attempt
 * `answer` 是用户作答 JSON，键序不受我们控制。
 */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item));
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalJson(source[key]);
    return out;
  }
  return value;
}

/** 稳定化 JSON 文本（供摘录与人工核对；hash 输入另有固定键序包装）。 */
function canonicalJsonText(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

/**
 * N2 第三条链：sheet 引用的 hash 输入（K15 写死）= `{ scope, revisionNo, summary }`
 * 固定键序 JSON。
 *
 * **不含** `draft_version`（K4，它是 CAS 乐观锁不是版本）与 `answers`（K7），
 * 也不含任何评卷字段。sealed 稿次不可变 → `changed` 不可达（§5 承认的事实）。
 */
export function sheetFieldText(target: Extract<LoadedTarget, { kind: "sheet" }>): string {
  return JSON.stringify({
    scope: target.scope,
    revisionNo: target.revision_no ?? null,
    summary: target.summary ?? null,
  });
}

/**
 * N2 第三条链：attempt 引用的 hash 输入（K15 写死）= `{ venue, answer }`，
 * `answer` 先做键序稳定化（同上，保证可复算）。
 *
 * **不含** `deleted_at` / `created_at` / `self_assessment`；attempt 行不可变
 * （K12）→ `changed` 不可达。
 */
export function attemptFieldText(target: Extract<LoadedTarget, { kind: "attempt" }>): string {
  return JSON.stringify({ venue: target.venue, answer: canonicalJson(target.answer) });
}

/**
 * N2 第四条链（ADR-0039 决策 3）：评卷引用的 hash 输入 = `verdict` + `analysis_md`
 * 固定键序 JSON。**照 `assessment` 的 `content_md` 先例**：hash 只取内容字段。
 *
 * - 不能只取 `analysis_md`：verdict 与 analysis 可分别改判，只 hash 分析则
 *   「只改 verdict」不转 changed ⇒ 笔记里显示一个**已过期却无告警**的判定。
 * - `graded_by` / `graded_at` **不进 hash**：它们是归属事实不是内容；`graded_at`
 *   每次改判都刷新，进 hash 会让纯措辞调整也告警。两者只进快照。
 */
export function gradingFieldText(target: Extract<LoadedTarget, { kind: "grading" }>): string {
  return JSON.stringify({ verdict: target.verdict, analysis_md: target.analysis_md });
}

/**
 * N2 第五条链（ADR-0040 决策 4）：写作任务引用的 hash 输入 = `{title}` 固定键序 JSON。
 *
 * 沿 `noteFieldText`（只取内容字段）：`status`（active→archived）与 `updated_at`
 * **不进 hash** —— 归档是生命周期事件不是内容变化，进 hash 会让「任务归档」把所有
 * 引用它的笔记打成 changed（沿 note 先例的同一句话）。
 */
export function writingTaskFieldText(target: Extract<LoadedTarget, { kind: "writing_task" }>): string {
  return JSON.stringify({ title: target.title });
}

/**
 * N2 第五条链（ADR-0040 决策 4）：评阅引用的 hash 输入 = `feedback` jsonb 全文的
 * 键序稳定化 JSON。
 *
 * PG jsonb 的输出键序是实现细节，直接 stringify 会把「同一份评阅换个键序」误判成
 * changed —— 沿 `attemptFieldText` 的 `canonicalJson`。**不含** `version` /
 * `last_editor` / `updated_at`：CAS 计数器与归属事实不是内容（沿 ADR-0039 决策 3
 * 的 `graded_by` / `graded_at` 同款理由）。
 */
export function writingFeedbackFieldText(target: Extract<LoadedTarget, { kind: "writing_feedback" }>): string {
  return canonicalJsonText(target.feedback);
}

/** 按引用 kind 取"当前字段文本"（与 capture 的 hash 口径一致）；不可得返回 null。 */
export function currentFieldText(
  kind: ReferenceKind,
  optionKey: string | null,
  target: LoadedTarget,
): string | null {
  if (kind === "source" || kind === "source_quote") {
    return target.kind === "source" ? (target.content_text ?? "") : null;
  }
  if (kind === "note") {
    return target.kind === "note" ? noteFieldText(target) : null;
  }
  if (kind === "sheet") {
    return target.kind === "sheet" ? sheetFieldText(target) : null;
  }
  if (kind === "attempt") {
    return target.kind === "attempt" ? attemptFieldText(target) : null;
  }
  if (kind === "grading") {
    // ADR-0039 决策 3：hash 只取 verdict + analysis_md。归属字段不进 hash。
    return target.kind === "grading" ? gradingFieldText(target) : null;
  }
  if (kind === "writing_task") {
    // ADR-0040 决策 4：hash 只取 title。status/updated_at 不进 hash（归档不告警）。
    return target.kind === "writing_task" ? writingTaskFieldText(target) : null;
  }
  if (kind === "writing_feedback") {
    // ADR-0040 决策 4：hash 取 feedback 全文（键序稳定化）。version/last_editor 不进 hash。
    return target.kind === "writing_feedback" ? writingFeedbackFieldText(target) : null;
  }
  if (target.kind === "assessment") {
    // N2：评析的 hash 输入写死为 content_md（A2）；评析是 latest-wins 覆写，
    // 覆写后当前文本变化 → 已存引用转 changed，旧 content 快照保持不动（D3-2）。
    return kind === "assessment" ? target.content_md : null;
  }
  if (target.kind !== "question") return null;
  if (kind === "question") return questionFieldText(target);
  if (kind === "stem_quote") return target.stem;
  if (kind === "option_quote") {
    const option = target.options.find((candidate) => candidate.key === optionKey);
    return option ? option.text : null;
  }
  return null;
}

/**
 * 目标"当前标题"（source=标题；note=笔记标题；question/评析=可读来源标题，可能 null）。
 *
 * N2 第三条链：sheet / attempt **没有**标题列（稿次是 scope+summary，作答是
 * venue+answer），返回 null——不拼造一个伪标题，避免与 `liveTitle` 的语义混淆。
 *
 * N2 第五条链：writing_task 有自己的标题列（沿 note）；writing_feedback 的
 * summary 可达 1000 字，不是标题槽的形状 ⇒ 返回 null（卡片读快照里的 summary）。
 */
function liveTitleOf(target: LoadedTarget): string | null {
  if (target.kind === "source") return target.title;
  if (target.kind === "note") return target.title;
  if (target.kind === "writing_task") return target.title;
  // sheet / attempt / grading 三者都没有自己的标题列：稿次是 scope+summary、
  // 作答是 venue+answer、评卷是 verdict+analysis。返回材料题源标题（可读来源），
  // null 时不拼造伪标题（与 sheet/attempt 同款纪律）。
  // writing_feedback 同款：summary 是快照 headline（可达 1000 字），不是标题槽形状。
  if (target.kind === "sheet" || target.kind === "attempt") return null;
  if (target.kind === "writing_feedback") return null;
  return target.source_title;
}

/** 摘要截断不切代理对（前 max 个 UTF-16 code unit）。 */
function safeExcerpt(text: string | null, max: number): string {
  if (!text) return "";
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return cut.slice(0, -1);
  return cut;
}

/**
 * N2 第五条链：评阅快照的摘录源 = 四维度评论拼串（ADR-0040 决策 4）。
 *
 * 全 total 函数：jsonb 形状若不符合预期（历史行/手写行），回退到 summary，
 * 再回退到空串 —— **快照生成永不抛错**，capture 的失败只留给身份与状态判定。
 * 注意：这里只做摘录源选取，截断仍走 `safeExcerpt`（不切代理对）。
 */
function feedbackExcerptSource(feedback: unknown): string {
  const summary = (feedback !== null && typeof feedback === "object" && !Array.isArray(feedback)
    && typeof (feedback as Record<string, unknown>).summary === "string")
    ? ((feedback as Record<string, unknown>).summary as string)
    : "";
  const dimensions = (feedback !== null && typeof feedback === "object" && !Array.isArray(feedback))
    ? (feedback as Record<string, unknown>).dimensions
    : null;
  if (dimensions === null || typeof dimensions !== "object" || Array.isArray(dimensions)) {
    return summary;
  }
  const parts: string[] = [];
  for (const value of Object.values(dimensions as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const comment = (value as Record<string, unknown>).comment;
    if (typeof comment === "string" && comment.trim()) parts.push(comment.trim());
  }
  const joined = parts.join(" / ");
  return joined || summary;
}

/** 分页上限（默认 20、最大 50，设计 §7）。 */
function clampPageLimit(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return STUDY_PAGE_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.trunc(value), 1), STUDY_PAGE_LIMIT_MAX);
}

function assertQuote(field: string, start: number, end: number, quote: string): void {
  if (!validateQuote(field, start, end, quote)) {
    throw new ValidationError("原文已变化，请重新选择引用", "quote");
  }
}

/**
 * 输入 target → loadTargets/lockTargets 的键集合（F5：UUID 身份规范小写，
 * 与 DB 返回形态一致）。
 *
 * N2：评析目标返回**两**个键——评析自身（装载/锁）与其所属题（锁）。后者让
 * 「capture 评析」与「删题级联删评析」共用 `l3_question:<id>` advisory 键，
 * 否则并发窗口内会撞 FK 而不是被 blocker 拦下。
 */
/** loadTargets 返回的 map 键（与 repository 装载时写入的键同构）。 */
export function targetKeyOf(target: ReferenceTarget): string {
  if (target.kind === "source" || target.kind === "source_quote") {
    return `source:${normalizeStudyUuid(target.sourceId)}`;
  }
  if (target.kind === "assessment") {
    return `assessment:${normalizeStudyUuid(target.assessmentId)}`;
  }
  if (target.kind === "note") {
    // N2 第二条链：笔记目标自带完整身份，不需要第二个键（不像评析还要锁所属题）。
    return `note:${normalizeStudyUuid(target.noteId)}`;
  }
  if (target.kind === "sheet") {
    // N2 第三条链：sheet 身份是稿次行自身（`submission_id`）——revisionNo 是
    // writing 稿次的**半片**身份（存在引用行里备查），不参与装载键：同一稿次行的
    // revision 是它自己的属性，不是另一条装载路径。
    return `sheet:${normalizeStudyUuid(target.submissionId)}`;
  }
  if (target.kind === "attempt") {
    // N2 第三条链：attempt 身份就是 attemptId 单值（K9），不按 question / sheet 兜底。
    return `attempt:${normalizeStudyUuid(target.attemptId)}`;
  }
  if (target.kind === "grading") {
    // N2 第四条链（ADR-0039 决策 2）：身份 = `{sheetId, questionId}` 复合串。
    // 刻意**不**用 `l3_grading_results.id` 作身份：那一行在改判时被原地覆写
    // （ON CONFLICT DO UPDATE 不换 id），钉它等于钉「那一格坐标」——语义恰好是
    // 「当前评卷」，但坐标串可读、可核对，且不把内部行 id 泄漏进引用契约。
    return `grading:${normalizeStudyUuid(target.sheetId)}:${normalizeStudyUuid(target.questionId)}`;
  }
  if (target.kind === "writing_task") {
    // N2 第五条链（ADR-0040 决策 4）：任务身份就是任务自身 id（沿 note，不按标题判等）。
    return `writing_task:${normalizeStudyUuid(target.taskId)}`;
  }
  if (target.kind === "writing_feedback") {
    // N2 第五条链（ADR-0040 决策 4）：一纸一行，身份 = sheetId（沿 grading 的可读坐标
    // 纪律；不把反馈行 id 泄漏进引用契约，且装载时天然带出 sealed 过滤）。
    return `writing_feedback:${normalizeStudyUuid(target.sheetId)}`;
  }
  return `question:${normalizeStudyUuid(target.questionId)}`;
}

export function targetRefsOf(target: ReferenceTarget): { kind: ReferenceTargetKind; id: string }[] {
  if (target.kind === "source" || target.kind === "source_quote") {
    return [{ kind: "source", id: normalizeStudyUuid(target.sourceId) }];
  }
  if (target.kind === "assessment") {
    return [
      { kind: "question", id: normalizeStudyUuid(target.questionId) },
      { kind: "assessment", id: normalizeStudyUuid(target.assessmentId) },
    ];
  }
  if (target.kind === "note") {
    return [{ kind: "note", id: normalizeStudyUuid(target.noteId) }];
  }
  if (target.kind === "sheet") {
    // 只返回自身键——不额外装载其题目 / 来源（K5 无身份兜底）。
    return [{ kind: "sheet", id: normalizeStudyUuid(target.submissionId) }];
  }
  if (target.kind === "attempt") {
    // 只返回自身键——不装载 question / sheet（K9）。
    return [{ kind: "attempt", id: normalizeStudyUuid(target.attemptId) }];
  }
  if (target.kind === "grading") {
    // 只返回自身键——**不**顺带装载 question / sheet（K5 / K7 同款：一次只展开一层，
    // 且快照白名单不得因搭便车而携带题面标准答案或作答）。
    return [{
      kind: "grading",
      id: `${normalizeStudyUuid(target.sheetId)}:${normalizeStudyUuid(target.questionId)}`,
    }];
  }
  if (target.kind === "writing_task") {
    // 只返回自身键——不装载所属题目（题干另有 question kind 可引，不拼第二份真源）。
    return [{ kind: "writing_task", id: normalizeStudyUuid(target.taskId) }];
  }
  if (target.kind === "writing_feedback") {
    // 只返回自身键——不装载所属稿次/任务（一次只展开一层）。
    return [{ kind: "writing_feedback", id: normalizeStudyUuid(target.sheetId) }];
  }
  return [{ kind: "question", id: normalizeStudyUuid(target.questionId) }];
}

/** 引用行 → 重建输入 target（响应与 resolve 用）。 */
export function referenceRowToTarget(row: L3StudyNoteReferenceRow): ReferenceTarget {
  switch (row.kind) {
    case "source":
      return { kind: "source", sourceId: row.source_id! };
    case "source_quote":
      return {
        kind: "source_quote",
        sourceId: row.source_id!,
        start: row.start_offset!,
        end: row.end_offset!,
        quote: row.quote_snapshot!,
      };
    case "question":
      return { kind: "question", questionId: row.question_id! };
    case "stem_quote":
      return {
        kind: "stem_quote",
        questionId: row.question_id!,
        start: row.start_offset!,
        end: row.end_offset!,
        quote: row.quote_snapshot!,
      };
    case "option_quote":
      return {
        kind: "option_quote",
        questionId: row.question_id!,
        optionKey: row.option_key!,
        start: row.start_offset!,
        end: row.end_offset!,
        quote: row.quote_snapshot!,
      };
    case "assessment":
      return {
        kind: "assessment",
        questionId: row.question_id!,
        assessmentId: row.assessment_id!,
      };
    case "grading":
      // N2 第四条链：行内目标列就是 `{submission_id, question_id}`（无新增列）。
      return {
        kind: "grading",
        sheetId: row.submission_id!,
        questionId: row.question_id!,
      };
    case "writing_task":
      // N2 第五条链：任务 id 存独立列（target_note_id 背着 RESTRICT FK，不能借）。
      return { kind: "writing_task", taskId: row.writing_task_id! };
    case "writing_feedback":
      // N2 第五条链：评阅身份即 sheet，复用 submission_id（沿 grading 的复用纪律）。
      return { kind: "writing_feedback", sheetId: row.submission_id! };
    case "note":
      return { kind: "note", noteId: row.target_note_id! };
    case "sheet":
      return {
        kind: "sheet",
        submissionId: row.submission_id!,
        revisionNo: row.submission_revision_no ?? null,
      };
    case "attempt":
      return { kind: "attempt", attemptId: row.attempt_id! };
  }
}

// ── Service ──────────────────────────────────────────────────────────────

export class L3StudyReferenceService {
  constructor(
    private readonly txRunner: TxRunner = withTransaction,
    private readonly reposFactory: StudyReferenceReposFactory = (tx) => ({
      studyReferences: new L3StudyReferenceRepository(tx),
    }),
  ) {}

  /**
   * 读取真实目标并生成一条待保存的引用行（快照/hash 均服务端生成）。
   * 应在已 lockTargets 的保存事务内调用；目标不存在或不可见 → 404，
   * quote 不匹配/选项不存在 → 422。
   */
  async capture(
    userId: string,
    input: CaptureReferenceInput,
    repos: StudyReferenceRepos,
  ): Promise<StudyReferenceInsertRow> {
    const refs = targetRefsOf(input.target);
    const loaded = await repos.studyReferences.loadTargets(userId, refs);
    const target = loaded.get(targetKeyOf(input.target));
    if (!target) {
      throw new NotFoundError("StudyReferenceTarget", targetKeyOf(input.target));
    }
    return {
      id: normalizeStudyUuid(input.id),
      ...this.captureAgainst(input.target, target),
      captured_at: new Date().toISOString(),
    };
  }

  /** 对已加载目标构建引用行（id/captured_at 由调用方补；供批量保存复用，避免重复 loadTargets）。 */
  captureAgainst(target: ReferenceTarget, loaded: LoadedTarget): Omit<StudyReferenceInsertRow, "id" | "captured_at"> {
    switch (target.kind) {
      case "source": {
        if (loaded.kind !== "source" || loaded.id !== normalizeStudyUuid(target.sourceId)) {
          throw new NotFoundError("StudyReferenceTarget", `source:${target.sourceId}`);
        }
        return {
          kind: "source",
          source_id: loaded.id,
          question_id: null,
          assessment_id: null,
          target_note_id: null,
          submission_id: null,
          submission_revision_no: null,
          attempt_id: null,
          writing_task_id: null,
          option_key: null,
          start_offset: null,
          end_offset: null,
          quote_snapshot: null,
          field_hash: sha256Hex(loaded.content_text ?? ""),
          display_snapshot: {
            kind: "source",
            title: loaded.title,
            excerpt: safeExcerpt(loaded.content_text, STUDY_SOURCE_EXCERPT_MAX),
          },
        };
      }
      case "source_quote": {
        if (loaded.kind !== "source" || loaded.id !== normalizeStudyUuid(target.sourceId)) {
          throw new NotFoundError("StudyReferenceTarget", `source:${target.sourceId}`);
        }
        if (loaded.content_text == null) {
          throw new ValidationError("该来源没有可引用的正文", "quote");
        }
        assertQuote(loaded.content_text, target.start, target.end, target.quote);
        return {
          kind: "source_quote",
          source_id: loaded.id,
          question_id: null,
          assessment_id: null,
          target_note_id: null,
          submission_id: null,
          submission_revision_no: null,
          attempt_id: null,
          writing_task_id: null,
          option_key: null,
          start_offset: target.start,
          end_offset: target.end,
          quote_snapshot: target.quote,
          field_hash: sha256Hex(loaded.content_text),
          display_snapshot: { kind: "source_quote", title: loaded.title, quote: target.quote },
        };
      }
      case "question": {
        if (loaded.kind !== "question" || loaded.id !== normalizeStudyUuid(target.questionId)) {
          throw new NotFoundError("StudyReferenceTarget", `question:${target.questionId}`);
        }
        return {
          kind: "question",
          source_id: null,
          question_id: loaded.id,
          assessment_id: null,
          target_note_id: null,
          submission_id: null,
          submission_revision_no: null,
          attempt_id: null,
          writing_task_id: null,
          option_key: null,
          start_offset: null,
          end_offset: null,
          quote_snapshot: null,
          field_hash: sha256Hex(questionFieldText(loaded)),
          display_snapshot: {
            kind: "question",
            stem: loaded.stem,
            options: loaded.options.map((option) => ({ key: option.key, text: option.text })),
            questionType: loaded.question_type,
            sourceTitle: loaded.source_title,
          },
        };
      }
      case "stem_quote": {
        if (loaded.kind !== "question" || loaded.id !== normalizeStudyUuid(target.questionId)) {
          throw new NotFoundError("StudyReferenceTarget", `question:${target.questionId}`);
        }
        assertQuote(loaded.stem, target.start, target.end, target.quote);
        return {
          kind: "stem_quote",
          source_id: null,
          question_id: loaded.id,
          assessment_id: null,
          target_note_id: null,
          submission_id: null,
          submission_revision_no: null,
          attempt_id: null,
          writing_task_id: null,
          option_key: null,
          start_offset: target.start,
          end_offset: target.end,
          quote_snapshot: target.quote,
          field_hash: sha256Hex(loaded.stem),
          display_snapshot: {
            kind: "stem_quote",
            quote: target.quote,
            questionType: loaded.question_type,
            sourceTitle: loaded.source_title,
          },
        };
      }
      case "assessment": {
        if (
          loaded.kind !== "assessment" ||
          loaded.id !== normalizeStudyUuid(target.assessmentId) ||
          loaded.question_id !== normalizeStudyUuid(target.questionId)
        ) {
          // 题与评析不匹配 → 404（不可见/不存在），不做「按题找最新评析」的兜底：
          // 那会把「引用某条评析」悄悄变成「引用当前评析」，违背 D3-2。
          throw new NotFoundError(
            "StudyReferenceTarget",
            `assessment:${target.assessmentId}`,
          );
        }
        return {
          kind: "assessment",
          source_id: null,
          question_id: loaded.question_id,
          assessment_id: loaded.id,
          target_note_id: null,
          submission_id: null,
          submission_revision_no: null,
          attempt_id: null,
          writing_task_id: null,
          option_key: null,
          start_offset: null,
          end_offset: null,
          quote_snapshot: null,
          field_hash: sha256Hex(loaded.content_md),
          display_snapshot: {
            kind: "assessment",
            excerpt: safeExcerpt(loaded.content_md, STUDY_ASSESSMENT_EXCERPT_MAX),
            questionType: loaded.question_type,
            sourceTitle: loaded.source_title,
          },
        };
      }
      case "note": {
        if (loaded.kind !== "note" || loaded.id !== normalizeStudyUuid(target.noteId)) {
          throw new NotFoundError("StudyReferenceTarget", `note:${target.noteId}`);
        }
        // 合同：目标必须属于当前用户且为 active 才能新建引用。归档目标不可新建——
        // 但**已存**引用不撤销（resolve 仍按快照 hash 出 current/changed，见上）。
        if (loaded.status !== "active") {
          throw new NotFoundError("StudyReferenceTarget", `note:${target.noteId}`);
        }
        return {
          kind: "note",
          source_id: null,
          question_id: null,
          assessment_id: null,
          target_note_id: loaded.id,
          submission_id: null,
          submission_revision_no: null,
          attempt_id: null,
          writing_task_id: null,
          option_key: null,
          start_offset: null,
          end_offset: null,
          quote_snapshot: null,
          field_hash: sha256Hex(noteFieldText(loaded)),
          // 只展开一层：不读取、不嵌入目标笔记自身的引用集合。
          display_snapshot: {
            kind: "note",
            title: loaded.title,
            excerpt: safeExcerpt(loaded.body_md, STUDY_NOTE_EXCERPT_MAX),
          },
        };
      }
      case "sheet": {
        if (loaded.kind !== "sheet" || loaded.id !== normalizeStudyUuid(target.submissionId)) {
          throw new NotFoundError("StudyReferenceTarget", `sheet:${target.submissionId}`);
        }
        // D1-a / K1：只有 sealed 稿次是合法目标。draft / discarded 一律 404
        // （不是 409——「还不存在稳定身份」不是冲突）。装载侧已过滤，这里是双保险，
        // 防止日后放宽装载条件时 draft 被静默认为稳定身份（K2）。
        if (loaded.status !== "sealed") {
          throw new NotFoundError("StudyReferenceTarget", `sheet:${target.submissionId}`);
        }
        const revisionNo = target.revisionNo ?? null;
        if (loaded.scope === "writing") {
          // K3 / V-17：writing 稿次身份 = { submissionId, revisionNo }；
          // 缺 revisionNo → 422（输入形态错误），与已存 revision 不符 → 404
          // （身份不匹配，**不**退化为「引用该稿次当前 revision」）。
          if (revisionNo == null || revisionNo <= 0) {
            throw new ValidationError("writing 稿次引用必须带 revisionNo（正整数）", "revisionNo");
          }
          if (loaded.revision_no !== revisionNo) {
            throw new NotFoundError("StudyReferenceTarget", `sheet:${target.submissionId}`);
          }
        } else if (revisionNo != null) {
          // 非 writing（file / paper）稿次没有 revision 身份；传了即身份不匹配。
          throw new NotFoundError("StudyReferenceTarget", `sheet:${target.submissionId}`);
        }
        return {
          kind: "sheet",
          source_id: null,
          question_id: null,
          assessment_id: null,
          target_note_id: null,
          submission_id: loaded.id,
          submission_revision_no: loaded.revision_no ?? null,
          attempt_id: null,
          writing_task_id: null,
          option_key: null,
          start_offset: null,
          end_offset: null,
          quote_snapshot: null,
          field_hash: sha256Hex(sheetFieldText(loaded)),
          // K14 / K7：快照只有 scope + summary 摘录——不含 answers、题目答案、
          // 解析、evidence，也不含任何评卷字段。
          display_snapshot: {
            kind: "sheet",
            scope: loaded.scope,
            summaryExcerpt: safeExcerpt(loaded.summary, STUDY_SHEET_EXCERPT_MAX),
          },
        };
      }
      case "attempt": {
        if (loaded.kind !== "attempt" || loaded.id !== normalizeStudyUuid(target.attemptId)) {
          throw new NotFoundError("StudyReferenceTarget", `attempt:${target.attemptId}`);
        }
        // K10：软删（status='deleted'）不可新建引用；装载侧已过滤，这里是双保险，
        // 且**不**做「按题目找最新一次 attempt」的兜底（K9）。
        if (loaded.status !== "active") {
          throw new NotFoundError("StudyReferenceTarget", `attempt:${target.attemptId}`);
        }
        return {
          kind: "attempt",
          source_id: null,
          question_id: null,
          assessment_id: null,
          target_note_id: null,
          submission_id: null,
          submission_revision_no: null,
          attempt_id: loaded.id,
          writing_task_id: null,
          option_key: null,
          start_offset: null,
          end_offset: null,
          quote_snapshot: null,
          field_hash: sha256Hex(attemptFieldText(loaded)),
          // K14 / K7：快照只有 venue + 作答 JSON 摘录（attempt 表无判定列），
          // 不含标准答案 / 解析 / evidence / 评卷字段。
          display_snapshot: {
            kind: "attempt",
            venue: loaded.venue,
            answerExcerpt: safeExcerpt(canonicalJsonText(loaded.answer), STUDY_ATTEMPT_EXCERPT_MAX),
          },
        };
      }
      case "grading": {
        // N2 第四条链（ADR-0039）。身份匹配失败即 404，**不做**「按题找该题最新评卷」
        // 或「按 sheet 找任意评卷」的兜底 —— 那会把「引用这一格的判定」悄悄变成
        // 「引用某一时刻的判定」，违背 D3-2（快照必须对应捕获时看到的那一格）。
        if (
          loaded.kind !== "grading"
          || loaded.sheet_id !== normalizeStudyUuid(target.sheetId)
          || loaded.question_id !== normalizeStudyUuid(target.questionId)
        ) {
          throw new NotFoundError("StudyReferenceTarget", targetKeyOf(target));
        }
        // 决策 2 沿 K1：只有 sealed 稿次是合法目标（draft / discarded 一律 404，
        // 不是 409）。装载侧已过滤，这里是双保险（K2）。
        if (loaded.sheet_status !== "sealed") {
          throw new NotFoundError("StudyReferenceTarget", targetKeyOf(target));
        }
        return {
          kind: "grading",
          source_id: null,
          // 目标列复用 submission_id + question_id：**不新增列**（UNIQUE(sheet_id,
          // question_id) 已使这一对唯一确定那一行）。
          question_id: loaded.question_id,
          assessment_id: null,
          target_note_id: null,
          submission_id: loaded.sheet_id,
          // 决策 2：非 writing 稿次，revision 恒 null（K3 同款）。
          submission_revision_no: null,
          attempt_id: null,
          writing_task_id: null,
          option_key: null,
          start_offset: null,
          end_offset: null,
          quote_snapshot: null,
          // 决策 3：hash 只取 verdict + analysis_md。
          field_hash: sha256Hex(gradingFieldText(loaded)),
          // 决策 4：快照含归属事实（gradedBy / gradedAt），但它们不进 hash。
          display_snapshot: {
            kind: "grading",
            verdict: loaded.verdict,
            analysisExcerpt: safeExcerpt(loaded.analysis_md, STUDY_GRADING_EXCERPT_MAX),
            gradedBy: loaded.graded_by,
            gradedAt: loaded.graded_at,
            questionOrdinal: loaded.question_ordinal,
            questionType: loaded.question_type,
            sourceTitle: loaded.source_title,
          },
        };
      }
      case "writing_task": {
        // N2 第五条链（ADR-0040 决策 4）。身份匹配失败即 404，**不做**「按标题找任务」
        // 的兜底 —— 标题可改，兜底会把「引用这个任务」悄悄变成「引用同名任务」。
        if (loaded.kind !== "writing_task" || loaded.id !== normalizeStudyUuid(target.taskId)) {
          throw new NotFoundError("StudyReferenceTarget", targetKeyOf(target));
        }
        // 沿 note 合同：目标必须 active 才能新建引用。归档目标不可新建 —— 但**已存**
        // 引用不撤销（resolve 仍按快照 hash 出 current/changed）。
        if (loaded.status !== "active") {
          throw new NotFoundError("StudyReferenceTarget", targetKeyOf(target));
        }
        return {
          kind: "writing_task",
          source_id: null,
          question_id: null,
          assessment_id: null,
          target_note_id: null,
          submission_id: null,
          submission_revision_no: null,
          attempt_id: null,
          // 任务 id 存独立列（target_note_id 背着 RESTRICT FK，不能借）。
          writing_task_id: loaded.id,
          option_key: null,
          start_offset: null,
          end_offset: null,
          quote_snapshot: null,
          // 决策 4：hash 只取 title（status/updated_at 不进 hash，归档不告警）。
          field_hash: sha256Hex(writingTaskFieldText(loaded)),
          display_snapshot: {
            kind: "writing_task",
            title: loaded.title,
            taskKind: loaded.task_kind,
            direction: loaded.direction,
          },
        };
      }
      case "writing_feedback": {
        // N2 第五条链（ADR-0040 决策 1/4）。身份匹配失败即 404，**不做**「按稿次找
        // 任意评阅」的兜底 —— 一纸一行，兜底无意义；且会把「引用这稿的评阅」变成
        // 「引用别的稿的评阅」。
        if (loaded.kind !== "writing_feedback" || loaded.sheet_id !== normalizeStudyUuid(target.sheetId)) {
          throw new NotFoundError("StudyReferenceTarget", targetKeyOf(target));
        }
        // D1-a 落地：只有 sealed 稿次上的评阅是合法目标（draft 一律 404，不是 409）。
        // 装载侧已 JOIN 过滤，这里是双保险（K2 同款）。
        if (loaded.sheet_status !== "sealed") {
          throw new NotFoundError("StudyReferenceTarget", targetKeyOf(target));
        }
        return {
          kind: "writing_feedback",
          source_id: null,
          question_id: null,
          assessment_id: null,
          target_note_id: null,
          // 评阅身份即 sheet，复用 submission_id（沿 grading 的复用纪律，不新增列）。
          submission_id: loaded.sheet_id,
          submission_revision_no: null,
          attempt_id: null,
          writing_task_id: null,
          option_key: null,
          start_offset: null,
          end_offset: null,
          quote_snapshot: null,
          // 决策 4：hash 取 feedback 全文（键序稳定化）；version/last_editor 不进 hash。
          field_hash: sha256Hex(writingFeedbackFieldText(loaded)),
          // 快照 = summary 全文 + 维度评论摘录；无分数、无判定（schema 显式无 score）。
          display_snapshot: {
            kind: "writing_feedback",
            summary: loaded.summary,
            excerpt: safeExcerpt(feedbackExcerptSource(loaded.feedback), STUDY_FEEDBACK_EXCERPT_MAX),
          },
        };
      }
      case "option_quote": {
        if (loaded.kind !== "question" || loaded.id !== normalizeStudyUuid(target.questionId)) {
          throw new NotFoundError("StudyReferenceTarget", `question:${target.questionId}`);
        }
        const option = loaded.options.find((candidate) => candidate.key === target.optionKey);
        if (!option) {
          throw new ValidationError("选项不存在，请重新选择引用", "optionKey");
        }
        assertQuote(option.text, target.start, target.end, target.quote);
        return {
          kind: "option_quote",
          source_id: null,
          question_id: loaded.id,
          assessment_id: null,
          target_note_id: null,
          submission_id: null,
          submission_revision_no: null,
          attempt_id: null,
          writing_task_id: null,
          option_key: target.optionKey,
          start_offset: target.start,
          end_offset: target.end,
          quote_snapshot: target.quote,
          field_hash: sha256Hex(option.text),
          display_snapshot: {
            kind: "option_quote",
            optionKey: target.optionKey,
            quote: target.quote,
            questionType: loaded.question_type,
            sourceTitle: loaded.source_title,
          },
        };
      }
    }
  }

  /**
   * 批量解析已存引用行为预览（current/changed/unavailable）。
   * changed 保留旧摘录与旧 offset（不按新文本重定位）。
   */
  async resolve(
    userId: string,
    rows: readonly L3StudyNoteReferenceRow[],
    repos: StudyReferenceRepos,
  ): Promise<ReferencePreview[]> {
    if (rows.length === 0) return [];
    // N2：装载键集合必须与取值键（targetKeyOf）同源——评析引用取的是
    // `assessment:<assessment_id>`，若这里仍按「非 source 即 question」装载，
    // 忠实装载下必然取不到 → 评析引用恒被误判为 unavailable。
    // 统一走 targetRefsOf（评析同时装载所属题与评析自身，与 lockTargets 同口径）。
    const loaded = await repos.studyReferences.loadTargets(
      userId,
      rows.flatMap((row) => targetRefsOf(referenceRowToTarget(row))),
    );

    return rows.map((row) => {
      const target = loaded.get(targetKeyOf(referenceRowToTarget(row)));
      let status: ReferenceStatus;
      let liveTitle: string | null = null;
      if (!target) {
        status = "unavailable";
      } else {
        liveTitle = liveTitleOf(target);
        const field = currentFieldText(row.kind, row.option_key, target);
        status = field !== null && sha256Hex(field) === row.field_hash ? "current" : "changed";
      }
      return {
        id: row.id,
        target: referenceRowToTarget(row),
        status,
        capturedAt: row.captured_at,
        displaySnapshot: row.display_snapshot as unknown as ReferenceDisplaySnapshot,
        liveTitle,
      };
    });
  }

  /**
   * 只读预览（POST /reference-preview）：独立 actor 事务、零写、不持久化。
   * 目标不存在/不可见 → 404；quote 不匹配/选项不存在 → 422。
   */
  async preview(userId: string, target: ReferenceTarget): Promise<{ preview: ReferenceTargetPreview }> {
    return this.txRunner(
      async (tx) => {
        const repos = this.reposFactory(tx);
        const loaded = await repos.studyReferences.loadTargets(userId, targetRefsOf(target));
        const loadedTarget = loaded.get(targetKeyOf(target));
        if (!loadedTarget) {
          throw new NotFoundError("StudyReferenceTarget", targetKeyOf(target));
        }
        const preview = this.captureAgainst(target, loadedTarget);
        return {
          preview: {
            target,
            displaySnapshot: preview.display_snapshot as unknown as ReferenceDisplaySnapshot,
            liveTitle: liveTitleOf(loadedTarget),
          },
        };
      },
      { actorId: userId },
    );
  }

  /**
   * GET /reference-targets：目标搜索（每次只查一个 kind；摘要不含答案/解析/evidence）。
   * F4：游标为 createdAt 族并携带**过滤指纹**——绑定目标搜索族/kind/规范化 q/
   * 有效 venue（source 忽略无效 venue；limit 不参与指纹）。换 kind/q/有效 venue
   * 复用游标、或使用旧的不绑定条件游标 → 400（设计 §7）。
   */
  async search(
    userId: string,
    query: {
      kind: ReferenceTargetKind;
      q?: string | null;
      venue?: L3QuestionType | null;
      limit?: number | null;
      cursor?: string | null;
    },
  ): Promise<StudyPage<StudySourceTargetItem | StudyQuestionTargetItem>> {
    const limit = clampPageLimit(query.limit);
    // 与 SQL 一致的规范化条件：q 去首尾空白（空白视为无过滤）；venue 仅 question 生效。
    const effectiveQ = query.q?.trim() || null;
    const effectiveVenue = query.kind === "question" ? query.venue ?? null : null;
    const filter = studyFilterFingerprint([
      "reference-targets", query.kind, effectiveQ, effectiveVenue,
    ]);
    const cursor = decodeStudyCursor(query.cursor);
    if (cursor && (cursor.filter !== filter || cursor.sortKind !== "createdAt")) {
      throw new ValidationError("Invalid pagination cursor", "cursor");
    }
    return this.txRunner(
      async (tx) => {
        const repos = this.reposFactory(tx);
        const { items, total } = await repos.studyReferences.searchTargets({
          userId,
          kind: query.kind,
          q: effectiveQ,
          venue: effectiveVenue,
          cursor: cursor ? { createdAt: cursor.lastSort, id: cursor.id } : null,
          limit: limit + 1,
        });
        const hasMore = items.length > limit;
        const pageItems = hasMore ? items.slice(0, limit) : items;
        const mapped = pageItems.map((row) =>
          "stem" in row
            ? {
                id: row.id,
                stem: row.stem,
                questionType: row.question_type,
                createdAt: row.created_at,
              }
            : { id: row.id, title: row.title, createdAt: row.created_at },
        );
        let nextCursor: string | null = null;
        if (hasMore && pageItems.length > 0) {
          const last = pageItems[pageItems.length - 1]!;
          nextCursor = encodeStudyCursor({
            sortKind: "createdAt",
            lastSort: last.created_at,
            id: last.id,
            filter,
          });
        }
        return { items: mapped, total, nextCursor };
      },
      { actorId: userId },
    );
  }

  /**
   * GET /backlinks：反向引用（按 note 去重聚合，默认不含归档）。
   * cursor 绑定 targetKind+targetId 指纹（不能用于另一目标）。
   */
  async backlinks(
    userId: string,
    query: {
      targetKind: ReferenceTargetKind;
      targetId: string;
      limit?: number | null;
      cursor?: string | null;
    },
  ): Promise<StudyPage<StudyBacklinkItem>> {
    const limit = clampPageLimit(query.limit);
    const targetId = normalizeStudyUuid(query.targetId);
    const filter = studyFilterFingerprint([query.targetKind, targetId]);
    const cursor = decodeStudyCursor(query.cursor);
    if (cursor && (cursor.filter !== filter || cursor.sortKind !== "updatedAt")) {
      throw new ValidationError("Invalid pagination cursor", "cursor");
    }
    return this.txRunner(
      async (tx) => {
        const repos = this.reposFactory(tx);
        const { items, total } = await repos.studyReferences.listBacklinks({
          userId,
          targetKind: query.targetKind,
          targetId,
          cursor: cursor ? { updatedAt: cursor.lastSort, id: cursor.id } : null,
          limit: limit + 1,
        });
        const hasMore = items.length > limit;
        const pageItems = hasMore ? items.slice(0, limit) : items;
        const mapped = pageItems.map((row) => ({
          noteId: row.note_id,
          title: row.title,
          status: row.status as StudyNoteStatus,
          referenceCount: row.reference_count,
          refIds: row.ref_ids,
        }));
        let nextCursor: string | null = null;
        if (hasMore && pageItems.length > 0) {
          const last = pageItems[pageItems.length - 1]!;
          nextCursor = encodeStudyCursor({
            sortKind: "updatedAt",
            lastSort: last.updated_at,
            id: last.note_id,
            filter,
          });
        }
        return { items: mapped, total, nextCursor };
      },
      { actorId: userId },
    );
  }
}
