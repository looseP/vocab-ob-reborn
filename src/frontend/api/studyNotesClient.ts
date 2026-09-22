/**
 * 学习笔记（N1）浏览器客户端（Task 07）——12 操作；学习笔记子空间的唯一 HTTP 面。
 *
 * 纪律（与 `writingClient.ts` 同构）：
 * - 复用 `createBrowserResponseRequest`（认证/CSRF/超时/401 全局事件，不另造网络栈）；
 * - 每个响应经服务端契约 zod 运行时校验——非法 200 抛 `BrowserApiError`
 *   （`code=INVALID_RESPONSE`），**绝不归一为「空笔记 / 空列表」**；
 * - 12 操作逐一对照**实际路由**（`src/http/routes/l3/study-*.ts`）与
 *   `response-contract`（2026-09-20 核对，含两处对旧任务书的校准）：
 *   ① `reference-preview` 请求体为 `ReferenceTarget` 本体（无 `{target}` 包装）；
 *   ② 列表布尔 query 为 `"1"`/`"0"`（非 `true`/`false`）；
 * - Task 10：新增**第 13 个**操作 `exportNote`（`GET /:noteId/export`，`parseJson:false`），
 *   仅导出已保存内容；仍**不提供**任何未实现端点的客户端函数（无 stub、无假成功）；
 * - 写操作不自动重试（写重试由保存控制器唯一负责）。
 */
import { z } from "zod";
import { BrowserApiError, createBrowserResponseRequest } from "./browserRequest";
import {
  l3ReferenceTargetListResponseSchema,
  l3ReferenceTargetPreviewResponseSchema,
  l3StudyBacklinkListResponseSchema,
  l3StudyNoteCreateResponseSchema,
  l3StudyNoteItemResponseSchema,
  l3StudyNoteListResponseSchema,
  l3StudyTopicCreateResponseSchema,
  l3StudyTopicItemResponseSchema,
  l3StudyTopicListResponseSchema,
} from "@/http/l3-study-note-response-contract";
import {
  createStudyNoteSchema,
  createStudyTopicSchema,
  moveStudyTopicMemberSchema,
  removeStudyTopicMemberSchema,
  saveStudyTopicSchema,
  type ReferenceTarget,
  type ReferenceTargetPreview,
  type SaveNoteInput,
  type StudyBacklinkItem,
  type StudyNoteDto,
  type StudyNoteStatus,
  type StudyNoteSummary,
  type StudyPage,
  type StudyQuestionTargetItem,
  type StudySourceTargetItem,
  type StudyTopicDto,
  type StudyTopicStatus,
} from "@/domain/l3-study-notes";
import type { L3QuestionType } from "@/domain/l3-question-types";

const NOTES_BASE = "/api/l3/study-notes";
const TOPICS_BASE = "/api/l3/study-topics";

// ── 入参类型（源自 domain schema；类型与契约同步漂移由 z.infer 防死）────────

export type StudyNoteCreateInput = z.infer<typeof createStudyNoteSchema>;
export type StudyTopicCreateInput = z.infer<typeof createStudyTopicSchema>;
export type StudyTopicSaveInput = z.infer<typeof saveStudyTopicSchema>;
export type StudyTopicMemberMoveInput = z.infer<typeof moveStudyTopicMemberSchema>;
export type StudyTopicMemberRemoveInput = z.infer<typeof removeStudyTopicMemberSchema>;

// ── query 类型（与 schemas/http 的 query schema 对齐）────────────────────────

/** 笔记列表 query（`l3StudyNoteListQuerySchema`）。topicId 与 unfiled 互斥（服务端 400）。 */
export interface StudyNoteListQuery {
  venue: L3QuestionType;
  q?: string;
  status?: StudyNoteStatus;
  /** 三态：true → `pinned=1`；false → `pinned=0`；undefined → 不发送（不过滤）。 */
  pinned?: boolean;
  topicId?: string;
  /** true → `unfiled=1`；false → `unfiled=0`；undefined → 不发送。 */
  unfiled?: boolean;
  /** 1–50；省略则服务端默认 20。 */
  limit?: number;
  /** 不透明游标；原样透传（不解析、不重建）。换筛选必须清空。 */
  cursor?: string;
}

