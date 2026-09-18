/**
 * 作文子空间浏览器客户端（W6，ADR《writing-workspace》§6）——W7+ 页面经此访问
 * /api/l3/writing（唯一 HTTP 面）。
 *
 * 纪律：
 * - 复用 `createBrowserResponseRequest`（认证/CSRF/超时/401 全局事件，不新建认证方式）；
 * - 每个响应经服务端契约 zod 运行时校验——**非法响应抛 BrowserApiError
 *   （code=INVALID_RESPONSE），绝不归一为「成功空列表」或「pending」**；
 * - 单稿导出端点属 W9（暂不在本客户端内，避免假成功接口）。
 */
import { z } from "zod";
import { BrowserApiError, createBrowserResponseRequest } from "./browserRequest";
import {
  l3WritingDraftCreateResponseSchema,
  l3WritingFeedbackContextResponseSchema,
  l3WritingFeedbackGetResponseSchema,
  l3WritingFeedbackPutResponseSchema,
  l3WritingRevisionListResponseSchema,
  l3WritingSaveResponseSchema,
  l3WritingSheetDetailResponseSchema,
  l3WritingSheetResponseSchema,
  l3WritingSubmitResponseSchema,
  l3WritingTaskCreateResponseSchema,
  l3WritingTaskDetailResponseSchema,
  l3WritingTaskListResponseSchema,
  l3WritingTaskResponseSchema,
} from "@/http/l3-writing-response-contract";
import type {
  CreateWritingTaskResult,
  WritingFeedbackContext,
  WritingFeedbackGetResult,
  WritingFeedbackRecord,
  WritingPage,
  WritingRevisionSummary,
  WritingSheetDetail,
  WritingSheetDto,
  WritingTaskDetail,
  WritingTaskDto,
  WritingTaskSummary,
} from "@/domain";
import type {
  WritingDraftCreateInput,
  WritingDraftInput,
  WritingFeedbackPutInput,
  WritingSubmitInput,
  WritingTaskCreateRequest,
  WritingTaskRenameInput,
} from "@/domain/l3-writing";

/** 列表 query（与 l3WritingTaskListQuerySchema 对齐）。 */
export interface WritingTaskListQuery {
  q?: string;
  status?: "active" | "archived";
  limit?: number;
  cursor?: string;
}

/** 稿次历史 query（与 l3WritingRevisionListQuerySchema 对齐）。 */
export interface WritingRevisionListQuery {
  limit?: number;
  cursor?: string;
}

/** 第二稿创建结果（复用同 parent 时 created=false）。 */
export interface WritingDraftCreateResult {
  sheet: WritingSheetDto;
  created: boolean;
}

/** CAS 保存回执（textSha256 = 归一正文的 hash）。 */
export interface WritingSaveResult {
  sheet: WritingSheetDto;
  textSha256: string;
}

