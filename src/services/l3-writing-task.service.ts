/**
 * L3WritingTaskService — 写作任务生命周期编排（W2，ADR《writing-workspace》§1/§2/§3/§4）。
 *
 * 边界：只编排 l3_writing_tasks 与（经 l3Paper）内部题 / （经本 repo）writing 首稿；
 * 不碰题面编辑/删除（引用式架构：改题意 = 新建任务；删除 blocker 由 paper service 收口）。
 * 写路径一律先锁 task（题路径再锁 question），在持锁事务内完成全部写入，不调用另开
 * 事务的 public service（W3/W5/W9 复用同一 service 与 repo 方法）。
 *
 * 依赖注入：构造函数收窄工厂 WritingReposFactory（默认 = 在事务内 new 真实 repo），
 * 不依赖 IRepositories.l3Writing 键（该键由 W6 集成后加）。定向测试注入假工厂即可。
 */

import type { PoolClient } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type { IL3ContextRepository, IL3PaperRepository } from "../repositories/interfaces";
import {
  L3WritingRepository,
  type IL3WritingRepository,
  type L3WritingTaskListInput,
} from "../repositories/l3-writing.repository";
import type { L3WritingTaskRow } from "../repositories/l3-writing.types";
import type { L3SubmissionRow } from "../domain";
import {
  WRITING_AUTO_TITLE_CODEPOINTS,
  normalizeWritingText,
  type WritingDirection,
  type WritingKind,
  type WritingPage,
  type WritingSheetDto,
  type WritingTaskCreateInput,
  type WritingTaskDetail,
  type WritingTaskDto,
  type WritingTaskRenameInput,
  type WritingTaskSummary,
  type CreateWritingTaskResult,
} from "../domain/l3-writing";
import { questionTypeSpace } from "../domain/l3-question-types";

/** 写作服务在事务内使用的窄仓库集合（不暴露给完整 IRepositories）。 */
export interface WritingRepos {
  l3Writing: IL3WritingRepository;
  l3Paper: IL3PaperRepository;
  l3Context?: IL3ContextRepository;
}

/** 窄工厂：默认在事务连接 tx 上构造真实 repo（含内部依赖 l3Paper/l3Context）。 */
export type WritingReposFactory = (tx?: PoolClient) => WritingRepos;

type TxRunner = typeof withTransaction;

const ESSAY_TYPES = new Set<string>(["short_essay", "long_essay"]);
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 50;

/**
 * 规范化创建输入 hash（S§3 D1）：固定字段序列
 *   kind, direction, questionId 或 normalizeLF(prompt), 初始 title, forceNew
 * 缺省值先按产品默认值填充，再 JSON 编码 + SHA256。不随可改的 title 变化——
 * 同 requestId 不同规范化输入即 409 的判定依据。
 */
