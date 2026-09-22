/**
 * 作文子空间（writing workspace）domain 契约——W1 冻结件（ADR《writing-workspace》§3/§5，
 * 设计基线 S§5/§6）。纯常量 + zod + 纯函数：零 IO、零出向（hash 在 service/util 层，
 * domain 不引 node:crypto）。
 *
 * 真源纪律（本文件是唯一类型真源，其他任务禁止自建同名漂移类型）：
 *   - 草稿正文：`answers[questionId] = { text }`（20,000 UTF-16 code units 硬上限）；
 *   - 提交后正文：该 sheet 的 active attempt `answer.text`（本文件不含存储细节）；
 *   - 反馈：结构化 WritingFeedback（无 numeric score、无 correct/partial/wrong）。
 */
import { z } from "zod";

// ── 枚举 ────────────────────────────────────────────────────────────────

/** 任务形式（非题型 enum、非评分体系；从 short_essay/long_essay 进入时保留其题型）。 */
export const WRITING_KINDS = ["whole", "paragraph", "free"] as const;
export type WritingKind = (typeof WRITING_KINDS)[number];

/** 方向（与 paper direction 同枚举：通用/考研/雅思）。 */
export const WRITING_DIRECTIONS = ["通用", "考研", "雅思"] as const;
export type WritingDirection = (typeof WRITING_DIRECTIONS)[number];

/** 第二稿种子：copy=复制父稿正文；blank=从空白开始。 */
export const WRITING_SEEDS = ["blank", "copy"] as const;
export type WritingSeed = (typeof WRITING_SEEDS)[number];

export const WRITING_TASK_STATUSES = ["active", "archived"] as const;
export type WritingTaskStatus = (typeof WRITING_TASK_STATUSES)[number];

/** 正文可用性（attempt 软删后 = cleared：占位可见、反馈/context/export 不泄漏）。 */
export const WRITING_CONTENT_STATUSES = ["available", "cleared"] as const;
export type WritingContentStatus = (typeof WRITING_CONTENT_STATUSES)[number];

/** 稿次状态（与 SheetStatus 同构收窄——写作稿只有 draft/sealed/discarded 三态）。 */
export const WRITING_SHEET_STATUSES = ["draft", "sealed", "discarded"] as const;
export type WritingSheetStatus = (typeof WRITING_SHEET_STATUSES)[number];

// ── 上限（API 与前端一致；S§5）─────────────────────────────────────────

/** 正文硬上限（UTF-16 code units；只有它阻止写入——超字数建议不阻止保存/提交）。 */
export const WRITING_TEXT_MAX = 20_000;
/** 题面上限。 */
export const WRITING_PROMPT_MAX = 5_000;
/** 标题上限。 */
export const WRITING_TITLE_MAX = 120;
/** 反馈请求体/总 JSON 字节上限。 */
export const WRITING_FEEDBACK_BYTES_MAX = 64 * 1024;
/** 反馈 schema 版本（DB 列 + JSON 内嵌一致）。 */
export const WRITING_FEEDBACK_SCHEMA_VERSION = 1;
/** 直接开始自动标题：题面首 N 个 Unicode code point。 */
export const WRITING_AUTO_TITLE_CODEPOINTS = 24;

// ── 正文纯函数 ──────────────────────────────────────────────────────────

/**
 * 正文规范化（创建与保存统一入口）：CRLF/CR → LF；**不 trim、不 Unicode normalize**。
 * 返回的正文与 hash / 锚点偏移必须基于同一字符串（先归一、后 hash、后校验锚点）。
 */
export function normalizeWritingText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * 提交判据：正文非空才可提交（空白不算内容；与保存允许空稿互补）。
 * 纯函数单一真源——W3 service 与前端共用，禁另写 trim 判断。
 */
export function hasWritingContent(text: string): boolean {
  return text.trim().length > 0;
}

