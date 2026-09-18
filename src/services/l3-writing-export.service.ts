/**
 * L3WritingExportService — 作文单稿导出（W9，ADR《writing-workspace》§7；S§7）。
 *
 * 独立导出 schemaVersion=1（不冒充题纸 v2）：同一次只读事务生成 task 题面、
 * 精确稿次、正文、parent 引用、对应反馈、时间与 hash；**只导出指定稿**。
 * sealed 正文从该稿 active attempt 读取（软删/缺失 → 409 WRITING_CONTENT_CLEARED，
 * 含 quote 的反馈一并 409，不泄漏）；draft 读 answers 且产物携带实际 draftVersion；
 * discarded → 409。sha256 与题纸导出同规则：**双段渲染**——对不含内容校验行的
 * 全文求哈希，再渲染含校验行的终稿（可复算，不递归 hash 自身）。
 *
 * Markdown 反引号安全：正文/题面/JSON 块均以动态长度围栏（最长反引号串 + 1，≥3）
 * 包裹——围栏不可能被内容提前闭合；提取按行锚定（闭栏=行首同长反引号串）。
 */
import { createHash } from "node:crypto";
import { ConflictError, InternalConsistencyError, NotFoundError } from "../errors";
import { withTransaction } from "../db/transaction";
import { logger } from "../observability/logger";
import type {
  L3QuestionAttemptRow,
  L3SubmissionRow,
  WritingFeedbackRecord,
  WritingSheetDto,
} from "../domain";
import { toFeedbackRecord } from "./l3-writing-feedback.service";
import {
  defaultWritingReposFactory,
  toSheetDto,
  toTaskDto,
  type WritingRepos,
  type WritingReposFactory,
} from "./l3-writing-task.service";
import { sha256WritingText } from "./l3-writing-text";
import {
  L3WritingFeedbackRepository,
  type IL3WritingFeedbackRepository,
} from "../repositories/l3-writing-feedback.repository";

type TxRunner = typeof withTransaction;

export const L3_WRITING_EXPORT_SCHEMA_VERSION = 1;

const KIND_LABELS: Record<string, string> = {
  whole: "整篇写作",
  paragraph: "段落专项",
  free: "自由写作",
};

export interface L3WritingExportResult {
  markdown: string;
  filename: string;
  sha256: string;
  schemaVersion: number;
}

/** 导出 JSON 块结构（extractor 契约；字段名冻结）。 */
export interface L3WritingExportPayload {
  exportSchemaVersion: 1;
  kind: "writing_sheet";
  exportedAt: string;
  task: Record<string, unknown>;
  sheet: WritingSheetDto;
  text: string;
  textSha256: string;
  feedback: WritingFeedbackRecord | null;
}