/** 目标搜索 query（`l3StudyReferenceTargetQuerySchema`；每次只查一个 kind）。 */
export interface ReferenceTargetSearchQuery {
  kind: "source" | "question";
  q?: string;
  venue?: L3QuestionType;
  limit?: number;
  cursor?: string;
}

/** 反向引用 query（`l3StudyBacklinkQuerySchema`）。 */
export interface StudyBacklinkQuery {
  targetKind: "source" | "question";
  targetId: string;
  limit?: number;
  cursor?: string;
}

/** 专题列表 query（`l3StudyTopicListQuerySchema`）。 */
export interface StudyTopicListQuery {
  venue: L3QuestionType;
  status?: StudyTopicStatus;
  limit?: number;
  cursor?: string;
}

// ── 简单结果类型（与 response-contract 同构）────────────────────────────────

/** 创建回执：`created=false` 表示同 requestId 同输入幂等复用（200）。 */
export interface StudyNoteCreateResult {
  item: StudyNoteDto;
  created: boolean;
}

export interface StudyNoteItemResult {
  item: StudyNoteDto;
}

export interface StudyTopicCreateResult {
  item: StudyTopicDto;
  created: boolean;
}

export interface StudyTopicItemResult {
  item: StudyTopicDto;
}

export type StudyTargetItem = StudySourceTargetItem | StudyQuestionTargetItem;

// ── 导出结果（Task 10）──────────────────────────────────────────────────────

/**
 * 学习笔记导出（`GET /api/l3/study-notes/:noteId/export`）的客户端结果。
 *
 * - `markdown`：响应正文原文（`parseJson:false`，**不做任何解析/归一**；空正文按非法响应拒绝）；
 * - `filename`：**服务端** `Content-Disposition` 提供的安全文件名（缺头/含路径分隔符 →
 *   非法响应；客户端**不**自造文件名，见 `parseExportFilename`）；
 * - `sha256` / `schemaVersion`：来自 `X-Export-Sha256` / `X-Export-Schema-Version`
 *   响应头（用于与正文「内容校验」行互证；客户端不重算、不假设同名文件）。
 */
export interface StudyNoteExportResult {
  markdown: string;
  filename: string;
  sha256: string | null;
  schemaVersion: number | null;
}

/** 服务端安全文件名形状：`study-note-<uuid>.md`（不含路径分隔符、不含引号）。 */
const EXPORT_FILENAME_PATTERN = /^study-note-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/i;

/**
 * `Content-Disposition` → 服务端文件名。任何不符合冻结形状（含路径分隔符、缺引号、
 * 非法 uuid）的值一律视为非法响应——**绝不用客户端自造名兜底**（那会掩盖服务端合同破损）。
 */
function parseExportFilename(header: string | null): string | null {
  if (!header) return null;
  const match = /\bfilename="([^"]+)"/i.exec(header);
  const filename = match?.[1];
  if (!filename || !EXPORT_FILENAME_PATTERN.test(filename)) return null;
  return filename;
}

// ── query 序列化 ────────────────────────────────────────────────────────────

/**
 * query 序列化：undefined/空串不发送；布尔 → `"1"`/`"0"`（实际合同
 * `enum("0","1")`）；其余 String()；cursor 原样透传（URLSearchParams 负责
 * 传输编码，不解析、不重建游标内容）。
 */
function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    if (typeof value === "boolean") {
      search.set(key, value ? "1" : "0");
      continue;
    }
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

interface CallOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

// ── client 工厂 ─────────────────────────────────────────────────────────────

