/**
 * L3SheetExportService — 题纸导出 v2（批次二增补，ADR-0034 v2 条 12 / 设计卡 §6 v2）。
 *
 * 三状态分流：
 *   - draft   = 快照语义：answers 实时读（withAnswers 默认关——防自我剧透，
 *               也避免把半成品答案带给外部解读）；页眉标注「草稿快照 + 导出时刻」；
 *   - sealed  = 冻结档案语义：attempts 派生（withAnswers 默认开）；
 *   - discarded = 409（其产物是注记本身，不属题纸导出）。
 * 单工件双读者：Markdown 外壳（人读 / agent 直读）+ 尾部 ```json 全量结构化块
 * （备份保真 / agent 解析）；exportSchemaVersion=2。只出不进红线不变（无导入）。
 *
 * sha256 语义（v2，可复算）：对「不含内容校验行」的全文计算——校验方删除
 * 「- 内容校验:」开头的行后重算，应与页眉/响应头一致。
 *
 * 痕迹可见性契约（v2 §4.6 工作流：导出 → agent 解读痕迹）：
 *   - 原文段高亮（marks ==…== + 注记锚点 [n]）恒渲染——痕迹是 agent 解读素材；
 *   - 「作答与痕迹」段（choice/flags/marks 计数/自评）随 withAnswers——choice 属
 *     剧透面；json 块的 attempts/answers 同理。
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
  L3QuestionAssessmentRow,
  L3QuestionAttemptRow,
  L3QuestionRow,
  L3SubmissionRow,
} from "../domain";
import { logger } from "../observability/logger";
import { resolveSheetScopedQuestions } from "./l3-sheet-scope";

/** 导出契约版本（ADR-0025 §1：一旦发布只做加法或升版本）。v2 = 2026-09-17 增补批。 */
export const L3_SHEET_EXPORT_SCHEMA_VERSION = 2;

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

const VENUE_LABELS: Record<string, string> = { file: "题型空间", paper: "整卷" };
const STATUS_LABELS: Record<string, string> = { sealed: "已定格", discarded: "已弃档" };
const SEAL_MODE_LABELS: Record<string, string> = { full: "完整记录", incremental: "增量条目", summary: "只留总结" };
const REVIEW_VERDICT_LABELS: Record<string, string> = { sound: "成立", questionable: "存疑", wrong: "有误" };
const STAGE_LABELS: Record<string, string> = { draft: "草稿", submitted: "待检验", confirmed: "已确认" };

export interface L3SheetExportInput {
  sheet: L3SubmissionRow;
  questions: L3QuestionRow[];
  /** sealed：attempts 派生；draft 快照：恒空（逐题明细走 answers）。 */
  attempts: L3QuestionAttemptRow[];
  annotations: L3QuestionAnnotationRow[];
  assessments: L3QuestionAssessmentRow[];
  articles: Array<{ id: string | null; title: string | null; content: string | null }>;
  /** draft 快照的逐题 answer（含 marks/flags；withAnswers=false 时为空对象）。 */
  answers: Record<string, unknown>;
  /** 是否包含作答痕迹（draft 默认 false 防自我剧透；sealed 默认 true；显式可覆写）。 */
  withAnswers: boolean;
  exportedAt: string;
  /** 传入固定值用于测试 sha256 稳定性；缺省在渲染时计算。 */
  contentSha256?: string;
}

export interface L3SheetExportResult {
  markdown: string;
  filename: string;
  sha256: string;
  schemaVersion: number;
  stats: { attempts: number; cleared: number; annotations: number; assessments: number };
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 内联标记重绘（题面段 stem/option；v2 §4.6 补记「痕迹恒渲染」延伸到题面）：
 * 与 truncate 同口径归一化（空白折叠为单空格、去首尾、超长截断补 …），同时把
 * 原文坐标系的标记区间换算到展示串上以 == 包裹；相邻/重叠命中自动合并为单段
 * （不产生 ==x====y== 断裂），与原文通道（decorateArticle）渲染规则一致。
 */
export function decorateInline(
  text: string,
  marks: ReadonlyArray<{ start: number; end: number }>,
  max: number,
): string {
  // 归一化：空白折叠为单空格（映射到 run 起点）、去首尾；记录每个输出字符的原文位置。
  const cells: Array<{ ch: string; at: number }> = [];
  let pendingSpaceAt: number | null = null;
  for (let i = 0; i < text.length;) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (pendingSpaceAt === null && cells.length > 0) pendingSpaceAt = i;
      i += 1;
      continue;
    }
    if (pendingSpaceAt !== null) {
      cells.push({ ch: " ", at: pendingSpaceAt });
      pendingSpaceAt = null;
    }
    cells.push({ ch, at: i });
    i += 1;
  }
  const truncated = cells.length > max;
  const visible = truncated ? cells.slice(0, max) : cells;
  let out = "";
  let open = false;
  for (const cell of visible) {
    const covered = marks.some((mark) => mark.start <= cell.at && cell.at < mark.end);
    if (covered !== open) {
      out += "==";
      open = covered;
    }
    out += cell.ch;
  }
  if (open) out += "==";
  return truncated ? `${out}…` : out;
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

