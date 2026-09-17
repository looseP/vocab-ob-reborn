/**
 * L3SheetExportService — 题纸冻结导出（批次二，ADR-0034 §6；对齐 ADR-0025）。
 *
 * 只出不进：sealed/discarded 题纸导出 Markdown 冻结档案（文章 + 题面 + 作答
 * （attempts）+ 冻结注记（锚点 ==高亮==）+ 评审 + 统计），携带
 * exportSchemaVersion 与内容 sha256；无导入路径（避免第二真相源）。manifest
 * 留痕 = 结构化日志 + 响应头（单 owner 下不建审计表，ADR-0025 决策 4）。
 * 通道 owner-only；draft 题纸拒绝（不得导出未定格的草稿，409）。
 * 安全：不含标准答案/官方 evidence（导出物不是答案泄漏渠道）。
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { ConflictError, NotFoundError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type {
  IRepositories,
  IL3AnnotationRepository,
  IL3ContextRepository,
  IL3PaperRepository,
  IL3SheetRepository,
} from "../repositories/interfaces";
import type {
  L3QuestionAnnotationRow,
  L3QuestionAttemptRow,
  L3QuestionRow,
  L3SubmissionRow,
} from "../domain";
import { logger } from "../observability/logger";
import { resolveSheetScopedQuestions } from "./l3-sheet-scope";

/** 导出契约版本（ADR-0025 §1：一旦发布只做加法或升版本）。 */
export const L3_SHEET_EXPORT_SCHEMA_VERSION = 1;

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

const VENUE_LABELS: Record<string, string> = { file: "题型空间", paper: "整卷" };
const STATUS_LABELS: Record<string, string> = { sealed: "已定格", discarded: "已弃档" };
const SEAL_MODE_LABELS: Record<string, string> = { full: "完整记录", incremental: "增量条目", summary: "只留总结" };
const REVIEW_VERDICT_LABELS: Record<string, string> = { sound: "成立", questionable: "存疑", wrong: "有误" };

export interface L3SheetExportInput {
  sheet: L3SubmissionRow;
  questions: L3QuestionRow[];
  attempts: L3QuestionAttemptRow[];
  annotations: L3QuestionAnnotationRow[];
  articles: Array<{ title: string | null; content: string | null }>;
  exportedAt: string;
}

