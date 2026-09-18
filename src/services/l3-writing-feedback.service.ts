/**
 * L3WritingFeedbackService — 作文反馈读写与 agent 边界（W5，ADR《writing-workspace》§5）。
 *
 * 唯一质量反馈源：一稿一条 latest-wins（无历史版本）；绑定精确稿（sheetId + textSha256，
 * UTF-16 锚点逐字校验）；不压 correct/partial/wrong。锁序 task→sheet（反馈首写由 sheet
 * 锁串行；重放/更新用反馈行锁）。`last_editor` 由调用方（HTTP Principal）注入——本服务
 * 不读请求体自述。
 *
 * GET（getContext/getFeedback）零写入；draft 409、非本人 404、正文已清理 409
 * （WRITING_CONTENT_CLEARED，不得当普通 pending）。
 */

import type { PoolClient } from "pg";
import {
  BusinessRuleError,
  ConflictError,
  InternalConsistencyError,
  NotFoundError,
  ValidationError,
} from "../errors";
import { withTransaction } from "../db/transaction";
import type {
  L3QuestionAttemptRow,
  WritingFeedbackContext,
  WritingFeedbackGetResult,
  WritingFeedbackRecord,
} from "../domain";
import type { L3WritingFeedbackRow } from "../repositories/l3-writing.types";
import {
  countEnglishWords,
  collectFeedbackAnchors,
  validateFeedbackAnchors,
  WRITING_FEEDBACK_BYTES_MAX,
  WRITING_FEEDBACK_SCHEMA_VERSION,
  type WritingFeedbackPutInput,
} from "../domain/l3-writing";
import { sha256WritingText } from "./l3-writing-text";
import { defaultWritingReposFactory, type WritingRepos } from "./l3-writing-task.service";
import {
  L3WritingFeedbackRepository,
  type IL3WritingFeedbackRepository,
} from "../repositories/l3-writing-feedback.repository";

type TxRunner = typeof withTransaction;

/** 反馈服务窄仓库集合（在 W2 窄工厂基础上加 l3Feedback）。 */
export interface WritingFeedbackRepos extends WritingRepos {
  l3Feedback: IL3WritingFeedbackRepository;
}

export type WritingFeedbackReposFactory = (tx?: PoolClient) => WritingFeedbackRepos;

/** 默认窄工厂：W2 工厂 + 反馈 repo（W6 后可改走全局 factory）。 */
export const defaultWritingFeedbackReposFactory: WritingFeedbackReposFactory = (tx) => {
  const base = defaultWritingReposFactory(tx);
  return { ...base, l3Feedback: new L3WritingFeedbackRepository(tx) };
};

/**
 * 规范化 JSON 序列化（键排序、递归）——幂等重放内容比较与字节计量用。
 * 不用 JSON.stringify 直比：jsonb 落库后键序不保证。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * 严格读取 attempt 正文（`{ text: string }`）——结构不合法即**数据一致性错误**
 * （不得以空串伪装合法稿正文；评阅上下文/绑定校验共用此收口）。
 */
function requireConsistentAttemptText(attempt: L3QuestionAttemptRow, sheetId: string): string {
  const answer = attempt.answer;
  const text = answer && typeof answer === "object" && !Array.isArray(answer)
    ? (answer as { text?: unknown }).text
    : undefined;
  if (typeof text !== "string") {
    throw new InternalConsistencyError(
      "writing attempt answer is missing a text field",
      undefined,
      { code: "WRITING_DATA_INCONSISTENT", sheetId, attemptId: attempt.id },
    );
  }
  return text;
}

/** 反馈记录映射（W9 导出复用；单一真源）。 */
export function toFeedbackRecord(row: L3WritingFeedbackRow): WritingFeedbackRecord {
  return {
    feedback: row.feedback as WritingFeedbackRecord["feedback"],
    version: row.version,
    textSha256: row.text_sha256,
    lastEditor: row.last_editor,
    updatedAt: row.updated_at,
  };
}

function conflict(message: string, details: Record<string, unknown>): ConflictError {
  return new ConflictError(message, undefined, details);
}