/** 当场主观状态快照摘要（self_assessment v2：flags/optionFlags/marks）。 */
function summarizeTrail(source: unknown): string | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const record = source as { flags?: unknown; optionFlags?: unknown; marks?: unknown };
  const parts: string[] = [];
  if (record.flags && typeof record.flags === "object" && !Array.isArray(record.flags)) {
    const flags = record.flags as { doubt?: unknown; recheck?: unknown };
    const labels: string[] = [];
    if (flags.doubt === true) labels.push("存疑");
    if (flags.recheck === true) labels.push("待复查");
    if (labels.length > 0) parts.push(labels.join(" / "));
  }
  if (Array.isArray(record.optionFlags) && record.optionFlags.length > 0) {
    parts.push(`选项存疑 ${record.optionFlags.map(String).join("、")}`);
  }
  if (Array.isArray(record.marks) && record.marks.length > 0) {
    parts.push(`重点标记 ${record.marks.length} 处`);
  }
  return parts.length > 0 ? parts.join(" ｜ ") : null;
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

interface MarkRange {
  start: number;
  end: number;
}

interface AnchorRange extends MarkRange {
  number: number;
}

/**
 * 原文高亮渲染（v2 §4.6/§6）：marks 与注记锚点并集 `==…==`；注记结束处追加
 * `[n]` 编号（与「注记清单」序号一致，可交叉引用）。区间越界按 content 边界裁剪。
 */
export function decorateArticle(content: string, marks: readonly MarkRange[], anchors: readonly AnchorRange[]): string {
  const length = content.length;
  if (length === 0) return content;
  const clamp = (value: number) => Math.max(0, Math.min(length, value));
  const covered = new Array<boolean>(length).fill(false);
  const cuts = new Set<number>([0, length]);
  const paint = (start: number, end: number) => {
    for (let i = clamp(start); i < clamp(end); i += 1) covered[i] = true;
  };
  for (const mark of marks) {
    paint(mark.start, mark.end);
    cuts.add(clamp(mark.start));
    cuts.add(clamp(mark.end));
  }
  for (const anchor of anchors) {
    paint(anchor.start, anchor.end);
    cuts.add(clamp(anchor.start));
    cuts.add(clamp(anchor.end));
  }
  const numberAfter = new Map<number, number[]>();
  for (const anchor of anchors) {
    const end = clamp(anchor.end);
    const list = numberAfter.get(end) ?? [];
    list.push(anchor.number);
    numberAfter.set(end, list);
  }
  const points = [...cuts].sort((a, b) => a - b);
  let out = "";
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (end <= start) continue;
    const segment = content.slice(start, end);
    out += covered[start] ? `==${segment}==` : segment;
    const numbers = numberAfter.get(end);
    if (numbers) for (const number of numbers.sort((a, b) => a - b)) out += ` [${number}]`;
  }
  return out;
}

function collectMarksBySource(
  entries: ReadonlyArray<{ questionId: string; marks: unknown }>,
  sourceOf: ReadonlyMap<string, string | null>,
): Map<string, MarkRange[]> {
  const bySource = new Map<string, MarkRange[]>();
  for (const entry of entries) {
    const sourceId = sourceOf.get(entry.questionId) ?? null;
    if (!sourceId || !Array.isArray(entry.marks)) continue;
    for (const raw of entry.marks) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const mark = raw as { scope?: unknown; start?: unknown; end?: unknown };
      if (mark.scope !== "passage") continue;
      if (typeof mark.start !== "number" || typeof mark.end !== "number" || mark.end <= mark.start) continue;
      const list = bySource.get(sourceId) ?? [];
      list.push({ start: mark.start, end: mark.end });
      bySource.set(sourceId, list);
    }
  }
  return bySource;
}

/** 题面段标记（stem/option；v2 §4.6 补记：题面高亮数据源——与 withAnswers 无关）。 */
interface QuestionInlineMark {
  scope: "stem" | "option";
  optionKey: string | null;
  start: number;
  end: number;
}