/** 英文词数估算（信息性，不用于服务端接受与否）：英文/数字串及内部撇号、连字符。 */
const ENGLISH_WORD_RE = /[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g;

/** 英文词数估算（S§6：中文不计英文词；另由前端显示字符数）。 */
export function countEnglishWords(text: string): number {
  const matches = text.match(ENGLISH_WORD_RE);
  return matches ? matches.length : 0;
}

// ── 反馈结构（S§5 逐字段，不改名）──────────────────────────────────────

export const WRITING_DIMENSIONS = ["task_response", "organization", "language", "expression"] as const;
export type WritingDimension = (typeof WRITING_DIMENSIONS)[number];

/** 锚点：offset 为 JS UTF-16 code unit（emoji/中文/换行均有测试）。 */
export const writingFeedbackAnchorSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  quote: z.string().min(1),
}).strict();
export type WritingFeedbackAnchor = z.infer<typeof writingFeedbackAnchorSchema>;

export const writingFeedbackPrioritySchema = z.object({
  /** 稿内唯一（superRefine 去重）。 */
  id: z.string().trim().min(1).max(40),
  dimension: z.enum(WRITING_DIMENSIONS),
  observation: z.string().trim().min(1).max(1000),
  /** 可执行修改建议。 */
  action: z.string().trim().min(1).max(1000),
  /** null = 全文建议（不伪造高亮）。 */
  anchor: writingFeedbackAnchorSchema.nullable(),
}).strict();
export type WritingFeedbackPriority = z.infer<typeof writingFeedbackPrioritySchema>;

const dimensionCommentSchema = z.object({
  applicable: z.boolean(),
  /** 1..1000；不适用也解释原因。 */
  comment: z.string().trim().min(1).max(1000),
}).strict();

/**
 * 作文反馈（作文任务的唯一质量反馈源；**无 numeric score、无 correct/partial/wrong、
 * 无自动替换正文**）。v1 不做 markdown 渲染（普通文本显示，防 HTML 注入）。
 */
export const writingFeedbackSchema = z.object({
  schemaVersion: z.literal(WRITING_FEEDBACK_SCHEMA_VERSION),
  summary: z.string().trim().min(1).max(1000),
  /** 0..3，每条 1..500。 */
  strengths: z.array(z.string().trim().min(1).max(500)).max(3),
  dimensions: z.object({
    task_response: dimensionCommentSchema,
    organization: dimensionCommentSchema,
    language: dimensionCommentSchema,
    expression: dimensionCommentSchema,
  }).strict(),
  /** 0..3；没有问题允许 0 项。 */
  priorities: z.array(writingFeedbackPrioritySchema).max(3),
}).strict().superRefine((v, ctx) => {
  const seen = new Set<string>();
  for (const priority of v.priorities) {
    if (seen.has(priority.id)) {
      ctx.addIssue({ code: "custom", message: "priorities id 稿内唯一（存在重复）" });
      break;
    }
    seen.add(priority.id);
  }
});
export type WritingFeedback = z.infer<typeof writingFeedbackSchema>;

/**
 * 反馈锚点逐字校验（对**归一后**的 exact 稿正文）：offset 按 UTF-16 计数，
 * `quote` 必须严格等于 `text.slice(start,end)`；越界/逆序/不匹配均拒。
 * 返回失败锚点列表（空 = 全部合法）——service 据此映射 422。
 */
export function validateFeedbackAnchors(
  text: string,
  anchors: readonly WritingFeedbackAnchor[],
): WritingFeedbackAnchor[] {
  const failures: WritingFeedbackAnchor[] = [];
  for (const anchor of anchors) {
    const ok = anchor.start >= 0
      && anchor.end > anchor.start
      && anchor.end <= text.length
      && text.slice(anchor.start, anchor.end) === anchor.quote;
    if (!ok) failures.push(anchor);
  }
  return failures;
}

/** 收集反馈中全部锚点（含优先级项的；validateFeedbackAnchors 的输入构造）。 */
export function collectFeedbackAnchors(feedback: WritingFeedback): WritingFeedbackAnchor[] {
  return feedback.priorities.flatMap((priority) => (priority.anchor ? [priority.anchor] : []));
}

// ── 请求输入 schema ────────────────────────────────────────────────────

