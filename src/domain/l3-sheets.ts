/**
 * 题纸（l3_submissions）与作答历史（l3_question_attempts）的 domain 契约
 * （批次二，ADR-0034 §1/§2/§5）——纯常量 + zod 纯函数，零 IO、零出向。
 *
 * 题纸 = 两个 venue（file/paper）的统一作答容器：scope_key 单列非空字符串
 * （'file:<source_id>:<question_type>' / 'paper:<paper_id>'）规避组合列在 NULL
 * 时唯一索引不去重的陷阱；状态机 draft→sealed|discarded 由 service 在条件
 * UPDATE 内收口（定格后 PATCH 409）。
 *
 * 定格三档（设计卡 §5）：full=完整记录（物化 attempts + 保留 sealed 题纸）；
 * incremental/summary=弃题纸（discarded）。answers 仅 draft 期有效——定格物化后
 * 清空，attempts 是唯一作答真源（拆双真相）。
 */
import { z } from "zod";
import { L3_QUESTION_TYPES } from "./l3-question-types";

export const SHEET_SCOPES = ["file", "paper"] as const;
export type SheetScope = (typeof SHEET_SCOPES)[number];

export const SHEET_STATUSES = ["draft", "sealed", "discarded"] as const;
export type SheetStatus = (typeof SHEET_STATUSES)[number];

export const SEAL_MODES = ["full", "incremental", "summary"] as const;
export type SealMode = (typeof SEAL_MODES)[number];

/** 单次 PATCH merge 的题目键上限（对齐 questionIds 1–200 既有口径）。 */
export const SHEET_PATCH_QUESTION_LIMIT = 200;

/** 定格谓词：仅 draft 可 PATCH / 定格（sealed 后 409 拒写）。 */
export function canPatchSheet(status: string): boolean {
  return status === "draft";
}

/** 定格后的题纸状态：完整记录保留 sealed；增量条目/只留总结弃为 discarded。 */
export function sheetStatusAfterSeal(mode: SealMode): Extract<SheetStatus, "sealed" | "discarded"> {
  return mode === "full" ? "sealed" : "discarded";
}

/**
 * scope_key 构造收口（服务端唯一构造点）：
 *   file  → 'file:<source_id>:<question_type>'
 *   paper → 'paper:<paper_id>'
 */
export function buildSheetScopeKey(
  input:
    | { scope: "file"; sourceId: string; questionType: string }
    | { scope: "paper"; paperId: string },
): string {
  if (input.scope === "file") return `file:${input.sourceId}:${input.questionType}`;
  return `paper:${input.paperId}`;
}

/**
 * 作答内容判据（口径统一修正 2026-09-17，单一真源）：choice / choices / text 任一非空
 * = 已作答；仅主观痕迹（marks/flags/optionFlags）、空对象、未知形状 = 未作答。
 * 定格软确认与导出/历史摘要共用本判据；物化不受影响（痕迹不丢）。
 */
export function hasAnswerContent(answer: unknown): boolean {
  if (answer == null) return false;
  if (typeof answer === "string") return answer.trim().length > 0;
  if (typeof answer === "object" && !Array.isArray(answer)) {
    const record = answer as { choice?: unknown; choices?: unknown; text?: unknown };
    if (typeof record.choice === "string" && record.choice.trim().length > 0) return true;
    if (Array.isArray(record.choices) && record.choices.length > 0) return true;
    if (typeof record.text === "string" && record.text.trim().length > 0) return true;
  }
  return false;
}

/**
 * 未答题计数（paper 交卷软确认数据源）：无作答内容（缺键 / 显式 null / 仅主观痕迹 /
 * 空对象）均计未答——判据见 hasAnswerContent（口径统一修正 2026-09-17：旧实现以
 * 「answer 非空」判定，只标记未选答案的题会漏过软确认）。
 * 纯函数，计数由调用侧与作用域题集（file=题组；paper=payload sections）对齐。
 */
export function countUnansweredQuestions(
  questionIds: readonly string[],
  answers: Readonly<Record<string, unknown>>,
): number {
  return questionIds.filter((id) => !hasAnswerContent(answers[id])).length;
}