export interface L3SheetExportResult {
  markdown: string;
  filename: string;
  sha256: string;
  schemaVersion: number;
  stats: { attempts: number; cleared: number; annotations: number };
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function summarizeAnswer(answer: unknown): string {
  if (answer == null) return "内容已清理";
  if (typeof answer === "string") return truncate(answer, 80);
  if (typeof answer === "object" && !Array.isArray(answer)) {
    const record = answer as Record<string, unknown>;
    if (typeof record.choice === "string") return `选 ${record.choice}`;
    if (Array.isArray(record.choices) && record.choices.length > 0) return `多选 ${record.choices.join("")}`;
    if (typeof record.text === "string") return truncate(record.text, 80);
  }
  return "已作答";
}

function renderReview(review: unknown): string | null {
  if (!review || typeof review !== "object" || Array.isArray(review)) return null;
  const record = review as Record<string, unknown>;
  const verdict = typeof record.verdict === "string"
    ? (REVIEW_VERDICT_LABELS[record.verdict] ?? record.verdict)
    : null;
  if (!verdict) return null;
  const parts: string[] = [verdict];
  if (typeof record.comment === "string" && record.comment.trim()) parts.push(record.comment.trim());
  const corrected = Array.isArray(record.corrected_tags) && record.corrected_tags.length > 0
    ? `订正建议: ${(record.corrected_tags as unknown[]).map(String).join("、")}`
    : null;
  return `${parts.join(" — ")}${corrected ? `（${corrected}）` : ""}`;
}

/** Markdown 冻结档案渲染（纯函数，供单测；不含标准答案与 evidence）。 */
export function renderSheetExportMarkdown(input: L3SheetExportInput): string {
  const { sheet, questions, attempts, annotations, articles, exportedAt } = input;
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const lines: string[] = [];

  lines.push("# L3 题纸冻结档案", "");
  lines.push(`- 题纸: ${sheet.id}`);
  lines.push(`- 范围: ${VENUE_LABELS[sheet.scope] ?? sheet.scope}${sheet.question_type ? ` · ${sheet.question_type}` : ""}`);
  lines.push(`- 状态: ${STATUS_LABELS[sheet.status] ?? sheet.status}${sheet.seal_mode ? `（${SEAL_MODE_LABELS[sheet.seal_mode] ?? sheet.seal_mode}）` : ""}`);
  lines.push(`- 导出 schema 版本: ${L3_SHEET_EXPORT_SCHEMA_VERSION}`);
  lines.push(`- 导出时间: ${exportedAt}`, "");

  const cleared = attempts.filter((row) => row.status === "deleted").length;
  lines.push("## 统计", "");
  lines.push(`- 作答记录: ${attempts.length} 条${cleared > 0 ? `（含 ${cleared} 条已清理）` : ""}`);
  lines.push(`- 冻结注记: ${annotations.length} 条`);
  if (sheet.summary) lines.push(`- 本次总结: ${sheet.summary}`);
  lines.push("");

  lines.push("## 题面", "");
  if (questions.length === 0) lines.push("（作用域内无题）", "");
  questions.forEach((question, index) => {
    lines.push(`### ${index + 1}. ${truncate(question.stem, 160)}`);
    for (const option of question.options) lines.push(`- ${option.key}. ${truncate(option.text, 160)}`);
    lines.push("");
  });

  lines.push("## 作答记录", "");
  if (attempts.length === 0) lines.push("（无作答记录）", "");
  for (const row of attempts) {
    const question = questionById.get(row.question_id);
    lines.push(`- ${row.created_at} · ${VENUE_LABELS[row.venue] ?? row.venue} · ${summarizeAnswer(row.answer)}｜题: ${truncate(question?.stem ?? row.question_id, 60)}`);
  }
  lines.push("");

  lines.push("## 冻结注记（随题纸提交）", "");
  if (annotations.length === 0) lines.push("（无注记）", "");
  for (const annotation of annotations) {
    const question = questionById.get(annotation.question_id);
    lines.push(`### 题: ${truncate(question?.stem ?? annotation.question_id, 80)}`);
    if (annotation.excerpt && annotation.anchor_start != null && annotation.anchor_end != null) {
      lines.push(`- ==${annotation.excerpt}==（锚点 ${annotation.anchor_start}–${annotation.anchor_end}）`);
    }
    if (annotation.note) lines.push(`- 笔记: ${annotation.note}`);
    if (annotation.entry_tags.length > 0) lines.push(`- 题型标签: ${annotation.entry_tags.join("、")}`);
    const optionTags = Object.entries(annotation.option_tags)
      .filter(([, tags]) => tags.length > 0)
      .map(([key, tags]) => `${key}: ${tags.join("、")}`);
    if (optionTags.length > 0) lines.push(`- 选项标签: ${optionTags.join("；")}`);
    lines.push(`- 评审: ${renderReview(annotation.review) ?? "（待检验）"}`);
    lines.push("");
  }

  lines.push("## 文章", "");
  if (articles.length === 0) lines.push("（无引用材料）", "");
  for (const article of articles) {
    lines.push(`### ${article.title ?? "（未命名材料）"}`, "");
    lines.push(article.content ?? "（无正文）", "");
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export class L3SheetExportService {
  constructor(
    private readonly sheetRepo: IL3SheetRepository,
    private readonly paperRepo: IL3PaperRepository,
    private readonly annotationRepo: IL3AnnotationRepository,
    private readonly contextRepo: IL3ContextRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  private withActor<T>(userId: string, callback: (repos: IRepositories) => Promise<T>): Promise<T> {
    return this.txRunner(async (tx) => callback(this.repositoryFactory(tx)), { actorId: userId });
  }

  private async loadArticles(
    repos: IRepositories,
    userId: string,
    sheet: L3SubmissionRow,
  ): Promise<Array<{ title: string | null; content: string | null }>> {
    const articles: Array<{ title: string | null; content: string | null }> = [];
    if (sheet.scope === "file" && sheet.source_id) {
      const source = await repos.l3Context.findSourceById(userId, sheet.source_id);
      if (source) articles.push({ title: source.title, content: source.content_text ?? null });
      return articles;
    }
    if (sheet.scope === "paper" && sheet.paper_id) {
      const paper = await repos.l3Paper.findPaperById(userId, sheet.paper_id);
      if (!paper) return articles;
      const seen = new Set<string>();
      for (const section of paper.payload.sections) {
        if (!section.sourceId || seen.has(section.sourceId)) continue;
        seen.add(section.sourceId);
        const source = await repos.l3Context.findSourceById(userId, section.sourceId);
        if (source) articles.push({ title: source.title, content: source.content_text ?? null });
      }
    }
    return articles;
  }

  /** 导出冻结档案（sealed/discarded）；draft → 409；响应头携带版本与 sha256。 */
  async exportSheet(userId: string, sheetId: string): Promise<L3SheetExportResult> {
    return this.withActor(userId, async (repos) => {
      const sheet = await repos.l3Sheets.getSheet(userId, sheetId);
      if (!sheet) throw new NotFoundError("L3Sheet", sheetId);
      if (sheet.status === "draft") {
        throw new ConflictError(
          "L3 sheet is not settled; export requires a sealed or discarded sheet",
          undefined,
          { sheetId, status: sheet.status },
        );
      }

      const questions = await resolveSheetScopedQuestions(repos, userId, sheet);
      const attempts = await repos.l3Sheets.listBySheet(userId, sheetId);
      const annotations = await repos.l3Annotations.listAnnotationsBySheet(userId, sheetId);
      const articles = await this.loadArticles(repos, userId, sheet);

      const exportedAt = new Date().toISOString();
      const markdown = renderSheetExportMarkdown({ sheet, questions, attempts, annotations, articles, exportedAt });
      const sha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
      const stats = {
        attempts: attempts.length,
        cleared: attempts.filter((row) => row.status === "deleted").length,
        annotations: annotations.length,
      };

      // manifest 留痕（ADR-0025 决策 4）：结构化日志即记录（范围 + 时间 + sha256）。
      logger.info("l3-sheet-export", "sheet export rendered", {
        sheetId,
        scope: sheet.scope,
        status: sheet.status,
        attempts: stats.attempts,
        cleared: stats.cleared,
        annotations: stats.annotations,
        schemaVersion: L3_SHEET_EXPORT_SCHEMA_VERSION,
        sha256,
      });

      return {
        markdown,
        filename: `l3-sheet-${sheetId.slice(0, 8)}.md`,
        sha256,
        schemaVersion: L3_SHEET_EXPORT_SCHEMA_VERSION,
        stats,
      };
    });
  }
}
