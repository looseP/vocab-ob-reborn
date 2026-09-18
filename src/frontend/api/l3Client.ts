import { createL3FrontendClient, type L3FrontendClient } from "@/l3/frontend/contract";
import type {
  GeneratedL3ProposalDetailResponse,
  GeneratedL3ProposalListResponse,
  GeneratedL3RecommendationDetailResponse,
  GeneratedL3RecommendationListResponse,
} from "./l3ResponseTypes";
import { BrowserApiError, createBrowserResponseRequest } from "./browserRequest";
import { adaptCursorPage } from "./pagination";
import { apiFetch } from "./client";

const DEFAULT_API_BASE_URL = "";

type GeneratedL3ReadClient = {
  listProposals: (...args: Parameters<L3FrontendClient["listProposals"]>) => Promise<GeneratedL3ProposalListResponse>;
  getProposal: (...args: Parameters<L3FrontendClient["getProposal"]>) => Promise<GeneratedL3ProposalDetailResponse>;
  listRecommendations: (...args: Parameters<L3FrontendClient["listRecommendations"]>) => Promise<GeneratedL3RecommendationListResponse>;
  getRecommendation: (...args: Parameters<L3FrontendClient["getRecommendation"]>) => Promise<GeneratedL3RecommendationDetailResponse>;
};

export function createBrowserL3Client(baseUrl = DEFAULT_API_BASE_URL, fetchImpl: typeof fetch = fetch): L3FrontendClient {
  const request = createBrowserResponseRequest({ baseUrl, fetch: fetchImpl });
  const client = createL3FrontendClient({
    fetch: async (input, init) => {
      try {
        const response = await request<unknown>(input, init);
        return { ok: true, status: response.status, json: async () => response.data };
      } catch (error) {
        if (!(error instanceof BrowserApiError)) throw error;
        return { ok: false, status: error.status, json: async () => error.body };
      }
    },
  });
  const generatedReadClient = {
    listProposals: async params => adaptCursorPage(await client.listProposals(params)),
    getProposal: client.getProposal,
    listRecommendations: async params => adaptCursorPage(await client.listRecommendations(params)),
    getRecommendation: client.getRecommendation,
  } satisfies GeneratedL3ReadClient;

  return {
    ...client,
    ...generatedReadClient,
  };
}

// ── 批次一：做题注记（原文分析条目）与规律标签字典（纯 owner 做题面）──────────
// 不走 createL3FrontendClient（那是 agent/owner 共用的 MCP read contract）；
// 这组函数仅供卷面工作台经通用 apiFetch 调用，响应字段与后端 snake_case 契约对齐。

export type QuestionAnnotationOptionKey = "A" | "B" | "C" | "D";

export interface QuestionAnnotation {
  id: string;
  question_id: string;
  ordinal: number;
  anchor_start: number | null;
  anchor_end: number | null;
  excerpt: string | null;
  note: string;
  entry_tags: string[];
  option_tags: Partial<Record<QuestionAnnotationOptionKey, string[]>>;
  /** 批次二：stage 生命周期（draft=做题中草稿，挂题纸；随定格升 submitted）。 */
  stage: "draft" | "submitted" | "confirmed";
  sheet_id: string | null;
  review: unknown;
  /** F-1：review 来源题纸（最近一次评卷所属；前端对比标注「本轮/历史评卷」）。 */
  review_sheet_id: string | null;
  status: "active" | "deleted";
  created_at: string;
  updated_at: string;
}

export interface AnnotationTagDict {
  entry: string[];
  option: string[];
}

export interface CreateQuestionAnnotationRequest {
  questionId: string;
  anchorStart?: number | null;
  anchorEnd?: number | null;
  excerpt?: string | null;
  note?: string;
  entryTags?: string[];
  optionTags?: Partial<Record<QuestionAnnotationOptionKey, string[]>>;
  /** 批次二：挂到该题纸为草稿注记（缺省 = 正式注记）。 */
  sheetId?: string;
}

export type QuestionAnnotationPatchRequest = Partial<Omit<CreateQuestionAnnotationRequest, "questionId" | "sheetId">>;

const ANNOTATION_ID_BATCH_LIMIT = 200;