export class L3WritingFeedbackService {
  constructor(
    private readonly reposFactory: WritingFeedbackReposFactory = defaultWritingFeedbackReposFactory,
    private readonly txRunner: TxRunner = withTransaction,
  ) {}

  private withActor<T>(userId: string, callback: (repos: WritingFeedbackRepos) => Promise<T>): Promise<T> {
    return this.txRunner(async (tx) => callback(this.reposFactory(tx)), { actorId: userId });
  }

  /** 共享前置：归属校验（404）→ sealed（409）→ active attempt（cleared 409）。 */
  private async loadSealedSheetForRead(repos: WritingFeedbackRepos, userId: string, taskId: string, sheetId: string) {
    const task = await repos.l3Writing.findTaskById(userId, taskId);
    if (!task) throw new NotFoundError("WritingTask", taskId);
    const sheet = await repos.l3Writing.findSheetById(userId, taskId, sheetId);
    if (!sheet) throw new NotFoundError("WritingSheet", sheetId);
    if (sheet.status !== "sealed") {
      throw conflict("writing feedback requires a sealed sheet", { sheetId, status: sheet.status });
    }
    const attempt = await repos.l3Writing.findWritingAttempt(userId, sheetId);
    if (!attempt || attempt.status !== "active") {
      throw conflict("writing content is cleared", { code: "WRITING_CONTENT_CLEARED", sheetId });
    }
    return { task, sheet, attempt };
  }

  /** agent 评阅上下文（sealed + 未清理 + 精确稿；零写入；数据不一致即显式报错）。 */
  async getContext(userId: string, taskId: string, sheetId: string): Promise<WritingFeedbackContext> {
    return this.withActor(userId, async (repos) => {
      const { task, sheet, attempt } = await this.loadSealedSheetForRead(repos, userId, taskId, sheetId);
      // 一致性收口（W5 收口）：sealed 稿必须有合法稿号——不得用 revisionNo=0 伪造上下文。
      const revisionNo = sheet.revision_no;
      if (typeof revisionNo !== "number" || revisionNo <= 0) {
        throw new InternalConsistencyError(
          "sealed writing sheet is missing a valid revision number",
          undefined,
          { code: "WRITING_DATA_INCONSISTENT", sheetId, revisionNo: sheet.revision_no },
        );
      }
      // 题面引用式真源必须可解析——不得用空题面伪造有效评阅上下文。
      const question = await repos.l3Paper.findQuestionById(userId, task.question_id);
      if (!question) {
        throw new InternalConsistencyError(
          "writing task question record is missing",
          undefined,
          { code: "WRITING_DATA_INCONSISTENT", taskId, questionId: task.question_id },
        );
      }
      const feedback = await repos.l3Feedback.findBySheet(userId, sheetId);
      const text = requireConsistentAttemptText(attempt, sheetId);
      return {
        taskId: task.id,
        sheetId,
        revisionNo,
        kind: task.kind,
        direction: task.direction,
        prompt: question.stem,
        text,
        textSha256: sha256WritingText(text),
        wordCount: countEnglishWords(text),
        // 0 = 尚未有反馈（与首次提交 expectedVersion=0 一致）。
        feedbackVersion: feedback?.version ?? 0,
        feedbackSchemaVersion: WRITING_FEEDBACK_SCHEMA_VERSION,
      };
    });
  }

  /** 反馈读取（零写入）：无行 = pending（正常态；读取失败才是非 2xx）。 */
  async getFeedback(userId: string, taskId: string, sheetId: string): Promise<WritingFeedbackGetResult> {
    return this.withActor(userId, async (repos) => {
      await this.loadSealedSheetForRead(repos, userId, taskId, sheetId);
      const row = await repos.l3Feedback.findBySheet(userId, sheetId);
      if (!row) return { state: "pending", feedback: null };
      return { state: "ready", feedback: toFeedbackRecord(row) };
    });
  }

