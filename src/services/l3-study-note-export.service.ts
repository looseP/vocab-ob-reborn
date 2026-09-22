/**
 * L3StudyNoteExportService — 学习笔记导出（N1 / Task 10；设计 §7、ADR
 * 《study-notes-workspace》§2/§3/§6、Consequences :63，执行计划 :303-313）。
 *
 * 合同要点（与题纸 v2 / 作文 v1 并列的第三种工件，schemaVersion=1、
 * artifactType=`study-note`，互不冒充）：
 * - **同一 actor 只读事务**：`lockForShare`（**FOR SHARE**，不是保存路径的
 *   FOR UPDATE）→ 读 note 行 + 归属 → 读引用行 → 校验 `expectedVersion`
 *   → 渲染。事务内**零业务写入**（不写 notes/venues/topics/refs、不建
 *   submission/attempt、不 openSheet）。
 * - **已存快照即真源**：出处一律取引用行的 `display_snapshot` / `quote_snapshot`
 *   / `captured_at`，并标「引用时间」；目标的当前活体标题只作 changed 对照
 *   （「当前来源：…」），**绝不**用当前正文替换历史摘录，也不按旧 offset
 *   在活体文本上重新定位（ADR :28、Consequences :63）。
 * - **标准答案面隔离**：快照在保存侧已白名单组装（不含 answer/explanation/
 *   evidence）；导出侧**独立**做一次键名/取值扫描，任何答案面字段一律剔除，
 *   不回填、不转发（导出物不是答案泄漏渠道）。
 * - **marker 语义单真源**：仅「顶层 paragraph 且 text 完全等于 `[[ref:<uuid>]]`」
 *   的位置替换为引用块——复用 domain 的 `matchReferenceMarkerText`，与编辑器
 *   预览（`splitStudyNotePreviewBlocks`）同判定；行内/围栏/引用块/列表内同形
 *   文本按普通 Markdown 原样保留。
 * - **sha256 双段渲染**：先渲染不含「内容校验」行的全文求哈希，再渲染含校验行
 *   的终稿——校验方删除该行后重算应与返回值/响应头同值（不递归 hash 自身）。
 * - **围栏自适应**：正文/引用摘录/JSON 块各自以「最长反引号串 + 1，≥3」的围栏
 *   包裹，围栏不可能被内容提前闭合（含恶意 HTML 只作为字面文本留在围栏内）。
 * - 只出不进（无导入能力）；归档笔记可导出且显式标注 status。
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { logger } from "../observability/logger";
import { lexer } from "marked";
import {
  matchReferenceMarkerText,
  normalizeStudyUuid,
  type ReferenceDisplaySnapshot,
  type ReferenceKind,
  type ReferencePreview,
  type ReferenceStatus,
  type ReferenceTarget,
} from "../domain/l3-study-notes";
import type { L3QuestionOption, L3QuestionType } from "../domain/l3-question-types";
import {
  L3StudyNoteRepository,
  type IL3StudyNoteRepository,
  type L3StudyNoteRow,
} from "../repositories/l3-study-notes.repository";
import {
  L3StudyReferenceRepository,
  type IL3StudyReferenceRepository,
  type L3StudyNoteReferenceRow,
} from "../repositories/l3-study-references.repository";
import {
  L3StudyReferenceService,
} from "./l3-study-reference.service";

type TxRunner = typeof withTransaction;

/** 导出工件契约版本（区别于题纸 v2 / 作文 v1）。 */
export const STUDY_NOTE_EXPORT_SCHEMA_VERSION = 1;
/** 工件类型标签（JSON 块 `kind`）。 */
export const STUDY_NOTE_EXPORT_ARTIFACT_TYPE = "study-note";

/** 本 service 在事务内使用的窄仓库集合。 */
export interface StudyNoteExportRepos {
  studyNotes: IL3StudyNoteRepository;
  studyReferences: IL3StudyReferenceRepository;
}

export type StudyNoteExportReposFactory = (tx?: PoolClient) => StudyNoteExportRepos;

const DEFAULT_REPOS_FACTORY: StudyNoteExportReposFactory = (tx) => ({
  studyNotes: new L3StudyNoteRepository(tx),
  studyReferences: new L3StudyReferenceRepository(tx),
});