/** 提交回执（重复 submit 幂等：同 sheet 同 attemptId）。 */
export interface WritingSubmitResult {
  sheet: WritingSheetDto;
  attemptId: string;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

interface CallOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export function createWritingClient(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
  const request = createBrowserResponseRequest({ baseUrl: options.baseUrl ?? "", fetch: options.fetch });

  async function call<T>(schema: z.ZodType<T>, path: string, init: CallOptions = {}): Promise<T> {
    const { data, status } = await request<unknown>(`/api/l3/writing${path}`, {
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new BrowserApiError(status, {
        code: "INVALID_RESPONSE",
        message: "作文接口响应与契约不符",
        details: parsed.error.flatten(),
      });
    }
    return parsed.data;
  }

  const enc = encodeURIComponent;

  return {
    // ── 任务 ────────────────────────────────────────────────────────────────
    createTask: (input: WritingTaskCreateRequest, signal?: AbortSignal): Promise<CreateWritingTaskResult> =>
      call(l3WritingTaskCreateResponseSchema, "/tasks", { method: "POST", body: input, signal }),

    listTasks: (query: WritingTaskListQuery = {}, signal?: AbortSignal): Promise<WritingPage<WritingTaskSummary>> =>
      call(
        l3WritingTaskListResponseSchema,
        `/tasks${buildQuery({ q: query.q, status: query.status, limit: query.limit, cursor: query.cursor })}`,
        { signal },
      ),

    getTask: (taskId: string, signal?: AbortSignal): Promise<WritingTaskDetail> =>
      call(l3WritingTaskDetailResponseSchema, `/tasks/${enc(taskId)}`, { signal }),

    renameTask: (taskId: string, input: WritingTaskRenameInput): Promise<WritingTaskDto> =>
      call(l3WritingTaskResponseSchema, `/tasks/${enc(taskId)}`, { method: "PATCH", body: input }),

    archiveTask: (taskId: string): Promise<WritingTaskDto> =>
      call(l3WritingTaskResponseSchema, `/tasks/${enc(taskId)}/archive`, { method: "POST" }),

    restoreTask: (taskId: string): Promise<WritingTaskDto> =>
      call(l3WritingTaskResponseSchema, `/tasks/${enc(taskId)}/restore`, { method: "POST" }),

    listRevisions: (
      taskId: string,
      query: WritingRevisionListQuery = {},
      signal?: AbortSignal,
    ): Promise<WritingPage<WritingRevisionSummary>> =>
      call(
        l3WritingRevisionListResponseSchema,
        `/tasks/${enc(taskId)}/revisions${buildQuery({ limit: query.limit, cursor: query.cursor })}`,
        { signal },
      ),

    // ── 稿件 ────────────────────────────────────────────────────────────────
    getSheet: (taskId: string, sheetId: string, signal?: AbortSignal): Promise<WritingSheetDetail> =>
      call(l3WritingSheetDetailResponseSchema, `/tasks/${enc(taskId)}/sheets/${enc(sheetId)}`, { signal }),

    createDraft: (taskId: string, input: WritingDraftCreateInput): Promise<WritingDraftCreateResult> =>
      call(l3WritingDraftCreateResponseSchema, `/tasks/${enc(taskId)}/drafts`, { method: "POST", body: input }),

    saveDraft: (taskId: string, sheetId: string, input: WritingDraftInput, signal?: AbortSignal): Promise<WritingSaveResult> =>
      call(l3WritingSaveResponseSchema, `/tasks/${enc(taskId)}/sheets/${enc(sheetId)}`, {
        method: "PATCH",
        body: input,
        signal,
      }),

    submitSheet: (taskId: string, sheetId: string, input: WritingSubmitInput): Promise<WritingSubmitResult> =>
      call(l3WritingSubmitResponseSchema, `/tasks/${enc(taskId)}/sheets/${enc(sheetId)}/submit`, {
        method: "POST",
        body: input,
      }),

    discardSheet: (taskId: string, sheetId: string, input: WritingSubmitInput): Promise<WritingSheetDto> =>
      call(l3WritingSheetResponseSchema, `/tasks/${enc(taskId)}/sheets/${enc(sheetId)}/discard`, {
        method: "POST",
        body: input,
      }),

    // ── 反馈 ────────────────────────────────────────────────────────────────
    getFeedback: (taskId: string, sheetId: string, signal?: AbortSignal): Promise<WritingFeedbackGetResult> =>
      call(l3WritingFeedbackGetResponseSchema, `/tasks/${enc(taskId)}/sheets/${enc(sheetId)}/feedback`, { signal }),

    getFeedbackContext: (taskId: string, sheetId: string, signal?: AbortSignal): Promise<WritingFeedbackContext> =>
      call(l3WritingFeedbackContextResponseSchema, `/tasks/${enc(taskId)}/sheets/${enc(sheetId)}/feedback-context`, {
        signal,
      }),

    putFeedback: (
      taskId: string,
      sheetId: string,
      input: WritingFeedbackPutInput,
    ): Promise<WritingFeedbackRecord> =>
      call(l3WritingFeedbackPutResponseSchema, `/tasks/${enc(taskId)}/sheets/${enc(sheetId)}/feedback`, {
        method: "PUT",
        body: input,
      }),

    // ── 导出与正文清理（W9 冻结接口；服务端由 W9 交付，本客户端先行冻结）─────
    /** 单稿导出原文（text/markdown；非空校验为最低契约线，空响应=INVALID_RESPONSE）。 */
    exportSheet: async (taskId: string, sheetId: string, signal?: AbortSignal): Promise<string> =>
      call(z.string().min(1), `/tasks/${enc(taskId)}/sheets/${enc(sheetId)}/export`, { signal }),

    /** 清理该稿正文（soft-delete attempt + 同事务删反馈；sealed 限定，幂等）。 */
    clearSheetContent: (taskId: string, sheetId: string): Promise<WritingSheetDto> =>
      call(l3WritingSheetResponseSchema, `/tasks/${enc(taskId)}/sheets/${enc(sheetId)}/content`, {
        method: "DELETE",
      }),
  };
}

export type WritingClient = ReturnType<typeof createWritingClient>;

/** 默认单例（复用全局 fetch 与同源 baseUrl；测试可注入 createWritingClient）。 */
export const writingClient = createWritingClient();