/** 动态围栏：比正文最长反引号串长 1 且 ≥3（闭栏不可能被内容提前闭合）。 */
export function fenceFor(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function requireConsistentAttemptText(attempt: L3QuestionAttemptRow): string {
  const answer = attempt.answer;
  const text = answer && typeof answer === "object" && !Array.isArray(answer)
    ? (answer as { text?: unknown }).text
    : undefined;
  if (typeof text !== "string") {
    throw new InternalConsistencyError("writing attempt answer is missing a text field", undefined, {
      code: "WRITING_DATA_INCONSISTENT",
      sheetId: attempt.sheet_id,
      attemptId: attempt.id,
    });
  }
  return text;
}

function extractDraftText(answers: Record<string, unknown>, questionId: string): string {
  const entry = answers[questionId];
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const text = (entry as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

function conflict(message: string, details: Record<string, unknown>): ConflictError {
  return new ConflictError(message, undefined, details);
}

interface WritingExportRepos extends WritingRepos {
  l3Feedback: IL3WritingFeedbackRepository;
}

type WritingExportReposFactory = (tx?: Parameters<WritingReposFactory>[0]) => WritingExportRepos;

/** 局部窄工厂：W2 基础 + 反馈 repo（导出需读反馈；不引全局注册）。 */
const defaultWritingExportReposFactory: WritingExportReposFactory = (tx) => ({
  ...defaultWritingReposFactory(tx),
  l3Feedback: new L3WritingFeedbackRepository(tx),
});

interface RenderInput {
  payload: L3WritingExportPayload;
  taskTitle: string;
  kind: string;
  direction: string;
  revisionLabel: string;
  parentSheetId: string | null;
  feedbackLabel: string;
  text: string;
  prompt: string;
}

/** 双段渲染核心：contentSha256=null 时渲染去除校验行的全文（哈希面）。 */
function renderWritingExportMarkdownCore(input: RenderInput, contentSha256: string | null): string {
  const lines: string[] = [];
  lines.push("# L3 作文档案（v1）", "");
  lines.push(`- 任务: ${input.payload.task.id as string}`);
  lines.push(`- 标题: ${input.taskTitle}`);
  lines.push(`- 形式: ${input.kind} · 方向: ${input.direction}`);
  lines.push(`- 稿次: ${input.revisionLabel}`);
  lines.push(`- 状态: ${input.payload.sheet.status}`);
  lines.push(`- 父稿: ${input.parentSheetId ?? "（无）"}`);
  lines.push(`- 反馈: ${input.feedbackLabel}`);
  lines.push(`- 导出 schema 版本: ${L3_WRITING_EXPORT_SCHEMA_VERSION}`);
  lines.push(`- 导出时间: ${input.payload.exportedAt}`);
  lines.push(`- 正文 sha256: ${input.payload.textSha256}`);
  if (contentSha256) lines.push(`- 内容校验: sha256:${contentSha256}（删除本行后可复算）`);
  lines.push("");

  lines.push("## 题目", "");
  const promptFence = fenceFor(input.prompt);
  lines.push(promptFence, input.prompt, promptFence, "");

  lines.push("## 正文", "");
  const textFence = fenceFor(input.text);
  lines.push(textFence, input.text, textFence, "");

  lines.push("## 结构化数据（JSON）", "");
  const jsonText = JSON.stringify(input.payload, null, 2);
  const jsonFence = fenceFor(jsonText);
  lines.push(`${jsonFence}json`, jsonText, jsonFence, "");
  return lines.join("\n");
}

/** 纯函数（供单测）：双段渲染 → { markdown, sha256 }（sha256 可复算）。 */
export function renderWritingExportMarkdown(input: RenderInput): { markdown: string; sha256: string } {
  const withoutHash = renderWritingExportMarkdownCore(input, null);
  const sha256 = createHash("sha256").update(withoutHash, "utf8").digest("hex");
  return { markdown: renderWritingExportMarkdownCore(input, sha256), sha256 };
}

export class L3WritingExportService {
  constructor(
    private readonly reposFactory: WritingExportReposFactory = defaultWritingExportReposFactory,
    private readonly txRunner: TxRunner = withTransaction,
  ) {}

  private withActor<T>(userId: string, callback: (repos: WritingExportRepos) => Promise<T>): Promise<T> {
    return this.txRunner(async (tx) => callback(this.reposFactory(tx)), { actorId: userId });
  }

  /** 单稿导出（只读事务；含该稿反馈；不混其他稿）。 */
  async exportSheet(userId: string, taskId: string, sheetId: string): Promise<L3WritingExportResult> {
    return this.withActor(userId, async (repos) => {
      const task = await repos.l3Writing.findTaskById(userId, taskId);
      if (!task) throw new NotFoundError("WritingTask", taskId);
      const sheet = await repos.l3Writing.findSheetById(userId, taskId, sheetId);
      if (!sheet) throw new NotFoundError("WritingSheet", sheetId);
      const question = await repos.l3Paper.findQuestionById(userId, task.question_id);
      if (!question) {
        throw new InternalConsistencyError("writing task question record is missing", undefined, {
          code: "WRITING_DATA_INCONSISTENT",
          taskId,
          questionId: task.question_id,
        });
      }

      let text: string;
      let revisionLabel: string;
      if (sheet.status === "sealed") {
        const attempt = await repos.l3Writing.findWritingAttempt(userId, sheetId);
        if (!attempt || attempt.status !== "active") {
          throw conflict("writing content is cleared", { code: "WRITING_CONTENT_CLEARED", sheetId });
        }
        if (typeof sheet.revision_no !== "number" || sheet.revision_no <= 0) {
          throw new InternalConsistencyError("sealed writing sheet is missing a valid revision number", undefined, {
            code: "WRITING_DATA_INCONSISTENT",
            sheetId,
            revisionNo: sheet.revision_no,
          });
        }
        text = requireConsistentAttemptText(attempt);
        revisionLabel = `第 ${sheet.revision_no} 稿`;
      } else if (sheet.status === "draft") {
        text = extractDraftText(sheet.answers, task.question_id);
        revisionLabel = `草稿快照（导出时刻，draftVersion=${sheet.draft_version}）`;
      } else {
        throw conflict("discarded revisions have no exportable content", {
          code: "WRITING_CONTENT_CLEARED",
          sheetId,
          status: sheet.status,
        });
      }

      const feedbackRow = await repos.l3Feedback.findBySheet(userId, sheetId);
      const feedback = feedbackRow ? toFeedbackRecord(feedbackRow) : null;
      const textSha256 = sha256WritingText(text);
      const exportedAt = new Date().toISOString();
      const payload: L3WritingExportPayload = {
        exportSchemaVersion: L3_WRITING_EXPORT_SCHEMA_VERSION,
        kind: "writing_sheet",
        exportedAt,
        task: toTaskDto(task, question.stem) as unknown as Record<string, unknown>,
        sheet: toSheetDto(sheet),
        text,
        textSha256,
        feedback,
      };

      const { markdown, sha256 } = renderWritingExportMarkdown({
        payload,
        taskTitle: task.title,
        kind: KIND_LABELS[task.kind] ?? task.kind,
        direction: task.direction,
        revisionLabel,
        parentSheetId: sheet.parent_sheet_id,
        feedbackLabel: feedback ? `第 ${feedback.version} 版（${feedback.lastEditor}）` : "（尚无）",
        text,
        prompt: question.stem,
      });

      logger.info("l3-writing-export", "writing sheet export rendered", {
        taskId,
        sheetId,
        status: sheet.status,
        revisionNo: sheet.revision_no,
        hasFeedback: feedback != null,
        schemaVersion: L3_WRITING_EXPORT_SCHEMA_VERSION,
        sha256,
      });

      return {
        markdown,
        filename: `writing-${sheetId}.md`,
        sha256,
        schemaVersion: L3_WRITING_EXPORT_SCHEMA_VERSION,
      };
    });
  }
}