// ── 输出类型（字段名冻结）──────────────────────────────────────────────────

/** JSON 块 references[] 的 target 子集（camelCase；不使用行内列名）。 */
export type StudyNoteExportTarget =
  | { sourceId: string }
  | { sourceId: string; startOffset: number; endOffset: number }
  | { questionId: string }
  | { questionId: string; startOffset: number; endOffset: number }
  | { questionId: string; optionKey: string; startOffset: number; endOffset: number };

/** JSON 块 references[] 条目（P2 冻结字段）。 */
export interface StudyNoteExportReference {
  referenceId: string;
  kind: ReferenceKind;
  status: ReferenceStatus;
  capturedAt: string;
  displaySnapshot: ReferenceDisplaySnapshot;
  target: StudyNoteExportTarget;
  liveTitle: string | null;
}

/** JSON 块 note 段（P2 冻结字段）。 */
export interface StudyNoteExportNote {
  id: string;
  title: string;
  status: string;
  pinned: boolean;
  version: number;
  venues: L3QuestionType[];
}

/** 导出 JSON 块结构（字段冻结；不允许实现期自造字段）。 */
export interface StudyNoteExportPayload {
  exportSchemaVersion: 1;
  kind: "study-note";
  exportedAt: string;
  note: StudyNoteExportNote;
  references: StudyNoteExportReference[];
  bodyMd: string;
  bodySha256: string;
}

export interface L3StudyNoteExportResult {
  markdown: string;
  filename: string;
  sha256: string;
  schemaVersion: number;
  version: number;
}

/** 渲染输入（纯函数；service 组装后交由渲染）。 */
export interface StudyNoteExportRenderInput {
  payload: StudyNoteExportPayload;
  bodyMd: string;
}

// ── 标准答案面隔离（独立于保存侧白名单的导出侧防线）─────────────────────────

/**
 * 答案面字段名（标准答案 / 判分 / 解析 / 官方证据 / 正确选项 / 作答线索）。
 *
 * 导出侧**不逐字段剔除**，而是靠 `projectDisplaySnapshot` 的按 kind 白名单
 * 显式重建；本清单供测试对产物做键名扫描（`never emits answer or evidence
 * fields…`），作为与保存侧独立的一道断言——两侧同时漏掉才会失守。
 */
export const FORBIDDEN_ANSWER_FIELD_NAMES: readonly string[] = [
  "answer", "answers", "answerindex", "answer_index", "answerkey", "answer_key",
  "correctanswer", "correct_answer", "correctoption", "correct_option",
  "correctoptions", "correct_options", "correctkey", "correct_key",
  "explanation", "explain", "explanations", "rationale",
  "evidence", "evidences", "officialanswer", "solution", "solutions", "analysis",
  "marking", "markingscheme", "marking_scheme", "marks", "score", "scoring",
  "grading", "grade", "verdict", "selfassessment", "self_assessment", "judgement",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 快照白名单投影：按 kind 只取该 kind 的展示字段（未知 kind 直接拒绝）。
 *
 * 这里是答案面隔离的**唯一入口**：显式重建对象而非转发原值，故任何
 * `FORBIDDEN_FIELD_NAMES` 之外的未知字段（含未来新增的答案面字段）都不会
 * 顺带进入产物——白名单是结构性保证，不依赖逐字段剔除。
 */
export function projectDisplaySnapshot(
  raw: unknown,
  referenceId: string,
): ReferenceDisplaySnapshot {
  if (!isPlainObject(raw)) {
    throw new ValidationError("引用快照格式非法", "displaySnapshot");
  }
  const kind = raw["kind"];
  switch (kind) {
    case "source":
      return {
        kind: "source",
        title: asTextField(raw["title"], "title", referenceId),
        excerpt: asTextField(raw["excerpt"], "excerpt", referenceId),
      };
    case "source_quote":
      return {
        kind: "source_quote",
        title: asTextField(raw["title"], "title", referenceId),
        quote: asTextField(raw["quote"], "quote", referenceId),
      };
    case "question":
      return {
        kind: "question",
        stem: asTextField(raw["stem"], "stem", referenceId),
        options: projectOptions(raw["options"], referenceId),
        questionType: raw["questionType"] as L3QuestionType,
        sourceTitle: asNullableText(raw["sourceTitle"]),
      };
    case "stem_quote":
      return {
        kind: "stem_quote",
        quote: asTextField(raw["quote"], "quote", referenceId),
        questionType: raw["questionType"] as L3QuestionType,
        sourceTitle: asNullableText(raw["sourceTitle"]),
      };
    case "option_quote":
      return {
        kind: "option_quote",
        optionKey: asTextField(raw["optionKey"], "optionKey", referenceId),
        quote: asTextField(raw["quote"], "quote", referenceId),
        questionType: raw["questionType"] as L3QuestionType,
        sourceTitle: asNullableText(raw["sourceTitle"]),
      };
    default:
      throw new ValidationError("引用快照 kind 非法", "displaySnapshot");
  }
}

/** 选项逐项只保留 {key,text}（显式重建：答案面字段没有入口）。 */
function projectOptions(raw: unknown, referenceId: string): L3QuestionOption[] {
  if (!Array.isArray(raw)) {
    throw new ValidationError(`引用快照缺少选项（${referenceId}）`, "displaySnapshot");
  }
  return raw.map((option) => {
    if (!isPlainObject(option)) {
      throw new ValidationError(`引用快照选项格式非法（${referenceId}）`, "displaySnapshot");
    }
    return {
      key: asTextField(option["key"], "key", referenceId),
      text: asTextField(option["text"], "text", referenceId),
    };
  });
}

function asTextField(value: unknown, field: string, referenceId: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(`引用快照字段 ${field} 非法（${referenceId}）`, "displaySnapshot");
  }
  return value;
}

function asNullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// ── 围栏（移植先例：最长反引号串 + 1，≥3）──────────────────────────────────

/** 动态围栏：比内容最长反引号串长 1 且 ≥3（闭栏不可能被内容提前闭合）。 */
export function fenceFor(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

// ── 引用块渲染 ─────────────────────────────────────────────────────────────

const KIND_LABELS: Record<ReferenceKind, string> = {
  source: "来源",
  source_quote: "来源摘录",
  question: "题目",
  stem_quote: "题干摘录",
  option_quote: "选项摘录",
};

const STATUS_LABELS: Record<ReferenceStatus, string> = {
  current: "已同步",
  changed: "目标已变化",
  unavailable: "目标已不可用",
};

/** 单条引用的可读摘要（与编辑器预览同口径；只读展示快照，不读活体文本）。 */
function snapshotSummary(snapshot: ReferenceDisplaySnapshot): string {
  switch (snapshot.kind) {
    case "source":
      return snapshot.title;
    case "source_quote":
      return snapshot.quote;
    case "question":
      return snapshot.stem;
    case "stem_quote":
      return snapshot.quote;
    case "option_quote":
      return `选项 ${snapshot.optionKey}「${snapshot.quote}」`;
  }
}

/** 引用行 → JSON 块 target（camelCase 投影；行内列名不出现在产物里）。 */
function toExportTarget(row: L3StudyNoteReferenceRow): StudyNoteExportTarget {
  switch (row.kind) {
    case "source":
      return { sourceId: row.source_id! };
    case "source_quote":
      return { sourceId: row.source_id!, startOffset: row.start_offset!, endOffset: row.end_offset! };
    case "question":
      return { questionId: row.question_id! };
    case "stem_quote":
      return { questionId: row.question_id!, startOffset: row.start_offset!, endOffset: row.end_offset! };
    case "option_quote":
      return {
        questionId: row.question_id!,
        optionKey: row.option_key!,
        startOffset: row.start_offset!,
        endOffset: row.end_offset!,
      };
  }
}

/** 引用块（Markdown 片段；缩进为引用块内一行）。 */
function renderReferenceBlock(reference: ReferencePreview): string[] {
  const lines: string[] = [];
  const label = KIND_LABELS[reference.displaySnapshot.kind];
  lines.push(`> **引用 · ${label}** \`${reference.id}\``);
  lines.push(`> status=${reference.status}（${STATUS_LABELS[reference.status]}）`);
  lines.push(`> 引用时间: ${reference.capturedAt}`);
  lines.push(`> 已存快照: ${snapshotSummary(reference.displaySnapshot)}`);

  const snapshot = reference.displaySnapshot;
  if (snapshot.kind === "source") {
    lines.push(`> 来源标题: ${snapshot.title}`);
    const excerptFence = fenceFor(snapshot.excerpt);
    lines.push(`> ${excerptFence}`);
    for (const line of snapshot.excerpt.split("\n")) lines.push(`> ${line}`);
    lines.push(`> ${excerptFence}`);
  } else if (snapshot.kind === "source_quote") {
    lines.push(`> 来源标题: ${snapshot.title}`);
    lines.push(`> 摘录: ${snapshot.quote}`);
  } else if (snapshot.kind === "question") {
    if (snapshot.sourceTitle) lines.push(`> 来源: ${snapshot.sourceTitle}`);
    lines.push(`> 题型: ${snapshot.questionType}`);
    lines.push(`> 题干: ${snapshot.stem}`);
    for (const option of snapshot.options) lines.push(`> - ${option.key}. ${option.text}`);
  } else if (snapshot.kind === "stem_quote") {
    if (snapshot.sourceTitle) lines.push(`> 来源: ${snapshot.sourceTitle}`);
    lines.push(`> 题型: ${snapshot.questionType}`);
    lines.push(`> 题干摘录: ${snapshot.quote}`);
  } else {
    if (snapshot.sourceTitle) lines.push(`> 来源: ${snapshot.sourceTitle}`);
    lines.push(`> 题型: ${snapshot.questionType}`);
    lines.push(`> 选项 ${snapshot.optionKey} 摘录: ${snapshot.quote}`);
  }

  if (reference.status === "unavailable") {
    lines.push("> 目标已不可用，以下为引用时摘录（不作改写、不重定位）。");
  }
  if (reference.status === "changed") {
    if (reference.liveTitle !== null) lines.push(`> 当前来源: ${reference.liveTitle}`);
    lines.push("> 以下摘录为引用时快照，未按目标当前文本替换。");
  }
  lines.push("");
  return lines;
}

// ── marker 分块（与 domain / 编辑器预览同一语义）───────────────────────────

type BodyBlock =
  | { kind: "markdown"; text: string }
  | { kind: "reference"; refId: string };

/**
 * 按顶层 token 拆分正文：仅「顶层 paragraph 且 text 完全等于合法 marker」的位置
 * 产出引用块；其余一律保留 `token.raw` 原文（不重新序列化、不拆散 token）。
 * 非法形状标记（形状命中但非 UUID）按普通 Markdown 保留——该正文已被保存预检
 * 拒绝，导出不承担纠错提示。
 */
function splitBodyBlocks(bodyMd: string): BodyBlock[] {
  if (typeof bodyMd !== "string" || bodyMd.length === 0) return [];
  const tokens = lexer(bodyMd);
  const defsPrefix = tokens
    .filter((token) => token.type === "def")
    .map((token) => (typeof token.raw === "string" ? token.raw : ""))
    .join("");
  const blocks: BodyBlock[] = [];
  let markdown = "";
  const pushMarkdown = (): void => {
    if (!markdown) return;
    blocks.push({ kind: "markdown", text: defsPrefix ? `${defsPrefix}\n${markdown}` : markdown });
    markdown = "";
  };
  for (const token of tokens) {
    const raw = typeof token.raw === "string" ? token.raw : "";
    if (token.type === "paragraph") {
      const text = (token as { text?: unknown }).text;
      if (typeof text === "string") {
        const match = matchReferenceMarkerText(text);
        if (match.kind === "marker") {
          pushMarkdown();
          blocks.push({ kind: "reference", refId: match.refId });
          continue;
        }
      }
    }
    markdown += raw;
  }
  pushMarkdown();
  return blocks;
}

/** 正文正文段（marker 替换为引用块后的 Markdown 文本）。 */
function renderBody(
  bodyMd: string,
  referenceMap: Map<string, ReferencePreview>,
  order: string[],
): string {
  const lines: string[] = [];
  for (const block of splitBodyBlocks(bodyMd)) {
    if (block.kind === "markdown") {
      lines.push(block.text);
      continue;
    }
    const reference = referenceMap.get(block.refId);
    if (!reference) {
      // 标记对应的引用行缺失（应用外删改）：保留可读占位，不静默吞掉。
      lines.push(`> **引用 · 未找到快照** \`${block.refId}\``, "");
      continue;
    }
    lines.push(...renderReferenceBlock(reference));
    order.push(reference.id);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
}

// ── 渲染（纯函数；双段 hash 供单测）────────────────────────────────────────

function renderCore(input: StudyNoteExportRenderInput, contentSha256: string | null): string {
  const { payload } = input;
  const lines: string[] = [];
  lines.push("# 学习笔记档案（study-note v1）", "");
  lines.push(`- 笔记: ${payload.note.id}`);
  lines.push(`- 标题: ${payload.note.title || "（无标题笔记）"}`);
  lines.push(`- 状态: ${payload.note.status}`);
  lines.push(`- 置顶: ${payload.note.pinned ? "是" : "否"}`);
  lines.push(`- 版本: ${payload.note.version}`);
  lines.push(`- 题型归属: ${payload.note.venues.length > 0 ? payload.note.venues.join("、") : "（无）"}`);
  lines.push(`- 引用条数: ${payload.references.length}`);
  lines.push(`- 导出 schema 版本: ${payload.exportSchemaVersion}`);
  lines.push(`- 工件类型: ${payload.kind}`);
  lines.push(`- 导出时间: ${payload.exportedAt}`);
  lines.push(`- 正文 sha256: ${payload.bodySha256}`);
  if (contentSha256) lines.push(`- 内容校验: sha256:${contentSha256}（删除本行后可复算）`);
  lines.push("");

  lines.push("## 正文", "");
  const bodySection = input.bodyMd;
  const bodyFence = fenceFor(bodySection);
  lines.push(bodyFence);
  lines.push(bodySection);
  lines.push(bodyFence, "");

  lines.push("## 来源清单", "");
  if (payload.references.length === 0) {
    lines.push("（本篇笔记没有引用）", "");
  } else {
    const ordered = [...payload.references].sort((a, b) =>
      a.capturedAt === b.capturedAt
        ? a.referenceId.localeCompare(b.referenceId)
        : a.capturedAt.localeCompare(b.capturedAt),
    );
    for (const reference of ordered) {
      lines.push(
        `- \`${reference.referenceId}\` · ${KIND_LABELS[reference.kind]} · status=${reference.status}` +
        ` · 引用时间 ${reference.capturedAt}`,
      );
    }
    lines.push("");
  }

  lines.push("## 结构化数据（JSON）", "");
  const jsonText = JSON.stringify(payload, null, 2);
  const jsonFence = fenceFor(jsonText);
  lines.push(`${jsonFence}json`, jsonText, jsonFence, "");
  return lines.join("\n");
}

/** 双段渲染（纯函数，供单测）：sha256 可复算（删除校验行后重算同值）。 */
export function renderStudyNoteExportMarkdown(
  input: StudyNoteExportRenderInput,
): { markdown: string; sha256: string } {
  const withoutHash = renderCore(input, null);
  const sha256 = createHash("sha256").update(withoutHash, "utf8").digest("hex");
  return { markdown: renderCore(input, sha256), sha256 };
}

// ── Service ───────────────────────────────────────────────────────────────

export class L3StudyNoteExportService {
  constructor(
    private readonly txRunner: TxRunner = withTransaction,
    private readonly reposFactory: StudyNoteExportReposFactory = DEFAULT_REPOS_FACTORY,
    private readonly referenceService: L3StudyReferenceService = new L3StudyReferenceService(),
  ) {}

  private withActor<T>(userId: string, callback: (repos: StudyNoteExportRepos) => Promise<T>): Promise<T> {
    return this.txRunner(async (tx) => callback(this.reposFactory(tx)), { actorId: userId });
  }

  /**
   * 导出笔记（只读事务）。返回 markdown（双段渲染终稿）、sha256、version。
   *
   * 失败面：note 不存在/非本人 → 404；`expectedVersion` 缺失 → 400 语义
   * （ValidationError）；与当前 version 不一致 → 409（只带 currentVersion，
   * 不回传服务器正文；归档笔记同样核对，不豁免）。
   */
  async export(
    userId: string,
    noteId: string,
    options: { expectedVersion?: number },
  ): Promise<L3StudyNoteExportResult> {
    const id = normalizeStudyUuid(noteId);
    return this.withActor(userId, async (repos) => {
      // 1) 共享行锁（FOR SHARE）：与并发保存的 FOR UPDATE 互斥，保证随后读到的
      //    正文/版本/引用属于同一提交；导出本身不写，故不取排他锁。
      const note = await repos.studyNotes.lockForShare(userId, id);
      if (!note) throw new NotFoundError("StudyNote", noteId);

      // 2) 归属 + 引用行（同一事务、同一提交视图）
      const venues = await repos.studyNotes.listVenues(userId, id);
      const refRows = await repos.studyReferences.listForNote(userId, id);

      // 3) 版本合同（P3）：缺失拒；不一致 409 且只回 currentVersion。
      if (options.expectedVersion == null) {
        throw new ValidationError("导出必须携带 expectedVersion（客户端已保存版本）", "expectedVersion");
      }
      if (note.version !== options.expectedVersion) {
        throw new ConflictError("Note version conflict: export aborted", undefined, {
          noteId: id,
          currentVersion: note.version,
        });
      }

      // 4) 已存快照 → 预览（status / capturedAt / liveTitle 一律来自持久化行）
      const previews = await this.referenceService.resolve(userId, refRows, repos);
      const previewById = new Map(previews.map((preview) => [normalizeStudyUuid(preview.id), preview]));
      const rowById = new Map(refRows.map((row) => [normalizeStudyUuid(row.id), row]));

      // 5) 渲染正文（marker → 引用块），按出现顺序收集被真正替换的引用 id
      const order: string[] = [];
      const bodyMd = renderBody(note.body_md, previewById, order);

      // 6) JSON 块 references：正文出现顺序、按 referenceId 去重；快照走白名单投影
      const seen = new Set<string>();
      const references: StudyNoteExportReference[] = [];
      for (const refId of order) {
        if (seen.has(refId)) continue;
        seen.add(refId);
        const preview = previewById.get(refId)!;
        const row = rowById.get(refId)!;
        references.push({
          referenceId: preview.id,
          kind: row.kind,
          status: preview.status,
          capturedAt: preview.capturedAt,
          displaySnapshot: projectDisplaySnapshot(preview.displaySnapshot, preview.id),
          target: toExportTarget(row),
          liveTitle: preview.liveTitle,
        });
      }

      const exportedAt = new Date().toISOString();
      const payload: StudyNoteExportPayload = {
        exportSchemaVersion: STUDY_NOTE_EXPORT_SCHEMA_VERSION,
        kind: STUDY_NOTE_EXPORT_ARTIFACT_TYPE,
        exportedAt,
        note: {
          id: note.id,
          title: note.title,
          status: note.status,
          pinned: note.pinned,
          version: note.version,
          venues: orderVenues(venues),
        },
        references,
        bodyMd,
        bodySha256: createHash("sha256").update(bodyMd, "utf8").digest("hex"),
      };

      const { markdown, sha256 } = renderStudyNoteExportMarkdown({ payload, bodyMd });

      // 7) manifest 留痕（与先例同款：结构化日志即记录——id/version/hash/引用数/时间）
      logger.info("l3-study-note-export", "study note export rendered", {
        noteId: note.id,
        userId,
        version: note.version,
        status: note.status,
        referenceCount: references.length,
        schemaVersion: STUDY_NOTE_EXPORT_SCHEMA_VERSION,
        sha256,
        exportedAt,
      });

      return {
        markdown,
        filename: `study-note-${note.id}.md`,
        sha256,
        schemaVersion: STUDY_NOTE_EXPORT_SCHEMA_VERSION,
        version: note.version,
      };
    });
  }
}

/** 归属展示序（题型枚举固定顺序；与笔记 DTO 同口径）。 */
function orderVenues(venues: readonly L3QuestionType[]): L3QuestionType[] {
  const order: readonly L3QuestionType[] = [
    "cloze", "reading_choice", "new_question", "sentence_translation",
    "short_essay", "long_essay", "grammar_blank",
  ];
  return [...venues].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