/** 开纸输入：file=sourceId+questionType；paper=paperId；两 scope 字段互斥。 */
export const sheetOpenInputSchema = z.object({
  scope: z.enum(SHEET_SCOPES),
  sourceId: z.string().uuid().optional(),
  questionType: z.enum(L3_QUESTION_TYPES).optional(),
  paperId: z.string().uuid().optional(),
}).superRefine((v, ctx) => {
  if (v.scope === "file") {
    if (!v.sourceId) ctx.addIssue({ code: "custom", message: "file 作用域必须提供 sourceId" });
    if (!v.questionType) ctx.addIssue({ code: "custom", message: "file 作用域必须提供 questionType" });
    if (v.paperId) ctx.addIssue({ code: "custom", message: "file 作用域不得携带 paperId" });
    return;
  }
  if (!v.paperId) ctx.addIssue({ code: "custom", message: "paper 作用域必须提供 paperId" });
  if (v.sourceId || v.questionType) {
    ctx.addIssue({ code: "custom", message: "paper 作用域不得携带 sourceId/questionType" });
  }
});

export type SheetOpenInput = z.infer<typeof sheetOpenInputSchema>;

// ── answers 显式键契约（ADR-0034 增补条 8 / 设计卡 §10/§4.6）─────────────────

/** 标记作用域：passage=原文（材料正文），stem=题干（题面文本），option=选项文本（optionKey 定位）。 */
export const SHEET_ANSWER_MARK_SCOPES = ["passage", "stem", "option"] as const;
export type SheetAnswerMarkScope = (typeof SHEET_ANSWER_MARK_SCOPES)[number];

/**
 * 单条标记（轻痕迹，非资产）：正文/题面/选项偏移区间，end>start。
 * option 以 optionKey 定位（同区间不同选项是不同标记）；其余 scope 不得携带 optionKey。
 */
export const sheetAnswerMarkSchema = z.object({
  scope: z.enum(SHEET_ANSWER_MARK_SCOPES),
  /** 仅 scope='option' 时携带：选项键（A–D 等，与 answers choice 键集同源）。 */
  optionKey: z.string().trim().min(1).max(8).optional(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
}).strict().superRefine((v, ctx) => {
  if (v.end <= v.start) ctx.addIssue({ code: "custom", message: "标记 end 必须大于 start" });
  if (v.scope === "option" && v.optionKey == null) {
    ctx.addIssue({ code: "custom", message: "option 标记必须携带 optionKey" });
  }
  if (v.scope !== "option" && v.optionKey != null) {
    ctx.addIssue({ code: "custom", message: "仅 option 标记可携带 optionKey" });
  }
});

export type SheetAnswerMark = z.infer<typeof sheetAnswerMarkSchema>;

/** 标记去重键：同 scope(+optionKey)+start+end 视为同一标记（契约层去重判据唯一来源）。 */
export function sheetAnswerMarkKey(mark: SheetAnswerMark): string {
  const optionPart = mark.scope === "option" ? `${mark.optionKey}:` : "";
  return `${mark.scope}:${optionPart}${mark.start}:${mark.end}`;
}

/** 旗标（§10）：doubt=存疑（认知状态，物化进 self_assessment）；recheck=待复查（流程状态，进定格软确认计数；2026-09-17 复核修订：随 flags 整段物化）。 */
export const sheetAnswerFlagsSchema = z.object({
  doubt: z.boolean().optional(),
  recheck: z.boolean().optional(),
}).strict();

export type SheetAnswerFlags = z.infer<typeof sheetAnswerFlagsSchema>;

/**
 * 题纸 answers 值的显式键契约（strict 收口防腐化）：
 * choice=选项键（单选起步）；flags=题级旗标；optionFlags=选项级存疑键列；
 * marks=内容标记（原文/题干/选项）。全部 optional 无 default（PATCH 未提交键不被填充）；
 * marks 同 scope+start+end、optionFlags 同键重复即拒（fail-closed，前端幂等添加保证不产生）。
 */
export const sheetAnswerSchema = z.object({
  choice: z.string().trim().min(1).max(8).optional(),
  flags: sheetAnswerFlagsSchema.optional(),
  optionFlags: z.array(z.string().trim().min(1).max(8)).max(16).optional(),
  marks: z.array(sheetAnswerMarkSchema).max(200).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.marks) {
    const seen = new Set<string>();
    for (const mark of v.marks) {
      const key = sheetAnswerMarkKey(mark);
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", message: "marks 存在重复标记（同去重键）" });
        break;
      }
      seen.add(key);
    }
  }
  if (v.optionFlags) {
    const seen = new Set<string>();
    for (const key of v.optionFlags) {
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", message: "optionFlags 存在重复选项键" });
        break;
      }
      seen.add(key);
    }
  }
});