export function createStudyNotesClient(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
  const request = createBrowserResponseRequest({ baseUrl: options.baseUrl ?? "", fetch: options.fetch });

  async function call<T>(schema: z.ZodType<T>, path: string, init: CallOptions = {}): Promise<T> {
    const { data, status } = await request<unknown>(path, {
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new BrowserApiError(status, {
        code: "INVALID_RESPONSE",
        message: "学习笔记接口响应与契约不符",
        details: parsed.error.flatten(),
      });
    }
    return parsed.data;
  }

  /**
   * 非法 200（HTTP 2xx 但正文/响应头不符合冻结合同）——与 `call` 的契约校验同一条纪律：
   * **绝不归一为「空文档 / 客户端自造文件名」**，让调用方据此拒绝下载。
   */
  function invalidResponse(status: number, message: string, details?: unknown): BrowserApiError {
    return new BrowserApiError(status, { code: "INVALID_RESPONSE", message, details });
  }
  const enc = encodeURIComponent;
  const notes = (suffix: string): string => `${NOTES_BASE}${suffix}`;
  const topics = (suffix: string): string => `${TOPICS_BASE}${suffix}`;

  return {
    // ── 笔记（4）───────────────────────────────────────────────────────────

    /** POST /api/l3/study-notes（201 新建 / 200 幂等复用；幂等键=requestId）。 */
    create: (input: StudyNoteCreateInput, signal?: AbortSignal): Promise<StudyNoteCreateResult> =>
      call(l3StudyNoteCreateResponseSchema, notes(""), { method: "POST", body: input, signal }),

    /** GET /api/l3/study-notes（keyset 分页；summary 不含正文/引用；nextCursor 原样保留）。 */
    list: (query: StudyNoteListQuery, signal?: AbortSignal): Promise<StudyPage<StudyNoteSummary>> =>
      call(
        l3StudyNoteListResponseSchema,
        notes(
          buildQuery({
            venue: query.venue,
            q: query.q,
            status: query.status,
            pinned: query.pinned,
            topicId: query.topicId,
            unfiled: query.unfiled,
            limit: query.limit,
            cursor: query.cursor,
          }),
        ),
        { signal },
      ),

    /** GET /api/l3/study-notes/:noteId（单快照详情；GET 零写入）。 */
    get: (noteId: string, signal?: AbortSignal): Promise<StudyNoteItemResult> =>
      call(l3StudyNoteItemResponseSchema, notes(`/${enc(noteId)}`), { signal }),

    /**
     * PUT /api/l3/study-notes/:noteId（完整状态保存；CAS + 最后一次请求幂等）。
     * 控制器冻结 payload 后经此发送；本方法不自行重试。
     */
    save: (noteId: string, input: SaveNoteInput, signal?: AbortSignal): Promise<StudyNoteItemResult> =>
      call(l3StudyNoteItemResponseSchema, notes(`/${enc(noteId)}`), { method: "PUT", body: input, signal }),

    /**
     * GET /api/l3/study-notes/:noteId/export?expectedVersion=N（Task 10）——
     * 导出**已保存**内容（只出不进；归档笔记同样可导出）。
     *
     * 纪律：
     * - `expectedVersion` 是**调用方 flush 成功后的回执版本**（本方法不猜、不省略）；
     *   服务端据此核对，不一致返回 409（不回传正文）——版本不合就**没有可下载的旧文**；
     * - `parseJson:false`：Markdown 原文，不用 JSON.parse 破坏正文；
     * - 空正文 / 缺 `Content-Disposition` / 文件名非冻结形状 → `INVALID_RESPONSE`：
     *   宁可失败也不下载来路不明的文件；
     * - 不重试、不静默降级（导出是只读 GET，但「旧版本导出成功」比失败更危险）。
     */
    exportNote: async (noteId: string, expectedVersion: number, signal?: AbortSignal): Promise<StudyNoteExportResult> => {
      const response = await request<unknown>(
        notes(`/${enc(noteId)}/export${buildQuery({ expectedVersion })}`),
        { parseJson: false, signal },
      );
      const markdown = response.data;
      if (typeof markdown !== "string" || markdown.length === 0) {
        throw invalidResponse(response.status, "导出响应正文为空或非文本");
      }
      const filename = parseExportFilename(response.headers.get("Content-Disposition"));
      if (!filename) {
        throw invalidResponse(response.status, "导出响应缺少合法的 Content-Disposition 文件名");
      }
      const sha256 = response.headers.get("X-Export-Sha256");
      const schemaVersion = Number(response.headers.get("X-Export-Schema-Version"));
      return {
        markdown,
        filename,
        sha256: sha256 && sha256.trim() ? sha256 : null,
        schemaVersion: Number.isInteger(schemaVersion) ? schemaVersion : null,
      };
    },

    // ── 引用（3）───────────────────────────────────────────────────────────

    /** GET /api/l3/study-notes/reference-targets（每次只查一个 kind；摘要不含答案）。 */
    searchTargets: (query: ReferenceTargetSearchQuery, signal?: AbortSignal): Promise<StudyPage<StudyTargetItem>> =>
      call(
        l3ReferenceTargetListResponseSchema,
        notes(
          `/reference-targets${buildQuery({
            kind: query.kind,
            q: query.q,
            venue: query.venue,
            limit: query.limit,
            cursor: query.cursor,
          })}`,
        ),
        { signal },
      ),

    /**
     * POST /api/l3/study-notes/reference-preview（只读，不持久化）。
     * 请求体 = `ReferenceTarget` **本体**（无 `{target}` 包装；实际路由直接 parse union）。
     */
    preview: (target: ReferenceTarget, signal?: AbortSignal): Promise<ReferenceTargetPreview> =>
      call(l3ReferenceTargetPreviewResponseSchema, notes("/reference-preview"), {
        method: "POST",
        body: target,
        signal,
      }).then((result) => result.preview),

    /** GET /api/l3/study-notes/backlinks（按 note 去重聚合；默认不含归档）。 */
    backlinks: (query: StudyBacklinkQuery, signal?: AbortSignal): Promise<StudyPage<StudyBacklinkItem>> =>
      call(
        l3StudyBacklinkListResponseSchema,
        notes(
          `/backlinks${buildQuery({
            targetKind: query.targetKind,
            targetId: query.targetId,
            limit: query.limit,
            cursor: query.cursor,
          })}`,
        ),
        { signal },
      ),

    // ── 专题（5；Task 08 页面的底层方法，本批不建专题 UI）─────────────────

    /** POST /api/l3/study-topics（201/200；幂等键=requestId）。 */
    createTopic: (input: StudyTopicCreateInput, signal?: AbortSignal): Promise<StudyTopicCreateResult> =>
      call(l3StudyTopicCreateResponseSchema, topics(""), { method: "POST", body: input, signal }),

    /** GET /api/l3/study-topics（venue 必填）。 */
    listTopics: (query: StudyTopicListQuery, signal?: AbortSignal): Promise<StudyPage<StudyTopicDto>> =>
      call(
        l3StudyTopicListResponseSchema,
        topics(
          buildQuery({
            venue: query.venue,
            status: query.status,
            limit: query.limit,
            cursor: query.cursor,
          }),
        ),
        { signal },
      ),

    /** PUT /api/l3/study-topics/:topicId（元数据 + 归档共享版本）。 */
    saveTopic: (topicId: string, input: StudyTopicSaveInput, signal?: AbortSignal): Promise<StudyTopicItemResult> =>
      call(l3StudyTopicItemResponseSchema, topics(`/${enc(topicId)}`), { method: "PUT", body: input, signal }),

    /** PUT /api/l3/study-topics/:topicId/members/:noteId（加入或移动）。 */
    moveTopicMember: (
      topicId: string,
      noteId: string,
      input: StudyTopicMemberMoveInput,
      signal?: AbortSignal,
    ): Promise<StudyTopicItemResult> =>
      call(l3StudyTopicItemResponseSchema, topics(`/${enc(topicId)}/members/${enc(noteId)}`), {
        method: "PUT",
        body: input,
        signal,
      }),

    /** DELETE /api/l3/study-topics/:topicId/members/:noteId（JSON body；移出不删笔记）。 */
    removeTopicMember: (
      topicId: string,
      noteId: string,
      input: StudyTopicMemberRemoveInput,
      signal?: AbortSignal,
    ): Promise<StudyTopicItemResult> =>
      call(l3StudyTopicItemResponseSchema, topics(`/${enc(topicId)}/members/${enc(noteId)}`), {
        method: "DELETE",
        body: input,
        signal,
      }),
  };
}

export type StudyNotesClient = ReturnType<typeof createStudyNotesClient>;

/** 默认单例（复用全局 fetch 与同源 baseUrl；测试可注入 createStudyNotesClient）。 */
export const studyNotesClient = createStudyNotesClient();