/**
 * 专用文本保存契约（**不复用** strict sheetAnswerSchema——其无 text 字段）：
 * `PATCH draft { expectedVersion, text }`；空稿可保存；`text` 不做 trim（保留原样，
 * 服务端统一 normalizeWritingText）。
 */
export const writingDraftInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  text: z.string().max(WRITING_TEXT_MAX),
}).strict();
export type WritingDraftInput = z.infer<typeof writingDraftInputSchema>;

/** 提交输入：expectedVersion 必填（CAS）。 */
export const writingSubmitInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
}).strict();
export type WritingSubmitInput = z.infer<typeof writingSubmitInputSchema>;

/** 创建修改稿输入：parent=null 时 seed 必须 blank；parent 有值须 sealed 同 task（service 校验）。 */
export const writingDraftCreateInputSchema = z.object({
  parentSheetId: z.string().uuid().nullable(),
  seed: z.enum(WRITING_SEEDS),
}).strict().superRefine((v, ctx) => {
  if (v.parentSheetId === null && v.seed !== "blank") {
    ctx.addIssue({ code: "custom", message: "parent 为 null 时 seed 必须为 blank" });
  }
});
export type WritingDraftCreateInput = z.infer<typeof writingDraftCreateInputSchema>;

/**
 * 任务创建输入（S§6 POST /tasks）：requestId 严格 UUID；prompt 与 questionId 互斥；
 * kind/direction 必填（前端负责默认值）；纯直接开始（prompt/questionId 均缺省）合法
 * ——题面由服务端生成「自由写作」。幂等比较用服务端 create_input_hash，不用可改 title。
 */
export const writingTaskCreateInputSchema = z.object({
  requestId: z.string().uuid(),
  title: z.string().trim().min(1).max(WRITING_TITLE_MAX).optional(),
  kind: z.enum(WRITING_KINDS),
  direction: z.enum(WRITING_DIRECTIONS),
  prompt: z.string().max(WRITING_PROMPT_MAX).optional(),
  questionId: z.string().uuid().optional(),
  forceNew: z.boolean().optional().default(false),
}).strict().superRefine((v, ctx) => {
  const hasPrompt = typeof v.prompt === "string" && v.prompt.trim().length > 0;
  const hasQuestion = v.questionId != null;
  if (hasPrompt && hasQuestion) {
    ctx.addIssue({ code: "custom", message: "prompt 与 questionId 互斥" });
  }
});
export type WritingTaskCreateInput = z.infer<typeof writingTaskCreateInputSchema>;

/**
 * 创建输入的**入线侧**类型（HTTP body / 前端 client 用）：`forceNew` 等带 default
 * 的字段在入线时可选、解析后由服务端补默认（服务层用 WritingTaskCreateInput）。
 */
export type WritingTaskCreateRequest = z.input<typeof writingTaskCreateInputSchema>;

/** 任务重命名输入（非空 patch；题面不开放编辑）。 */
export const writingTaskRenameInputSchema = z.object({
  title: z.string().trim().min(1).max(WRITING_TITLE_MAX),
}).strict();
export type WritingTaskRenameInput = z.infer<typeof writingTaskRenameInputSchema>;

/** 反馈 PUT 输入（W5 使用；此处冻结形状）：版本0=首次；requestId 幂等键。 */
export const writingFeedbackPutInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  textSha256: z.string().regex(/^[0-9a-f]{64}$/),
  requestId: z.string().uuid(),
  feedback: writingFeedbackSchema,
}).strict();
export type WritingFeedbackPutInput = z.infer<typeof writingFeedbackPutInputSchema>;

// ── DTO（W2/W6/W7 单一导入真源；不给 DB row 形状）────────────────────────

