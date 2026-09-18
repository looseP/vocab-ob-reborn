/**
 * L3WritingSheetService — 写作稿次生命周期（W3，ADR《writing-workspace》§2/§3/§4）。
 *
 * 边界：只碰 l3_submissions（writing 行）与 l3_question_attempts（venue='writing'）；
 * 任务锁经 l3Writing.lockTask（task→sheet 固定锁序）；正文真源=草稿期
 * answers[questionId].text、提交后该 sheet 的 attempt.answer.text——无第二份全文。
 *
 * 关键语义（S§4）：
 * - saveDraft：CAS（expectedVersion），冲突 409 DRAFT_VERSION_CONFLICT，绝不 last-wins；
 * - submit：单事务内 版本比较→非空校验→物化 attempt→清空 answers→sealed+稿号
 *   （task 行锁下 max+1），重复 submit 幂等返回同稿同 attempt；
 * - createDraft：同 parent 复用原 draft（不覆盖），不同 parent 409 ACTIVE_DRAFT_EXISTS；
 *   copy 只读父稿 active attempt；这是新稿初始内容，不是旧稿第二份真源；
 * - discard：仅 draft，清空 answers、不占稿号；
 * - GET（getSheet/listRevisions）零写入零创建。
 *
 * feedback 字段按 W1 DTO 保留但本服务恒填 null（docstring 见 getSheet）：反馈由
 * W5 反馈服务在 HTTP 组合层填充——本服务不读反馈表内容（listRevisions 仅只读派生
 * feedback_count 布尔态，不返回 feedback 本体）。
 */

import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import type {
  L3QuestionAttemptRow,
  L3SubmissionRow,
  WritingPage,
  WritingRevisionSummary,
  WritingSheetDetail,
  WritingSheetDto,
} from "../domain";
import type {
  WritingDraftCreateInput,
  WritingDraftInput,
  WritingSubmitInput,
} from "../domain/l3-writing";
import {
  countEnglishWords,
  hasWritingContent,
  normalizeWritingText,
} from "../domain/l3-writing";
import { sha256WritingText } from "./l3-writing-text";
import {
  decodeCursor,
  defaultWritingReposFactory,
  encodeCursor,
  toSheetDto,
  type WritingRepos,
  type WritingReposFactory,
} from "./l3-writing-task.service";
import {
  L3WritingFeedbackRepository,
  type IL3WritingFeedbackRepository,
} from "../repositories/l3-writing-feedback.repository";

type TxRunner = typeof withTransaction;

/** 清理（W9）需要反馈 repo：本地窄扩展，不改 W2 共享类型/工厂。 */
interface WritingSheetRepos extends WritingRepos {
  l3Feedback: IL3WritingFeedbackRepository;
}

type WritingSheetReposFactory = (tx?: Parameters<WritingReposFactory>[0]) => WritingSheetRepos;

const defaultWritingSheetReposFactory: WritingSheetReposFactory = (tx) => ({
  ...defaultWritingReposFactory(tx),
  l3Feedback: new L3WritingFeedbackRepository(tx),
});

const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 50;

function clampLimit(limit: number | undefined): number {
  let value = typeof limit === "number" && Number.isInteger(limit) ? limit : LIST_DEFAULT_LIMIT;
  if (value < 1) value = LIST_DEFAULT_LIMIT;
  if (value > LIST_MAX_LIMIT) value = LIST_MAX_LIMIT;
  return value;
}