function collectQuestionMarks(
  entries: ReadonlyArray<{ questionId: string; marks: unknown }>,
): Map<string, QuestionInlineMark[]> {
  const byQuestion = new Map<string, QuestionInlineMark[]>();
  for (const entry of entries) {
    if (!Array.isArray(entry.marks)) continue;
    for (const raw of entry.marks) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const mark = raw as { scope?: unknown; optionKey?: unknown; start?: unknown; end?: unknown };
      if (mark.scope !== "stem" && mark.scope !== "option") continue;
      if (typeof mark.start !== "number" || typeof mark.end !== "number" || mark.end <= mark.start) continue;
      const optionKey = typeof mark.optionKey === "string" ? mark.optionKey : null;
      if (mark.scope === "option" && optionKey === null) continue;
      const list = byQuestion.get(entry.questionId) ?? [];
      list.push({ scope: mark.scope, optionKey, start: mark.start, end: mark.end });
      byQuestion.set(entry.questionId, list);
    }
  }
  return byQuestion;
}

function collectAnchorsBySource(
  annotations: readonly L3QuestionAnnotationRow[],
  sourceOf: ReadonlyMap<string, string | null>,
): Map<string, AnchorRange[]> {
  const bySource = new Map<string, AnchorRange[]>();
  annotations.forEach((annotation, index) => {
    if (annotation.anchor_start == null || annotation.anchor_end == null) return;
    const sourceId = sourceOf.get(annotation.question_id) ?? null;
    if (!sourceId) return;
    const list = bySource.get(sourceId) ?? [];
    list.push({ number: index + 1, start: annotation.anchor_start, end: annotation.anchor_end });
    bySource.set(sourceId, list);
  });
  return bySource;
}

