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
}

export type QuestionAnnotationPatchRequest = Partial<Omit<CreateQuestionAnnotationRequest, "questionId">>;

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