export type SheetAnswer = z.infer<typeof sheetAnswerSchema>;

/**
 * 状态归一（前端草稿状态机用）：清理空键——flags 空对象/数组空列删除；
 * 三键与 choice 全空返回 null（整体清除语义，PATCH 传 null）。
 */
export function pruneSheetAnswer(answer: SheetAnswer): SheetAnswer | null {
  const next: SheetAnswer = {};
  if (typeof answer.choice === "string" && answer.choice.length > 0) next.choice = answer.choice;
  if (answer.flags && Object.keys(answer.flags).length > 0) next.flags = answer.flags;
  if (answer.optionFlags && answer.optionFlags.length > 0) next.optionFlags = answer.optionFlags;
  if (answer.marks && answer.marks.length > 0) next.marks = answer.marks;
  return Object.keys(next).length > 0 ? next : null;
}

/** 去重添加标记（同 scope+start+end 幂等：已存在则原样返回副本，不重复）。 */
export function addSheetAnswerMark(
  marks: readonly SheetAnswerMark[],
  mark: SheetAnswerMark,
): SheetAnswerMark[] {
  const key = sheetAnswerMarkKey(mark);
  if (marks.some((entry) => sheetAnswerMarkKey(entry) === key)) return [...marks];
  return [...marks, mark];
}

/** 移除标记（存在才删；返回新数组，原数组不动——点已有高亮取消标记的纯函数）。 */
export function removeSheetAnswerMark(
  marks: readonly SheetAnswerMark[],
  mark: SheetAnswerMark,
): SheetAnswerMark[] {
  const key = sheetAnswerMarkKey(mark);
  return marks.filter((entry) => sheetAnswerMarkKey(entry) !== key);
}

/** 待复查计数（定格软确认数据源：仅题级 flags.recheck===true，脏值不算）。 */
export function countRecheckQuestions(
  questionIds: readonly string[],
  answers: Readonly<Record<string, unknown>>,
): number {
  return questionIds.filter((id) => {
    const value = answers[id];
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const flags = (value as { flags?: unknown }).flags;
    if (!flags || typeof flags !== "object" || Array.isArray(flags)) return false;
    return (flags as { recheck?: unknown }).recheck === true;
  }).length;
}

/** 当场主观状态快照（物化进 attempts.self_assessment）：存疑 + 选项存疑 + 标记。 */
export interface AttemptSelfAssessment {
  flags?: Record<string, boolean>;
  optionFlags?: string[];
  marks?: SheetAnswerMark[];
}

/**
 * 从 draft answer 提取主观状态快照（§4.6/§10）：flags/optionFlags/marks 任一非空
 * 才有值，三键全空返回 null（保持「无采集」语义与批次二历史 null 一致）。
 */
export function buildAttemptSelfAssessment(answer: unknown): AttemptSelfAssessment | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const value = answer as { flags?: unknown; optionFlags?: unknown; marks?: unknown };
  const result: AttemptSelfAssessment = {};
  if (value.flags && typeof value.flags === "object" && !Array.isArray(value.flags)
    && Object.keys(value.flags).length > 0) {
    result.flags = value.flags as Record<string, boolean>;
  }
  if (Array.isArray(value.optionFlags) && value.optionFlags.length > 0) {
    result.optionFlags = value.optionFlags as string[];
  }
  if (Array.isArray(value.marks) && value.marks.length > 0) {
    result.marks = value.marks as SheetAnswerMark[];
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * 剥离主观状态字段后的纯作答事实（attempt.answer 物化用，§2.1「attempt 只存
 * 作答事实」）：flags/optionFlags/marks 不进 answer（它们在 self_assessment）。
 */
export function stripAnswerSubjectiveFields(answer: unknown): Record<string, unknown> {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answer as Record<string, unknown>)) {
    if (key === "flags" || key === "optionFlags" || key === "marks") continue;
    rest[key] = value;
  }
  return rest;
}

/**
 * PATCH 逐题 merge：`answers: Record<questionId, answer|null>`，null 清除该题。
 * 值为 answers 显式键契约（ADR-0034 增补条 8）；至少 1 键、最多 200 键。
 */
export const sheetPatchInputSchema = z.object({
  answers: z.record(z.string().uuid(), sheetAnswerSchema.nullable()),
}).superRefine((v, ctx) => {
  const keyCount = Object.keys(v.answers).length;
  if (keyCount === 0) ctx.addIssue({ code: "custom", message: "answers 至少提交一个题目键" });
  if (keyCount > SHEET_PATCH_QUESTION_LIMIT) {
    ctx.addIssue({ code: "custom", message: `answers 单次最多 ${SHEET_PATCH_QUESTION_LIMIT} 个题目键` });
  }
});