/** 卷面加载后按题 id 批量拉注记（服务端去重/上限 200）。 */
export async function fetchQuestionAnnotations(questionIds: readonly string[]): Promise<QuestionAnnotation[]> {
  const ids = [...new Set(questionIds)].slice(0, ANNOTATION_ID_BATCH_LIMIT);
  if (ids.length === 0) return [];
  const body = await apiFetch<{ items?: QuestionAnnotation[] } | null>(
    `/l3/question-annotations?questionIds=${ids.map(encodeURIComponent).join(",")}`,
  );
  // 防御：代理/旧后端/HTML 回退等异常形状不得让调用方崩溃（契约漂移只做空结果处理）。
  return Array.isArray(body?.items) ? body.items : [];
}

/** 新建条目；同题同锚点幂等命中时服务端返回既有行（200/201 对调用方等价）。 */
export async function createQuestionAnnotation(
  input: CreateQuestionAnnotationRequest,
): Promise<QuestionAnnotation> {
  const body = await apiFetch<{ item: QuestionAnnotation }>(
    "/l3/question-annotations",
    { method: "POST", body: JSON.stringify(input) },
  );
  return body.item;
}

export async function patchQuestionAnnotation(
  id: string,
  patch: QuestionAnnotationPatchRequest,
): Promise<QuestionAnnotation> {
  const body = await apiFetch<{ item: QuestionAnnotation }>(
    `/l3/question-annotations/${id}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return body.item;
}

export async function deleteQuestionAnnotation(id: string): Promise<void> {
  await apiFetch<null>(`/l3/question-annotations/${id}`, { method: "DELETE" });
}

/** 标签字典首次读取由服务端 lazy-seed 预置集。 */
export async function fetchAnnotationTags(): Promise<AnnotationTagDict> {
  const body = await apiFetch<Partial<AnnotationTagDict> | null>("/l3/annotation-tags");
  return {
    entry: Array.isArray(body?.entry) ? body.entry : [],
    option: Array.isArray(body?.option) ? body.option : [],
  };
}

/** 整存替换标签字典（服务端事务内软删旧行 + 插新行）。 */
export async function saveAnnotationTags(dict: AnnotationTagDict): Promise<AnnotationTagDict> {
  const body = await apiFetch<Partial<AnnotationTagDict> | null>("/l3/annotation-tags", {
    method: "PUT",
    body: JSON.stringify(dict),
  });
  return {
    entry: Array.isArray(body?.entry) ? body.entry : dict.entry,
    option: Array.isArray(body?.option) ? body.option : dict.option,
  };
}

// ── 批次二：题纸（会话信封）与作答历史（题级链）────────────────────────────
// 同注记组：仅供卷面工作台经通用 apiFetch 调用，字段与后端 snake_case 契约对齐；
// 所有 items/attempts 响应做 Array.isArray 归一防御（契约漂移只做空结果处理）。

export type SheetScopeValue = "file" | "paper";
export type SheetStatusValue = "draft" | "sealed" | "discarded";
export type SealModeValue = "full" | "incremental" | "summary";

export interface L3Sheet {
  id: string;
  user_id: string;
  scope: SheetScopeValue;
  scope_key: string;
  source_id: string | null;
  question_type: string | null;
  paper_id: string | null;
  status: SheetStatusValue;
  /** 仅 draft 期非空；定格后服务端清空（attempts 是唯一作答真源）。 */
  answers: Record<string, unknown>;
  seal_mode: SealModeValue | null;
  summary: string | null;
  sealed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface L3Attempt {
  id: string;
  user_id: string;
  question_id: string;
  sheet_id: string | null;
  venue: SheetScopeValue;
  /** deleted 行内容已被服务端遮蔽为 null（占位语义由前端渲染）。 */
  answer: unknown;
  self_assessment: unknown | null;
  status: "active" | "deleted";
  deleted_at: string | null;
  created_at: string;
}

export interface OpenSheetRequest {
  scope: SheetScopeValue;
  sourceId?: string;
  questionType?: string;
  paperId?: string;
}

export interface SealSheetRequest {
  mode: SealModeValue;
  summary?: string;
  acknowledgeUnanswered?: boolean;
}

export interface SealSheetResult {
  sheet: L3Sheet;
  unansweredCount: number;
  /** v2 §10：待复查题数（软确认提示数据源；不阻断；复核修订：recheck 随 flags 整段物化）。 */
  recheckCount: number;
  materializedCount: number;
  promotedAnnotationCount: number;
}

const ATTEMPT_ID_BATCH_LIMIT = 200;

/** 开纸（幂等：同作用域复用既有 draft 行；200/201 对调用方等价）。 */
export async function openSheet(input: OpenSheetRequest): Promise<L3Sheet> {
  const body = await apiFetch<{ sheet?: L3Sheet } | null>("/l3/sheets", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!body?.sheet) throw new Error("题纸打开失败：响应缺少题纸行");
  return body.sheet;
}

/** 题纸详情：draft 含 answers；settled 的逐题明细走 attempts（服务端已排序+遮蔽）。 */
export async function fetchSheet(id: string): Promise<{ sheet: L3Sheet; attempts: L3Attempt[] }> {
  const body = await apiFetch<{ sheet?: L3Sheet; attempts?: L3Attempt[] } | null>(
    `/l3/sheets/${encodeURIComponent(id)}`,
  );
  if (!body?.sheet) throw new Error("题纸详情加载失败：响应缺少题纸行");
  return { sheet: body.sheet, attempts: Array.isArray(body.attempts) ? body.attempts : [] };
}

/** 逐题 merge（null 清除）：非 draft 时服务端 409，由调用方捕获分流。 */
export async function patchSheet(id: string, answers: Record<string, unknown>): Promise<L3Sheet> {
  const body = await apiFetch<{ sheet?: L3Sheet } | null>(
    `/l3/sheets/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ answers }) },
  );
  if (!body?.sheet) throw new Error("题纸保存失败：响应缺少题纸行");
  return body.sheet;
}

