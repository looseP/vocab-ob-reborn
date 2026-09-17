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
 * 未答题计数（paper 交卷软确认数据源）：缺少键或显式 null（清除）均计未答。
 * 纯函数，计数由调用侧与作用域题集（file=题组；paper=payload sections）对齐。
 */
export function countUnansweredQuestions(
  questionIds: readonly string[],
  answers: Readonly<Record<string, unknown>>,
): number {
  return questionIds.filter((id) => answers[id] == null).length;
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

/**
 * PATCH 逐题 merge：`answers: Record<questionId, answer|null>`，null 清除该题。
 * 值为题型无关 JSON（V2-T5「存储与交互解耦」）；至少 1 键、最多 200 键。
 */
export const sheetPatchInputSchema = z.object({
  answers: z.record(z.string().uuid(), z.json()),
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