export type SheetPatchInput = z.infer<typeof sheetPatchInputSchema>;

/**
 * 定格输入：mode 三档 + summary?（仅 summary 档必填）+ 未答题软确认标志。
 * 未答题 > 0 且未确认时 service 返回 409（details.unansweredCount），前端据此
 * 弹软确认后带 acknowledgeUnanswered=true 重发。
 */
export const sheetSealInputSchema = z.object({
  mode: z.enum(SEAL_MODES),
  summary: z.string().trim().max(2000).optional(),
  acknowledgeUnanswered: z.boolean().optional().default(false),
}).superRefine((v, ctx) => {
  if (v.mode === "summary" && !v.summary) {
    ctx.addIssue({ code: "custom", message: "只留总结档必须提供本次刷题总结" });
  }
});

export type SheetSealInput = z.infer<typeof sheetSealInputSchema>;

/**
 * attempt 契约（存储与交互解耦）：answer 为题型无关 JSON；当场自评快照形状宽松
 * （题类型各自定义键，服务端只做 JSON 可序列化收口）。
 */
export const attemptCreateSchema = z.object({
  questionId: z.string().uuid(),
  venue: z.enum(SHEET_SCOPES),
  answer: z.json(),
  selfAssessment: z.record(z.string(), z.json()).nullable().optional(),
});

export type AttemptCreateInput = z.infer<typeof attemptCreateSchema>;

/** attempts 批量查询的题目 id 窗口（1–200，对齐注记批量口径）。 */
export const attemptQuestionIdsSchema = z.array(z.string().uuid()).min(1).max(200);

export type AttemptQuestionIds = z.infer<typeof attemptQuestionIdsSchema>;

// ── agent 面契约（批次三执行面；本批只定形状，无 agent 写端点）─────────────

/**
 * 评卷授权摘要（ADR-0034 §4）——capabilities 能力发现面对 agent 广播的单一真源：
 * 提交即授权（可读 = 随题纸提交的草稿注记；写面 = 只写 review）；执行面批次三。
 */
export const L3_GRADING_AUTHORIZATION = {
  annotationReadScope: "submitted_sheet_drafts",
  annotationWriteScope: "review_only",
} as const;

/**
 * 注记检验产物（ADR-0034 §4「提交即授权」）：
 * agent 只写 review 段——note / 锚点 / 用户原判标签是不可篡改的原始事实；
 * 订正放 review.corrected_*，采纳归 owner（owner 手动改自己的注记，或不理会）。
 */
export const ANNOTATION_REVIEW_VERDICTS = ["sound", "questionable", "wrong"] as const;
export type AnnotationReviewVerdict = (typeof ANNOTATION_REVIEW_VERDICTS)[number];

export const annotationReviewSchema = z.object({
  verdict: z.enum(ANNOTATION_REVIEW_VERDICTS),
  /** 订正建议标签（对齐注记标签上限：单标签 ≤30 字、单段 ≤8 条）。 */
  corrected_tags: z.array(z.string().trim().min(1).max(30)).max(8).optional(),
  comment: z.string().trim().max(2000).optional(),
}).strict();

export type AnnotationReview = z.infer<typeof annotationReviewSchema>;

/** 评卷产物 `annotation_reviews[]` 段（批次三评卷提交携带；对齐 0034 review 列形状）。 */
export const annotationReviewEntrySchema = z.object({
  annotation_id: z.string().uuid(),
  review: annotationReviewSchema,
}).strict();

export const annotationReviewsSectionSchema = z.object({
  annotation_reviews: z.array(annotationReviewEntrySchema).max(200),
}).strict();

export type AnnotationReviewsSection = z.infer<typeof annotationReviewsSectionSchema>;

/**
 * 提交即授权（ADR-0034 §4）：agent 可读的注记范围 = 该题纸 `stage='submitted'`
 * 的草稿注记（按题纸作用域收口）；`draft`（未提交）与 `confirmed`（历史正式注记）
 * 均不开放。
 */
export const ANNOTATION_AGENT_READABLE_STAGES = ["submitted"] as const;

export function isAnnotationAgentReadable(stage: string): boolean {
  return (ANNOTATION_AGENT_READABLE_STAGES as readonly string[]).includes(stage);
}