/** 定格三档：未答 >0 且未确认时服务端 409（BrowserApiError.details.unansweredCount）。 */
export async function sealSheet(id: string, input: SealSheetRequest): Promise<SealSheetResult> {
  const body = await apiFetch<Partial<SealSheetResult> | null>(
    `/l3/sheets/${encodeURIComponent(id)}/seal`,
    { method: "POST", body: JSON.stringify(input) },
  );
  if (!body?.sheet) throw new Error("定格失败：响应缺少题纸行");
  return {
    sheet: body.sheet,
    unansweredCount: typeof body.unansweredCount === "number" ? body.unansweredCount : 0,
    recheckCount: typeof body.recheckCount === "number" ? body.recheckCount : 0,
    materializedCount: typeof body.materializedCount === "number" ? body.materializedCount : 0,
    promotedAnnotationCount: typeof body.promotedAnnotationCount === "number" ? body.promotedAnnotationCount : 0,
  };
}

// ── 批次二增补：评析区（agent 首个可写持久区，ADR-0034 v2 条 10/11）────────

export interface L3Assessment {
  id: string;
  user_id: string;
  question_id: string;
  content_md: string;
  last_editor: "owner" | "agent";
  created_at: string;
  updated_at: string;
}

/** 评析（无则 null 空态；题不存在服务端 404）。 */
export async function fetchQuestionAssessment(questionId: string): Promise<L3Assessment | null> {
  const body = await apiFetch<{ item?: L3Assessment | null } | null>(
    `/l3/questions/${encodeURIComponent(questionId)}/assessment`,
  );
  return body?.item ?? null;
}

/** upsert（latest-wins）：owner/agent 同一端点，last_editor 服务端按身份留痕。 */
export async function saveQuestionAssessment(questionId: string, contentMd: string): Promise<L3Assessment> {
  const body = await apiFetch<{ item?: L3Assessment } | null>(
    `/l3/questions/${encodeURIComponent(questionId)}/assessment`,
    { method: "PUT", body: JSON.stringify({ contentMd }) },
  );
  if (!body?.item) throw new Error("评析保存失败：响应缺少评析行");
  return body.item;
}

// ── 批次二增补：导出 v2（ADR-0034 v2 条 12）────────────────────────────────

/** 导出的 Markdown 全文（text/markdown 响应；parseJson:false 取原文）。 */
export async function fetchSheetExport(sheetId: string, withAnswers?: boolean): Promise<string> {
  const query = withAnswers == null ? "" : `?withAnswers=${withAnswers ? 1 : 0}`;
  return apiFetch<string>(`/l3/sheets/${encodeURIComponent(sheetId)}/export${query}`, { parseJson: false });
}

/** v2 §4.7 撤回：submitted→draft（重挂题纸）；sheetId 缺省时服务端借原纸作用域幂等开纸。 */
export async function withdrawQuestionAnnotation(id: string, sheetId?: string): Promise<QuestionAnnotation> {
  const body = await apiFetch<{ item?: QuestionAnnotation } | null>(
    `/l3/question-annotations/${encodeURIComponent(id)}/withdraw`,
    { method: "POST", body: JSON.stringify(sheetId ? { sheetId } : {}) },
  );
  if (!body?.item) throw new Error("撤回失败：响应缺少注记行");
  return body.item;
}