/** 草稿正文读取：answers[questionId] = { text }；形状防御（缺键/脏值 → 空串）。 */
function extractDraftText(answers: Record<string, unknown>, questionId: string): string {
  const entry = answers[questionId];
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const text = (entry as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/** attempt 正文读取：answer = { text }；形状防御（缺键/脏值 → 空串）。 */
function extractAttemptText(attempt: L3QuestionAttemptRow | null): string {
  if (!attempt) return "";
  const answer = attempt.answer;
  if (answer && typeof answer === "object" && !Array.isArray(answer)) {
    const text = (answer as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

function conflict(message: string, details: Record<string, unknown>): ConflictError {
  return new ConflictError(message, undefined, details);
}

export class L3WritingSheetService {
  constructor(
    private readonly reposFactory: WritingSheetReposFactory = defaultWritingSheetReposFactory,
    private readonly txRunner: TxRunner = withTransaction,
  ) {}

  private withActor<T>(userId: string, callback: (repos: WritingSheetRepos) => Promise<T>): Promise<T> {
    return this.txRunner(async (tx) => callback(this.reposFactory(tx)), { actorId: userId });
  }

  /**
   * 稿详情（GET 零写入）：draft=answers 正文；sealed=active attempt 正文
   * （软删/缺失 → cleared 占位：text/hash null、wordCount 0）；discarded=cleared。
   * `feedback` 恒 null——反馈由 W5 反馈服务在 HTTP 组合层填充（本服务不读反馈表）。
   */
  async getSheet(userId: string, taskId: string, sheetId: string): Promise<WritingSheetDetail> {
    return this.withActor(userId, async (repos) => {
      const task = await repos.l3Writing.findTaskById(userId, taskId);
      if (!task) throw new NotFoundError("WritingTask", taskId);
      const sheet = await repos.l3Writing.findSheetById(userId, taskId, sheetId);
      if (!sheet) throw new NotFoundError("WritingSheet", sheetId);
      return this.buildDetail(repos, task.question_id, sheet);
    });
  }

  private async buildDetail(
    repos: WritingRepos,
    questionId: string,
    sheet: L3SubmissionRow,
  ): Promise<WritingSheetDetail> {
    if (sheet.status === "draft") {
      const text = extractDraftText(sheet.answers, questionId);
      return {
        sheet: toSheetDto(sheet),
        text,
        textSha256: sha256WritingText(text),
        wordCount: countEnglishWords(text),
        contentStatus: "available",
        feedback: null,
      };
    }
    if (sheet.status === "sealed") {
      const attempt = await repos.l3Writing.findWritingAttempt(sheet.user_id, sheet.id);
      if (attempt && attempt.status === "active") {
        const text = extractAttemptText(attempt);
        return {
          sheet: toSheetDto(sheet),
          text,
          textSha256: sha256WritingText(text),
          wordCount: countEnglishWords(text),
          contentStatus: "available",
          feedback: null,
        };
      }
      // 正文已清理（attempt 软删/缺失）：占位语义，不 404、不复活。
      return {
        sheet: toSheetDto(sheet),
        text: null,
        textSha256: null,
        wordCount: 0,
        contentStatus: "cleared",
        feedback: null,
      };
    }
    // discarded：从未有正文真源。
    return {
      sheet: toSheetDto(sheet),
      text: null,
      textSha256: null,
      wordCount: 0,
      contentStatus: "cleared",
      feedback: null,
    };
  }

  /**
   * CAS 保存（S§4）：归一文本（CRLF/CR→LF，不 trim）→ 锁 task → 锁 sheet →
   * 版本比较 → 写全量 text + version+1。失败绝不覆盖。
   */
  async saveDraft(
    userId: string,
    taskId: string,
    sheetId: string,
    input: WritingDraftInput,
  ): Promise<{ sheet: WritingSheetDto; textSha256: string }> {
    const normalized = normalizeWritingText(input.text);
    const textSha256 = sha256WritingText(normalized);
    return this.withActor(userId, async (repos) => {
      const task = await repos.l3Writing.lockTask(userId, taskId);
      if (!task) throw new NotFoundError("WritingTask", taskId);
      const sheet = await repos.l3Writing.lockSheet(userId, taskId, sheetId);
      if (!sheet) throw new NotFoundError("WritingSheet", sheetId);
      if (sheet.status !== "draft") {
        throw conflict("writing sheet is not editable", {
          sheetId,
          status: sheet.status,
        });
      }
      if (sheet.draft_version !== input.expectedVersion) {
        throw conflict("draft version conflict", {
          code: "DRAFT_VERSION_CONFLICT",
          expectedVersion: input.expectedVersion,
          actualVersion: sheet.draft_version,
        });
      }
      const answers = { [task.question_id]: { text: normalized } };
      const updated = await repos.l3Writing.casSaveDraft(
        userId,
        taskId,
        sheetId,
        input.expectedVersion,
        JSON.stringify(answers),
      );
      if (!updated) {
        // 持锁下不应发生；保守区分（不静默成功）。
        const reread = await repos.l3Writing.findSheetById(userId, taskId, sheetId);
        if (!reread) throw new NotFoundError("WritingSheet", sheetId);
        throw conflict("draft save did not apply", {
          code: reread.draft_version !== input.expectedVersion ? "DRAFT_VERSION_CONFLICT" : undefined,
          expectedVersion: input.expectedVersion,
          actualVersion: reread.draft_version,
          status: reread.status,
        });
      }
      await repos.l3Writing.touchTask(userId, taskId);
      return { sheet: toSheetDto(updated), textSha256 };
    });
  }

  /**
   * 提交（S§4 单事务）：task 锁 → sheet 锁 → 版本/非空 → 物化 attempt → 清空
   * answers → sealed + 稿号（max+1）。重复 submit（已 sealed）幂等返回同稿同 attempt。
   */
  async submit(
    userId: string,
    taskId: string,
    sheetId: string,
    input: WritingSubmitInput,
  ): Promise<{ sheet: WritingSheetDto; attemptId: string }> {
    return this.withActor(userId, async (repos) => {
      const task = await repos.l3Writing.lockTask(userId, taskId);
      if (!task) throw new NotFoundError("WritingTask", taskId);
      if (task.status !== "active") {
        throw conflict("writing task is archived", { taskId, taskStatus: task.status });
      }
      const sheet = await repos.l3Writing.lockSheet(userId, taskId, sheetId);
      if (!sheet) throw new NotFoundError("WritingSheet", sheetId);

      // 重放：已 sealed → 同一稿同一 attempt（无新 attempt、无新稿号）。
      if (sheet.status === "sealed") {
        const existing = await repos.l3Writing.findWritingAttempt(userId, sheetId);
        if (!existing) {
          throw conflict("sealed sheet has no attempt row", { sheetId });
        }
        return { sheet: toSheetDto(sheet), attemptId: existing.id };
      }
      if (sheet.status !== "draft") {
        throw conflict("writing sheet is discarded", { sheetId, status: sheet.status });
      }
      if (sheet.draft_version !== input.expectedVersion) {
        throw conflict("draft version conflict", {
          code: "DRAFT_VERSION_CONFLICT",
          expectedVersion: input.expectedVersion,
          actualVersion: sheet.draft_version,
        });
      }
      const text = extractDraftText(sheet.answers, task.question_id);
      if (!hasWritingContent(text)) {
        throw new ValidationError("writing text is empty; cannot submit", "text");
      }

      const revisionNo = (await repos.l3Writing.findMaxRevisionNo(userId, taskId)) + 1;
      const attempt = await repos.l3Writing.insertWritingAttempt({
        user_id: userId,
        question_id: task.question_id,
        sheet_id: sheetId,
        answerJsonb: JSON.stringify({ text }),
      });
      const sealed = await repos.l3Writing.sealWritingSheet(
        userId,
        taskId,
        sheetId,
        input.expectedVersion,
        revisionNo,
      );
      if (!sealed) {
        // 持锁下不应发生；并发已由 task→sheet 锁串行化。
        const reread = await repos.l3Writing.findSheetById(userId, taskId, sheetId);
        if (reread?.status === "sealed") {
          const existing = await repos.l3Writing.findWritingAttempt(userId, sheetId);
          if (existing) return { sheet: toSheetDto(reread), attemptId: existing.id };
        }
        throw conflict("submit did not apply", { sheetId });
      }
      await repos.l3Writing.touchTask(userId, taskId);
      return { sheet: toSheetDto(sealed), attemptId: attempt.id };
    });
  }

  /**
   * 创建修改稿（S§4）：task 锁下——同 parent 复用原 draft（created=false，不覆盖
   * 其正文）；不同 parent 409 ACTIVE_DRAFT_EXISTS（不自动 discard）；parent 须
   * sealed 且 active attempt（正文已清理 → 409）；copy 只读父稿 attempt。
   */
  async createDraft(
    userId: string,
    taskId: string,
    input: WritingDraftCreateInput,
  ): Promise<{ sheet: WritingSheetDto; created: boolean }> {
    return this.withActor(userId, async (repos) => {
      const task = await repos.l3Writing.lockTask(userId, taskId);
      if (!task) throw new NotFoundError("WritingTask", taskId);
      if (task.status !== "active") {
        throw conflict("writing task is archived", { taskId, taskStatus: task.status });
      }

      let parent: L3SubmissionRow | null = null;
      let parentAttempt: L3QuestionAttemptRow | null = null;
      if (input.parentSheetId) {
        parent = await repos.l3Writing.findSealedSheetById(userId, taskId, input.parentSheetId);
        if (!parent) throw new NotFoundError("WritingSheet", input.parentSheetId);
        parentAttempt = await repos.l3Writing.findWritingAttempt(userId, parent.id);
        if (!parentAttempt || parentAttempt.status !== "active") {
          throw conflict("parent revision content is cleared; cannot copy", {
            parentSheetId: parent.id,
          });
        }
      }

      const existing = await repos.l3Writing.findDraftByTask(userId, taskId);
      if (existing) {
        if (existing.parent_sheet_id === (input.parentSheetId ?? null)) {
          return { sheet: toSheetDto(existing), created: false };
        }
        throw conflict("an active draft with a different parent already exists", {
          code: "ACTIVE_DRAFT_EXISTS",
          draftSheetId: existing.id,
          draftParentSheetId: existing.parent_sheet_id,
          requestedParentSheetId: input.parentSheetId,
        });
      }

      let answers: Record<string, unknown> = {};
      if (input.seed === "copy") {
        // schema 保证 copy 时 parent 非空（writingDraftCreateInputSchema）。
        const text = extractAttemptText(parentAttempt);
        answers = { [task.question_id]: { text } };
      }
      const created = await repos.l3Writing.createWritingDraft({
        user_id: userId,
        task_id: taskId,
        question_id: task.question_id,
        parent_sheet_id: input.parentSheetId ?? null,
        answers,
      });
      await repos.l3Writing.touchTask(userId, taskId);
      return { sheet: toSheetDto(created), created: true };
    });
  }

  /** 丢弃草稿（仅 draft；清空 answers；不占稿号、无 attempt）。 */
  async discard(
    userId: string,
    taskId: string,
    sheetId: string,
    input: WritingSubmitInput,
  ): Promise<WritingSheetDto> {
    return this.withActor(userId, async (repos) => {
      const task = await repos.l3Writing.lockTask(userId, taskId);
      if (!task) throw new NotFoundError("WritingTask", taskId);
      const sheet = await repos.l3Writing.lockSheet(userId, taskId, sheetId);
      if (!sheet) throw new NotFoundError("WritingSheet", sheetId);
      if (sheet.status !== "draft") {
        throw conflict("only a draft can be discarded", { sheetId, status: sheet.status });
      }
      if (sheet.draft_version !== input.expectedVersion) {
        throw conflict("draft version conflict", {
          code: "DRAFT_VERSION_CONFLICT",
          expectedVersion: input.expectedVersion,
          actualVersion: sheet.draft_version,
        });
      }
      const discarded = await repos.l3Writing.discardWritingDraft(
        userId,
        taskId,
        sheetId,
        input.expectedVersion,
      );
      if (!discarded) {
        throw conflict("discard did not apply", { sheetId });
      }
      await repos.l3Writing.touchTask(userId, taskId);
      return toSheetDto(discarded);
    });
  }

  /** 稿次历史（sealed/discarded；keyset 分页；feedbackState 仅只读布尔派生）。 */
  async listRevisions(
    userId: string,
    taskId: string,
    query: { limit?: number; cursor?: string | null },
  ): Promise<WritingPage<WritingRevisionSummary>> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    return this.withActor(userId, async (repos) => {
      const task = await repos.l3Writing.findTaskById(userId, taskId);
      if (!task) throw new NotFoundError("WritingTask", taskId);
      const { items, total } = await repos.l3Writing.listRevisions(userId, taskId, {
        limit: limit + 1,
        cursor,
      });
      const hasMore = items.length > limit;
      const pageItems = hasMore ? items.slice(0, limit) : items;
      const summaries: WritingRevisionSummary[] = pageItems.map((row) => {
        const contentStatus: "available" | "cleared" =
          row.status === "sealed" && row.active_attempt_count > 0 ? "available" : "cleared";
        const feedbackState: "pending" | "ready" | "unavailable" =
          contentStatus === "cleared" ? "unavailable" : row.feedback_count > 0 ? "ready" : "pending";
        return { sheet: toSheetDto(row), contentStatus, feedbackState };
      });
      const nextCursor = hasMore ? encodeCursor(pageItems[pageItems.length - 1]!) : null;
      return { items: summaries, total, nextCursor };
    });
  }

  /**
   * 正文清理（W9，S§3 D2/§7）：soft-delete 该稿 active writing attempt，并**同事务**
   * 删除该稿反馈（防止已删正文的反馈摘录残留）。固定锁序 task→sheet；仅 sealed 可
   * 清理（draft 走 discard、discarded 已是终态）；**幂等**（重复调用仍确保反馈已删）。
   */
  async clearRevisionContent(userId: string, taskId: string, sheetId: string): Promise<WritingSheetDto> {
    return this.withActor(userId, async (repos) => {
      const task = await repos.l3Writing.lockTask(userId, taskId);
      if (!task) throw new NotFoundError("WritingTask", taskId);
      const sheet = await repos.l3Writing.lockSheet(userId, taskId, sheetId);
      if (!sheet) throw new NotFoundError("WritingSheet", sheetId);
      if (sheet.status !== "sealed") {
        throw conflict("only a sealed revision can be cleared", { sheetId, status: sheet.status });
      }
      // 幂等：attempt 可能已删（false 无需报错），但反馈必须随之清除（同事务）。
      await repos.l3Writing.softDeleteWritingAttempt(userId, sheetId);
      await repos.l3Feedback.deleteBySheet(userId, sheetId);
      await repos.l3Writing.touchTask(userId, taskId);
      const reread = await repos.l3Writing.findSheetById(userId, taskId, sheetId);
      if (!reread) throw new NotFoundError("WritingSheet", sheetId);
      return toSheetDto(reread);
    });
  }
}