function computeInputHash(input: WritingTaskCreateInput): string {
  const subject = input.questionId ?? normalizeWritingText(input.prompt ?? "");
  const canonical = JSON.stringify({
    kind: input.kind,
    direction: input.direction,
    subject,
    title: input.title ?? "",
    forceNew: Boolean(input.forceNew),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** 题面首 N 个 Unicode code point（注意用 code point 而非 UTF-16 unit 截断）。 */
function autoTitleFromStem(stem: string): string {
  return Array.from(stem).slice(0, WRITING_AUTO_TITLE_CODEPOINTS).join("");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: string }).code === "23505";
}

/** pg 唯一约束冲突且行已存在 → 重读既有行返回（并发重试整体回滚本多建的题）。 */
async function rereadOnConflict(
  repos: WritingRepos,
  userId: string,
  requestId: string,
): Promise<CreateWritingTaskResult | null> {
  const existing = await repos.l3Writing.findTaskByRequestId(userId, requestId);
  if (!existing) return null;
  const question = await repos.l3Paper.findQuestionById(userId, existing.question_id);
  const draft = await repos.l3Writing.findDraftByTask(userId, existing.id);
  return {
    task: toTaskDto(existing, question?.stem ?? ""),
    draft: draft ? toSheetDto(draft) : null,
    created: false,
  };
}

function toTaskDto(row: L3WritingTaskRow, prompt: string): WritingTaskDto {
  return {
    id: row.id,
    questionId: row.question_id,
    title: row.title,
    prompt,
    kind: row.kind,
    direction: row.direction,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** sheet DTO 映射（W3/W6 复用；单一真源）。 */
export function toSheetDto(row: L3SubmissionRow): WritingSheetDto {
  return {
    id: row.id,
    taskId: row.writing_task_id as string,
    status: row.status,
    draftVersion: row.draft_version,
    revisionNo: row.revision_no,
    parentSheetId: row.parent_sheet_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sealedAt: row.sealed_at,
  };
}

function clampLimit(limit: number | undefined): number {
  let value = typeof limit === "number" && Number.isInteger(limit) ? limit : LIST_DEFAULT_LIMIT;
  if (value < 1) value = LIST_DEFAULT_LIMIT;
  if (value > LIST_MAX_LIMIT) value = LIST_MAX_LIMIT;
  return value;
}

/** 列表 keyset 游标编解码（updated_at || id；容错：损坏 → null = 首页）。W3 listRevisions 复用。 */
export function encodeCursor(row: { updated_at: string; id: string }): string {
  return Buffer.from(`${row.updated_at}||${row.id}`).toString("base64url");
}
export function decodeCursor(cursor: string | null | undefined): { updatedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf("||");
    if (sep < 0) return null;
    const updatedAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 2);
    if (!updatedAt || !id) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

export class L3WritingTaskService {
  constructor(
    // 默认窄工厂（模块尾定义；默认参数在调用时求值，晚绑定安全）——
    // W6 集成可改用全局 factory，或继续用本默认。
    private readonly reposFactory: WritingReposFactory = defaultWritingReposFactory,
    private readonly txRunner: TxRunner = withTransaction,
  ) {}

  private withActor<T>(userId: string, callback: (repos: WritingRepos) => Promise<T>): Promise<T> {
    return this.txRunner(async (tx) => callback(this.reposFactory(tx)), { actorId: userId });
  }

  /**
   * 创建写作任务（S§6 POST /tasks）：
   * - 幂等：同 requestId 重放 → 返回同 task 与首 draft（created=false）；不同规范化输入 → 409。
   * - 直接开始（无 questionId/prompt）：同事务建内部 long_essay 题（file_key='writing:'+taskId）。
   * - 选题：题须当前 owner 且 short_essay/long_essay 且 active；forceNew=false 复用活跃同款任务。
   * - 并发唯一冲突整体回滚，重读既有行返回（不留孤立内部题）。
   */
  async create(userId: string, input: WritingTaskCreateInput): Promise<CreateWritingTaskResult> {
    const inputHash = computeInputHash(input);

    return this.withActor(userId, async (repos) => {
      // 1) 幂等：create_request_id 优先（唯一约束作用域）。
      const existing = await repos.l3Writing.findTaskByRequestId(userId, input.requestId);
      if (existing) {
        if (existing.create_input_hash !== inputHash) {
          throw new ConflictError(
            "Idempotency conflict: same requestId with different normalized input",
            undefined,
            { code: "IDEMPOTENCY_CONFLICT", requestId: input.requestId },
          );
        }
        const reread = await rereadOnConflict(repos, userId, input.requestId);
        if (!reread) throw new NotFoundError("WritingTask", existing.id);
        return reread;
      }

      // 2) 解析题面来源（外部 essay 题 or 内部新建题）。
      const taskId = randomUUID();
      let questionId: string;
      let stem: string;

      if (input.questionId) {
        const question = await repos.l3Paper.findQuestionById(userId, input.questionId);
        if (!question) throw new NotFoundError("L3Question", input.questionId);
        if (!ESSAY_TYPES.has(question.question_type)) {
          throw new ValidationError(
            "Only short_essay / long_essay questions can start a writing task",
            "questionId",
          );
        }
        if (question.status !== "active") {
          throw new ValidationError("Referenced question is not active", "questionId");
        }
        // owner + question 事务锁：串行化同题并发创建。
        await repos.l3Writing.lockQuestion(userId, input.questionId);
        // forceNew=false：复用同 question + kind + direction 的活跃任务。
        if (!input.forceNew) {
          const reuse = await repos.l3Writing.findActiveTaskByQuestion(
            userId, input.questionId, input.kind, input.direction,
          );
          if (reuse) {
            const q = await repos.l3Paper.findQuestionById(userId, reuse.question_id);
            const draft = await repos.l3Writing.findDraftByTask(userId, reuse.id);
            return {
              task: toTaskDto(reuse, q?.stem ?? ""),
              draft: draft ? toSheetDto(draft) : null,
              created: false,
            };
          }
        }
        questionId = input.questionId;
        stem = question.stem;
      } else {
        // 直接开始：同事务建内部题（题面引用式真源）。
        const normalized = input.prompt && input.prompt.trim()
          ? normalizeWritingText(input.prompt)
          : "自由写作";
        const created = await repos.l3Paper.insertQuestion({
          user_id: userId,
          source_id: null,
          file_key: `writing:${taskId}`,
          space: questionTypeSpace("long_essay"),
          question_type: "long_essay",
          ordinal: 0,
          stem: normalized,
          options: [],
          answer: {},
          explanation: null,
          evidence: [],
          status: "active",
          created_by: "owner",
          input_hash: null,
        });
        questionId = created.id;
        stem = created.stem;
      }

      // 3) 落任务 + 首个空 draft（同事务；并发唯一冲突整体回滚后重读）。
      const title = input.title?.trim() || autoTitleFromStem(stem);
      let taskRow: L3WritingTaskRow;
      try {
        taskRow = await repos.l3Writing.insertTask({
          id: taskId,
          user_id: userId,
          question_id: questionId,
          title,
          kind: input.kind as WritingKind,
          direction: input.direction as WritingDirection,
          status: "active",
          create_request_id: input.requestId,
          create_input_hash: inputHash,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          const reread = await rereadOnConflict(repos, userId, input.requestId);
          if (reread) return reread;
        }
        throw error;
      }

      const draft = await repos.l3Writing.insertDraft({
        user_id: userId,
        task_id: taskId,
        question_id: questionId,
      });

      return { task: toTaskDto(taskRow, stem), draft: toSheetDto(draft), created: true };
    });
  }

  /** 任务详情（S§6 GET /tasks/:id）：含 draft 摘要、提交稿计数与最新提交稿 id；GET 零写入。 */
  async get(userId: string, taskId: string): Promise<WritingTaskDetail> {
    return this.withActor(userId, async (repos) => {
      const task = await repos.l3Writing.findTaskById(userId, taskId);
      if (!task) throw new NotFoundError("WritingTask", taskId);
      const question = await repos.l3Paper.findQuestionById(userId, task.question_id);
      const draft = await repos.l3Writing.findDraftByTask(userId, taskId);
      const revisionCount = await repos.l3Writing.countSealedByTask(userId, taskId);
      const latest = await repos.l3Writing.findLatestSealedByTask(userId, taskId);
      return {
        task: toTaskDto(task, question?.stem ?? ""),
        draftSummary: draft ? toSheetDto(draft) : null,
        revisionCount,
        latestSubmittedSheetId: latest ? latest.id : null,
      };
    });
  }

  /**
   * 列表（S§6 GET /tasks）：keyset 分页 + 稳定排序（updatedAt DESC, id DESC）+
   * q 搜索标题/题面（% _ 转义，不变通配）+ 仅当前 owner；summary 无正文。
   */
  async list(
    userId: string,
    query: { q?: string | null; status?: WritingTaskDto["status"] | null; limit?: number; cursor?: string | null },
  ): Promise<WritingPage<WritingTaskSummary>> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    return this.withActor(userId, async (repos) => {
      const { items, total } = await repos.l3Writing.listTasks({
        userId,
        status: query.status ?? null,
        q: query.q ?? null,
        cursor,
        limit: limit + 1, // 多取一行判定 hasMore
      });

      const hasMore = items.length > limit;
      const pageItems = hasMore ? items.slice(0, limit) : items;

      const summaries: WritingTaskSummary[] = pageItems.map((row) => ({
        task: {
          id: row.id,
          questionId: row.question_id,
          title: row.title,
          kind: row.kind,
          direction: row.direction,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        draftSheetId: row.draft_sheet_id,
        lastSheetId: row.last_sheet_id,
        latestRevisionNo: row.latest_revision_no,
      }));

      const nextCursor = hasMore ? encodeCursor(pageItems[pageItems.length - 1]!) : null;
      return { items: summaries, total, nextCursor };
    });
  }

  /** 重命名（题面不开放编辑；仅标题）。刷新 updated_at。 */
  async rename(userId: string, taskId: string, input: WritingTaskRenameInput): Promise<WritingTaskDto> {
    return this.withActor(userId, async (repos) => {
      const updated = await repos.l3Writing.updateTaskTitle(userId, taskId, input.title);
      if (!updated) throw new NotFoundError("WritingTask", taskId);
      const question = await repos.l3Paper.findQuestionById(userId, updated.question_id);
      return toTaskDto(updated, question?.stem ?? "");
    });
  }

  /** 归档：有 draft → 409（先继续或显式丢弃）；归档不删稿、不自动建稿。 */
  async archive(userId: string, taskId: string): Promise<WritingTaskDto> {
    return this.withActor(userId, async (repos) => {
      const task = await repos.l3Writing.lockTask(userId, taskId);
      if (!task) throw new NotFoundError("WritingTask", taskId);
      const draft = await repos.l3Writing.findDraftByTask(userId, taskId);
      if (draft) {
        throw new ConflictError(
          "Cannot archive a writing task that still has an unsaved draft",
          undefined,
          { taskId, draftSheetId: draft.id },
        );
      }
      const updated = await repos.l3Writing.setTaskStatus(userId, taskId, "archived");
      if (!updated) throw new NotFoundError("WritingTask", taskId);
      const question = await repos.l3Paper.findQuestionById(userId, updated.question_id);
      return toTaskDto(updated, question?.stem ?? "");
    });
  }

  /** 恢复：active 化；不自动开纸（不创建行）。 */
  async restore(userId: string, taskId: string): Promise<WritingTaskDto> {
    return this.withActor(userId, async (repos) => {
      const task = await repos.l3Writing.lockTask(userId, taskId);
      if (!task) throw new NotFoundError("WritingTask", taskId);
      const updated = await repos.l3Writing.setTaskStatus(userId, taskId, "active");
      if (!updated) throw new NotFoundError("WritingTask", taskId);
      const question = await repos.l3Paper.findQuestionById(userId, updated.question_id);
      return toTaskDto(updated, question?.stem ?? "");
    });
  }
}

/** 默认窄工厂：在事务连接上构造真实 repo（W6 之后若 IRepositories 增加 l3Writing 键，可改为委托）。 */
export const defaultWritingReposFactory: WritingReposFactory = (tx) => {
  const repos = createRepositories(tx);
  return {
    l3Writing: new L3WritingRepository(tx),
    l3Paper: repos.l3Paper,
    l3Context: repos.l3Context,
  };
};