export interface WritingTaskDto {
  id: string;
  questionId: string;
  title: string;
  prompt: string;
  kind: WritingKind;
  direction: WritingDirection;
  status: WritingTaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WritingSheetDto {
  id: string;
  taskId: string;
  status: WritingSheetStatus;
  draftVersion: number;
  revisionNo: number | null;
  parentSheetId: string | null;
  createdAt: string;
  updatedAt: string;
  sealedAt: string | null;
}

export interface WritingFeedbackRecord {
  feedback: WritingFeedback;
  version: number;
  textSha256: string;
  lastEditor: string;
  updatedAt: string;
}

export interface WritingSheetDetail {
  sheet: WritingSheetDto;
  text: string | null;
  textSha256: string | null;
  wordCount: number;
  contentStatus: WritingContentStatus;
  feedback: WritingFeedbackRecord | null;
}

/**
 * agent 评阅上下文（S§5，W5）：sealed 限定、**只含指定稿**——准确题面、方向/形式、
 * 稿次、正文/hash、当前反馈版本与 schema。不含题库答案、其他草稿、历史笔记、跨稿内容。
 *
 * 一致性纪律（W5 收口）：sealed 稿缺少合法稿号/题面记录/合法正文结构时，服务层报
 * 数据一致性错误（InternalConsistencyError）——不得用空题面或 revisionNo=0 伪造有效
 * 评阅上下文（context 的 revisionNo 恒 >0，feedbackVersion 恒有效：0=尚无反馈）。
 */
export interface WritingFeedbackContext {
  taskId: string;
  sheetId: string;
  revisionNo: number;
  kind: WritingKind;
  direction: WritingDirection;
  /** 准确题面（题面引用式真源：question.stem）。 */
  prompt: string;
  text: string;
  textSha256: string;
  wordCount: number;
  /** 当前反馈版本；**0 = 尚未有反馈**（与首次提交 expectedVersion=0 一致）。 */
  feedbackVersion: number;
  feedbackSchemaVersion: number;
}

/** 反馈读取结果（GET feedback）：pending=尚无反馈（正常态，不是错误）。 */
export interface WritingFeedbackGetResult {
  state: "pending" | "ready";
  feedback: WritingFeedbackRecord | null;
}

export interface WritingPage<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
}

export interface CreateWritingTaskResult {
  task: WritingTaskDto;
  /** 复用已提交且无草稿的任务时 draft=null（禁止偷偷新建；W2/W6/W7 不得另造恒有 draft 类型）。 */
  draft: WritingSheetDto | null;
  created: boolean;
}

export interface WritingTaskSummary {
  task: Omit<WritingTaskDto, "prompt">;
  draftSheetId: string | null;
  lastSheetId: string | null;
  latestRevisionNo: number | null;
}

export interface WritingRevisionSummary {
  sheet: WritingSheetDto;
  contentStatus: WritingContentStatus;
  feedbackState: "pending" | "ready" | "unavailable";
}

/** 反馈态（稿级派生；pending=尚未有反馈、ready=已有、unavailable=正文已清理）。 */
export type WritingFeedbackState = "pending" | "ready" | "unavailable";

/**
 * A2：原题入口的按题进度摘要（owner-only 批量读面；**只含状态，不含正文/反馈文本**）。
 * draft 与最新已提交稿分开表达；多匹配任务返回列表，不替客户端挑选。
 */
export interface WritingQuestionTaskSummary {
  taskId: string;
  taskStatus: WritingTaskStatus;
  /** 进行中草稿 sheet（无 → null）。 */
  draftSheetId: string | null;
  /** 最新已提交稿（无 → null）。 */
  latestSubmittedSheetId: string | null;
  latestRevisionNo: number | null;
  /** 已提交 + 已丢弃稿次总数（归档任务同样累计）。 */
  revisionCount: number;
  /** **最新已提交稿**的反馈态（无已提交稿 → null；清理后为 unavailable，不转显旧反馈）。 */
  feedbackState: WritingFeedbackState | null;
  /** **最新已提交稿**的正文可用性（无已提交稿 → null）。 */
  contentStatus: WritingContentStatus | null;
}

export interface WritingQuestionSummary {
  questionId: string;
  tasks: WritingQuestionTaskSummary[];
}

export interface WritingTaskDetail {
  task: WritingTaskDto;
  draftSummary: WritingSheetDto | null;
  revisionCount: number;
  latestSubmittedSheetId: string | null;
}