function renderCore(input: L3SheetExportInput, contentSha256: string | null): string {
  const { sheet, questions, attempts, annotations, assessments, articles, answers, withAnswers, exportedAt } = input;
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const sourceOf = new Map(questions.map((question) => [question.id, question.source_id]));
  const lines: string[] = [];

  // 页眉（v2 §6）：状态/时间线 + 版本 + 可复算 sha256（双段渲染剔除自指）。
  lines.push("# L3 题纸档案（v2）", "");
  lines.push(`- 题纸: ${sheet.id}`);
  lines.push(`- 范围: ${VENUE_LABELS[sheet.scope] ?? sheet.scope}${sheet.question_type ? ` · ${sheet.question_type}` : ""}`);
  if (sheet.status === "draft") {
    lines.push(`- 状态: 草稿快照（导出时刻）`);
  } else {
    lines.push(`- 状态: ${STATUS_LABELS[sheet.status] ?? sheet.status}${sheet.seal_mode ? `（${SEAL_MODE_LABELS[sheet.seal_mode] ?? sheet.seal_mode}）` : ""}`);
  }
  lines.push(`- 作答痕迹: ${withAnswers ? "含" : "不含（可加 ?withAnswers=1 重新导出）"}`);
  lines.push(`- 导出 schema 版本: ${L3_SHEET_EXPORT_SCHEMA_VERSION}`);
  lines.push(`- 导出时间: ${exportedAt}`);
  if (contentSha256) lines.push(`- 内容校验: sha256:${contentSha256}（删除本行后可复算）`);
  lines.push("");

  // 痕迹恒渲染（§4.6 工作流）：sealed 走 self_assessment，draft 走 answers——
  // 与 withAnswers 无关（withAnswers 只管 choice 等作答事实的剧透面）。
  const trailEntries = sheet.status === "sealed"
    ? attempts.map((row) => ({
      questionId: row.question_id,
      marks: (row.self_assessment as { marks?: unknown } | null)?.marks,
    }))
    : Object.entries(answers).map(([questionId, answer]) => ({
      questionId,
      marks: (answer as { marks?: unknown } | null)?.marks,
    }));
  const marksBySource = collectMarksBySource(trailEntries, sourceOf);
  const questionMarks = collectQuestionMarks(trailEntries);

  // 原文与标记（§4.6 痕迹可视化；marks 与注记锚点恒渲染）。
  if (articles.length > 0) {
    lines.push("## 原文与标记", "");
    const anchorsBySource = collectAnchorsBySource(annotations, sourceOf);
    for (const article of articles) {
      lines.push(`### ${article.title ?? "（未命名材料）"}`, "");
      const content = article.content ?? "";
      if (!content) {
        lines.push("（无正文）", "");
        continue;
      }
      lines.push(decorateArticle(
        content,
        article.id ? (marksBySource.get(article.id) ?? []) : [],
        article.id ? (anchorsBySource.get(article.id) ?? []) : [],
      ), "");
    }
  }

  lines.push("## 题面", "");
  if (questions.length === 0) lines.push("（作用域内无题）", "");
  questions.forEach((question, index) => {
    // v2 §4.6 补记：stem / option 标记随「痕迹恒渲染」在题面以 == 绘制（坐标不变）。
    const inlineMarks = questionMarks.get(question.id) ?? [];
    const stemMarks = inlineMarks.filter((mark) => mark.scope === "stem");
    lines.push(`### ${index + 1}. ${decorateInline(question.stem, stemMarks, 160)}`);
    for (const option of question.options) {
      const optionMarks = inlineMarks.filter(
        (mark) => mark.scope === "option" && mark.optionKey === option.key,
      );
      lines.push(`- ${option.key}. ${decorateInline(option.text, optionMarks, 160)}`);
    }
    lines.push("");
  });

  lines.push("## 作答与痕迹", "");
  if (!withAnswers) {
    lines.push("（未包含作答痕迹）", "");
  } else if (sheet.status === "draft") {
    const answered = Object.keys(answers);
    if (answered.length === 0) lines.push("（尚无作答）", "");
    answered.forEach((questionId, index) => {
      const question = questionById.get(questionId);
      const answer = answers[questionId];
      const trail = summarizeTrail(answer);
      lines.push(`- ${index + 1}. ${truncate(question?.stem ?? questionId, 60)}：${summarizeAnswer(answer)}${trail ? ` ｜ ${trail}` : ""}`);
    });
    lines.push("");
  } else {
    if (attempts.length === 0) lines.push("（无作答记录）", "");
    for (const row of attempts) {
      const question = questionById.get(row.question_id);
      const trail = summarizeTrail(row.self_assessment);
      lines.push(`- ${row.created_at} · ${VENUE_LABELS[row.venue] ?? row.venue} · ${summarizeAnswer(row.answer)}｜题: ${truncate(question?.stem ?? row.question_id, 60)}`);
      if (trail) lines.push(`  - 当场痕迹: ${trail}`);
    }
    lines.push("");
  }

  // 注记清单（stage + review；编号与原文 [n] 一致）。
  lines.push("## 注记清单", "");
  if (annotations.length === 0) lines.push("（无注记）", "");
  annotations.forEach((annotation, index) => {
    const question = questionById.get(annotation.question_id);
    lines.push(`### [${index + 1}] ${STAGE_LABELS[annotation.stage] ?? annotation.stage} · 题: ${truncate(question?.stem ?? annotation.question_id, 80)}`);
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
  });

  // 评析段（v2 §11：一题一条的共建沉淀）。
  if (assessments.length > 0) {
    lines.push("## 评析", "");
    for (const assessment of assessments) {
      const question = questionById.get(assessment.question_id);
      lines.push(`### 题: ${truncate(question?.stem ?? assessment.question_id, 80)}（${assessment.last_editor === "agent" ? "agent" : "owner"} 编辑 · ${assessment.updated_at}）`, "");
      lines.push(assessment.content_md, "");
    }
  }

  if (sheet.status === "sealed") {
    const cleared = attempts.filter((row) => row.status === "deleted").length;
    lines.push("## 统计", "");
    lines.push(`- 作答记录: ${attempts.length} 条${cleared > 0 ? `（含 ${cleared} 条已清理）` : ""}`);
    lines.push(`- 冻结注记: ${annotations.length} 条`);
    lines.push(`- 评析: ${assessments.length} 条`);
    if (sheet.summary) lines.push(`- 本次总结: ${sheet.summary}`);
    lines.push("");
  }

  // 尾部 json 全量块（备份保真 / agent 解析；不重放答案红线：questions 不含答案/解析）。
  const jsonBlock = {
    exportSchemaVersion: L3_SHEET_EXPORT_SCHEMA_VERSION,
    exportedAt,
    withAnswers,
    sheet: {
      id: sheet.id,
      scope: sheet.scope,
      scopeKey: sheet.scope_key,
      status: sheet.status,
      sealMode: sheet.seal_mode,
      summary: sheet.summary,
      sealedAt: sheet.sealed_at,
      createdAt: sheet.created_at,
      updatedAt: sheet.updated_at,
    },
    questions: questions.map((question) => ({
      id: question.id,
      ordinal: question.ordinal,
      stem: question.stem,
      options: question.options,
    })),
    answers: withAnswers && sheet.status === "draft" ? answers : {},
    attempts: withAnswers
      ? attempts.map((row) => ({
        id: row.id,
        questionId: row.question_id,
        venue: row.venue,
        answer: row.answer,
        selfAssessment: row.self_assessment,
        status: row.status,
        createdAt: row.created_at,
      }))
      : [],
    annotations: annotations.map((annotation) => ({
      id: annotation.id,
      questionId: annotation.question_id,
      ordinal: annotation.ordinal,
      stage: annotation.stage,
      anchorStart: annotation.anchor_start,
      anchorEnd: annotation.anchor_end,
      excerpt: annotation.excerpt,
      note: annotation.note,
      entryTags: annotation.entry_tags,
      optionTags: annotation.option_tags,
      review: annotation.review,
      status: annotation.status,
      createdAt: annotation.created_at,
    })),
    assessments: assessments.map((assessment) => ({
      questionId: assessment.question_id,
      contentMd: assessment.content_md,
      lastEditor: assessment.last_editor,
      updatedAt: assessment.updated_at,
    })),
    articles,
  };
  lines.push("## 全量数据（json）", "");
  lines.push("```json");
  lines.push(JSON.stringify(jsonBlock, null, 2));
  lines.push("```");

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * Markdown 档案渲染（纯函数，供单测）：双段渲染实现可复算 sha256——
 * 先渲染不含校验行的全文求哈希，再渲染含校验行的最终文本。
 */
export function renderSheetExportMarkdown(input: L3SheetExportInput): { markdown: string; sha256: string } {
  const withoutHash = renderCore(input, null);
  const sha256 = input.contentSha256
    ?? createHash("sha256").update(withoutHash, "utf8").digest("hex");
  return { markdown: renderCore(input, sha256), sha256 };
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
  ): Promise<Array<{ id: string | null; title: string | null; content: string | null }>> {
    const articles: Array<{ id: string | null; title: string | null; content: string | null }> = [];
    if (sheet.scope === "file" && sheet.source_id) {
      const source = await repos.l3Context.findSourceById(userId, sheet.source_id);
      if (source) articles.push({ id: source.id, title: source.title, content: source.content_text ?? null });
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
        if (source) articles.push({ id: source.id, title: source.title, content: source.content_text ?? null });
      }
    }
    return articles;
  }

  /**
   * 导出（v2 三状态分流）：draft=快照（withAnswers 默认 false）；sealed=冻结档案
   * （默认 true）；discarded → 409。响应头携带版本与 sha256。
   */
  async exportSheet(
    userId: string,
    sheetId: string,
    options: { withAnswers?: boolean } = {},
  ): Promise<L3SheetExportResult> {
    return this.withActor(userId, async (repos) => {
      const sheet = await repos.l3Sheets.getSheet(userId, sheetId);
      if (!sheet) throw new NotFoundError("L3Sheet", sheetId);
      if (sheet.status === "discarded") {
        throw new ConflictError(
          "discarded sheets are not exportable; their product is the submitted notes",
          undefined,
          { sheetId, status: sheet.status },
        );
      }
      const withAnswers = options.withAnswers ?? (sheet.status === "sealed");

      const questions = await resolveSheetScopedQuestions(repos, userId, sheet);
      const attempts = sheet.status === "sealed" ? await repos.l3Sheets.listBySheet(userId, sheetId) : [];
      const annotations = await repos.l3Annotations.listAnnotationsBySheet(userId, sheetId);
      const assessments = (await repos.l3Assessments.listByQuestions(
        userId, questions.map((question) => question.id),
      ));
      const articles = await this.loadArticles(repos, userId, sheet);
      // answers 恒填（draft 快照的痕迹渲染数据源）；是否展示由渲染层按 withAnswers 分流。
      const answers = sheet.status === "draft" ? sheet.answers : {};

      const exportedAt = new Date().toISOString();
      const { markdown, sha256 } = renderSheetExportMarkdown({
        sheet, questions, attempts, annotations, assessments, articles, answers, withAnswers, exportedAt,
      });
      const stats = {
        attempts: attempts.length,
        cleared: attempts.filter((row) => row.status === "deleted").length,
        annotations: annotations.length,
        assessments: assessments.length,
      };

      // manifest 留痕（ADR-0025 决策 4）：结构化日志即记录（范围 + 时间 + sha256 + 分流）。
      logger.info("l3-sheet-export", "sheet export rendered", {
        sheetId,
        scope: sheet.scope,
        status: sheet.status,
        withAnswers,
        attempts: stats.attempts,
        cleared: stats.cleared,
        annotations: stats.annotations,
        assessments: stats.assessments,
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