/** 批量题历史（题卡徽标数据源；服务端过滤已删条目）。 */
export async function fetchAttempts(questionIds: readonly string[]): Promise<L3Attempt[]> {
  const ids = [...new Set(questionIds)].slice(0, ATTEMPT_ID_BATCH_LIMIT);
  if (ids.length === 0) return [];
  const body = await apiFetch<{ items?: L3Attempt[] } | null>(
    `/l3/attempts?questionIds=${ids.map(encodeURIComponent).join(",")}`,
  );
  return Array.isArray(body?.items) ? body.items : [];
}

/** 软删单条历史（再删服务端 404）。 */
export async function deleteAttempt(id: string): Promise<void> {
  await apiFetch<null>(`/l3/attempts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ── 批次三①：评卷执行面（ADR-0035）────────────────────────────────────────
// 解析模式读面是 verdict/analysis 的**前端唯一数据通道**（owner-only，不含
// answerIndex）；grading-context（含答案）为 agent 专属面，前端永不消费（红线）。

export type GradingVerdictValue = "correct" | "partial" | "wrong";
export type AnnotationReviewVerdictValue = "sound" | "questionable" | "wrong";

/** 注记 review 列形状（0034 契约：snake_case；agent 检验产物，owner 侧只读展示）。 */
export interface AnnotationReview {
  verdict: AnnotationReviewVerdictValue;
  corrected_tags?: string[];
  comment?: string;
}

export interface L3GradingResult {
  id: string;
  user_id: string;
  sheet_id: string;
  question_id: string;
  verdict: GradingVerdictValue;
  analysis_md: string | null;
  graded_by: string;
  graded_at: string;
}

/** 解析模式读面：sealed 题纸的 verdict 行集合（无行 → 空数组，「待评卷」提示数据源）。 */
export async function fetchSheetGrading(sheetId: string): Promise<L3GradingResult[]> {
  const body = await apiFetch<{ results?: L3GradingResult[] } | null>(
    `/l3/sheets/${encodeURIComponent(sheetId)}/grading`,
  );
  // 防御（深测 OB-2）：契约漂移（200 + 非法形状）按**加载失败**处理（调用方以失败态
  // 呈现并提供重试），不得归一为空结果——否则「待评卷」提示会把数据异常误导为「还没有评卷」。
  if (body === null || !Array.isArray(body.results)) {
    throw new Error("评卷结果响应形状异常");
  }
  return body.results;
}

/** F-1：题纸档案行（回看闭环入口；仅索引元数据）。 */
export interface L3SheetArchiveItem {
  id: string;
  scope: SheetScopeValue;
  source_id: string | null;
  question_type: string | null;
  paper_id: string | null;
  status: SheetStatusValue;
  seal_mode: SealModeValue | null;
  sealed_at: string | null;
  created_at: string;
  /** 该题纸已评题数（「待评卷/已评 n 题」数据源；draft 恒 0）。 */
  graded_count: number;
  /** 展示标题：file 域取来源标题、paper 域取卷标题。 */
  venue_title: string | null;
}

/** F-1：题纸档案列表（新→旧；draft/sealed）。形状非法按加载失败抛错（同 OB-2 口径）。 */
export async function fetchSheetArchive(limit = 50): Promise<L3SheetArchiveItem[]> {
  const body = await apiFetch<{ items?: L3SheetArchiveItem[] } | null>(
    `/l3/sheets?limit=${encodeURIComponent(String(limit))}`,
  );
  if (body === null || !Array.isArray(body.items)) {
    throw new Error("题纸档案响应形状异常");
  }
  return body.items;
}

/** owner 处置（D18）：submitted+有 review 的注记确认；服务端 409 = 状态已变。 */
export async function confirmQuestionAnnotation(id: string): Promise<QuestionAnnotation> {
  const body = await apiFetch<{ item?: QuestionAnnotation } | null>(
    `/l3/annotations/${encodeURIComponent(id)}/confirm`,
    { method: "POST", body: JSON.stringify({}) },
  );
  if (!body?.item) throw new Error("确认失败：响应缺少注记行");
  return body.item;
}