  /**
   * 反馈写入（owner/agent 共用；editor 由 Principal 注入）：
   * 锁 task→sheet → sealed/cleared 校验 → hash/锚点/字节校验 → 幂等重放判定 →
   * 版本 CAS 写入（expectedVersion=0 首次；version+1；latest-wins 无历史）。
   */
  async putFeedback(
    userId: string,
    taskId: string,
    sheetId: string,
    input: WritingFeedbackPutInput,
    editor: string,
  ): Promise<WritingFeedbackRecord> {
    return this.withActor(userId, async (repos) => {
      const task = await repos.l3Writing.lockTask(userId, taskId);
      if (!task) throw new NotFoundError("WritingTask", taskId);
      const sheet = await repos.l3Writing.lockSheet(userId, taskId, sheetId);
      if (!sheet) throw new NotFoundError("WritingSheet", sheetId);
      if (sheet.status !== "sealed") {
        throw conflict("writing feedback requires a sealed sheet", { sheetId, status: sheet.status });
      }
      const attempt = await repos.l3Writing.findWritingAttempt(userId, sheetId);
      if (!attempt || attempt.status !== "active") {
        throw conflict("writing content is cleared", { code: "WRITING_CONTENT_CLEARED", sheetId });
      }

      // ① 绑定校验：hash 指向 exact 稿正文（归一后同串；结构不合法先报一致性错误）。
      const text = requireConsistentAttemptText(attempt, sheetId);
      const actualHash = sha256WritingText(text);
      if (input.textSha256 !== actualHash) {
        throw new ValidationError("textSha256 does not match the revision text", "textSha256");
      }

      // ② 锚点逐字校验（UTF-16 offsets against exact text）。
      const badAnchors = validateFeedbackAnchors(text, collectFeedbackAnchors(input.feedback));
      if (badAnchors.length > 0) {
        throw new BusinessRuleError("feedback anchors do not match the revision text", undefined, {
          code: "FEEDBACK_ANCHOR_MISMATCH",
          invalidAnchors: badAnchors,
        });
      }

      // ③ 体积上限（validated feedback 总 JSON ≤ 64KiB）。
      const serialized = canonicalJson(input.feedback);
      if (Buffer.byteLength(serialized, "utf8") > WRITING_FEEDBACK_BYTES_MAX) {
        throw new ValidationError("feedback exceeds the 64KiB budget", "feedback");
      }

      // ④ 幂等/版本语义（反馈行锁）。
      const existing = await repos.l3Feedback.lockBySheet(userId, sheetId);
      if (existing) {
        if (existing.request_id === input.requestId) {
          const sameContent = existing.text_sha256 === input.textSha256
            && canonicalJson(existing.feedback) === serialized;
          if (sameContent) return toFeedbackRecord(existing); // 重放：200，不升 version
          throw conflict("same requestId with different feedback content", {
            code: "FEEDBACK_REQUEST_CONFLICT",
            requestId: input.requestId,
          });
        }
        if (existing.version !== input.expectedVersion) {
          throw conflict("feedback version conflict", {
            code: "FEEDBACK_VERSION_CONFLICT",
            expectedVersion: input.expectedVersion,
            actualVersion: existing.version,
          });
        }
        const updated = await repos.l3Feedback.updateCas({
          user_id: userId,
          sheet_id: sheetId,
          text_sha256: input.textSha256,
          feedback_jsonb: JSON.stringify(input.feedback),
          request_id: input.requestId,
          last_editor: editor,
          expected_version: input.expectedVersion,
        });
        if (!updated) throw conflict("feedback update did not apply", { sheetId });
        await repos.l3Writing.touchTask(userId, taskId);
        return toFeedbackRecord(updated);
      }

      // 首写：版本 0 表示首次。
      if (input.expectedVersion !== 0) {
        throw conflict("feedback version conflict (no feedback yet)", {
          code: "FEEDBACK_VERSION_CONFLICT",
          expectedVersion: input.expectedVersion,
          actualVersion: 0,
        });
      }
      const inserted = await repos.l3Feedback.insertFirst({
        user_id: userId,
        sheet_id: sheetId,
        text_sha256: input.textSha256,
        feedback_jsonb: JSON.stringify(input.feedback),
        request_id: input.requestId,
        last_editor: editor,
      });
      await repos.l3Writing.touchTask(userId, taskId);
      return toFeedbackRecord(inserted);
    });
  }
}
