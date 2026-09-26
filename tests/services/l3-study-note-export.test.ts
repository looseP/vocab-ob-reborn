/**
 * L3StudyNoteExportService 单测（N1 / Task 10；设计 §7、ADR《study-notes-workspace》
 * §2/§3/§6，执行计划 :307-313 五条验收条）。
 *
 * 覆盖（每条一个可检索用例名）：
 * - A12 顶层 marker 识别（仅顶层 paragraph 完全等于 `[[ref:<uuid>]]` 才替换；
 *   内联/代码块/引用块/列表内的同形文本按普通 Markdown 保留）——与 domain
 *   `matchReferenceMarkerText`/`parseReferenceIds` 同语义（单真源）；
 * - A11 非 marker Markdown 按原顺序保留 + 末尾 JSON 块；
 * - 引用块三态（current / changed / unavailable）；
 * - B6 五种引用 kind（source / source_quote / question / stem_quote / option_quote）；
 * - A2/A3 中文、反引号、围栏代码块、恶意 HTML（不得破出导出结构）；
 * - A4 归档笔记可导出（200 语义，不报错且显式标注 archived）；
 * - A1/B7 自适应 JSON 围栏（长度 > 内容中最长反引号串）；
 * - A14/B8 双段 hash（删除「内容校验」行后可复算，与返回值同值）；
 * - A6/P2 JSON 块字段冻结（exportSchemaVersion=1 / kind="study-note"）；
 * - A8/P2 question 型快照不得混入标准答案/解析/correct option/marking 字段；
 * - A9 同一 actor 事务内 lockForShare（且保存路径的 lock/FOR UPDATE 未被调用）；
 * - A10/A5 输出已存快照与 capturedAt，不用目标的当前活体文本替换历史摘录；
 * - B1 普通笔记（无引用、无异常字符）导出成功且结构完整；
 * - B9/B10/B12 零业务写入（导出事务内无 INSERT/UPDATE/DELETE）。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "@/errors";
import { logger } from "@/observability/logger";
import type {
  ReferenceDisplaySnapshot,
  ReferencePreview,
  ReferenceTarget,
} from "@/domain/l3-study-notes";
import type { L3StudyNoteRow } from "@/repositories/l3-study-notes.repository";
import type { L3StudyNoteReferenceRow } from "@/repositories/l3-study-references.repository";
import {
  FORBIDDEN_ANSWER_FIELD_NAMES,
  STUDY_NOTE_EXPORT_ARTIFACT_TYPE,
  STUDY_NOTE_EXPORT_SCHEMA_VERSION,
  L3StudyNoteExportService,
  fenceFor,
  renderStudyNoteExportMarkdown,
  type StudyNoteExportPayload,
} from "@/services/l3-study-note-export.service";

const USER = "00000000-0000-4000-8000-0000000000a1";
const NOTE = "00000000-0000-4000-8000-000000000101";
const SOURCE = "00000000-0000-4000-8000-000000000201";
const QUESTION = "00000000-0000-4000-8000-000000000211";
const REF_SOURCE = "00000000-0000-4000-8000-000000000001";
const REF_SOURCE_QUOTE = "00000000-0000-4000-8000-000000000002";
const REF_QUESTION = "00000000-0000-4000-8000-000000000003";
const REF_STEM_QUOTE = "00000000-0000-4000-8000-000000000004";
const REF_OPTION_QUOTE = "00000000-0000-4000-8000-000000000005";

const CAPTURED_AT = "2026-09-19T03:04:05.000Z";

/** 冻结 JSON 块字段（P2 表；缺一即红）。 */
const FROZEN_JSON_FIELDS = [
  "exportSchemaVersion",
  "kind",
  "exportedAt",
  "note",
  "references",
  "bodyMd",
  "bodySha256",
] as const;

// ── 夹具 ───────────────────────────────────────────────────────────────────

/**
 * 围栏块提取（行锚定：开栏=行首 `{3,}` 可带 info string；闭栏=行首同长反引号串）。
 * 正文段与 JSON 段都可能有多个围栏块，故按 `## ` 小节切片后再取块。
 */
function fenceBlocks(section: string): Array<{ info: string; body: string; fence: string }> {
  const blocks: Array<{ info: string; body: string; fence: string }> = [];
  const lines = section.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(`{3,})(.*)$/.exec(lines[i]!);
    if (!open) continue;
    const fence = open[1]!;
    const info = open[2]!.trim();
    const body: string[] = [];
    for (i += 1; i < lines.length; i += 1) {
      if (lines[i] === fence) break;
      body.push(lines[i]!);
    }
    blocks.push({ info, body: body.join("\n"), fence });
  }
  return blocks;
}

/** 取某一 `## ` 小节的正文文本（不含该行）。 */
function section(markdown: string, heading: string): string {
  const parts = markdown.split(`## ${heading}`);
  expect(parts.length, `产物应含小节 ## ${heading}`).toBeGreaterThan(1);
  return parts[1]!.split("\n## ")[0]!;
}

/** 被断言的导出模块源文件路径（源码级只读断言用）。 */
function serviceModulePath(): string {
  return fileURLToPath(new URL("../../src/services/l3-study-note-export.service.ts", import.meta.url));
}

function noteRow(overrides: Partial<L3StudyNoteRow> = {}): L3StudyNoteRow {
  return {
    id: NOTE, user_id: USER, title: "我的笔记", body_md: "正文", status: "active", pinned: false,
    version: 3, create_request_id: "00000000-0000-4000-8000-000000000121",
    create_input_hash: "a".repeat(64), last_write_request_id: null, last_write_hash: null,
    created_at: "2026-09-19T00:00:00Z", updated_at: "2026-09-19T01:00:00Z",
    ...overrides,
  };
}

function sourceSnapshot(title: string, excerpt: string): ReferenceDisplaySnapshot {
  return { kind: "source", title, excerpt };
}

function sourceQuoteSnapshot(title: string, quote: string): ReferenceDisplaySnapshot {
  return { kind: "source_quote", title, quote };
}

function questionSnapshot(
  overrides: Partial<Extract<ReferenceDisplaySnapshot, { kind: "question" }>> = {},
): ReferenceDisplaySnapshot {
  return {
    kind: "question",
    stem: "下列哪一项最符合文意？",
    options: [
      { key: "A", text: "第一项" },
      { key: "B", text: "第二项" },
    ],
    questionType: "reading_choice",
    sourceTitle: "2024 阅读真题",
    ...overrides,
  };
}

function stemQuoteSnapshot(quote: string): ReferenceDisplaySnapshot {
  return { kind: "stem_quote", quote, questionType: "reading_choice", sourceTitle: "2024 阅读真题" };
}

function optionQuoteSnapshot(optionKey: string, quote: string): ReferenceDisplaySnapshot {
  return {
    kind: "option_quote", optionKey, quote, questionType: "reading_choice",
    sourceTitle: "2024 阅读真题",
  };
}

/** 引用行（持久化形态；导出只能读它，不得回填目标当前文本）。 */
function refRow(overrides: Partial<L3StudyNoteReferenceRow> = {}): L3StudyNoteReferenceRow {
  return {
    id: REF_SOURCE, note_id: NOTE, user_id: USER, kind: "source",
    source_id: SOURCE, question_id: null, assessment_id: null, target_note_id: null,
    submission_id: null, submission_revision_no: null, attempt_id: null, writing_task_id: null, option_key: null,
    start_offset: null, end_offset: null, quote_snapshot: null,
    field_hash: "f".repeat(64), display_snapshot: asJson(sourceSnapshot("来源标题", "来源摘要")),
    captured_at: CAPTURED_AT,
    ...overrides,
  };
}

/** 展示快照落库形态（jsonb 列经 pg 读回时是普通 JSON 值）。 */
function asJson(snapshot: ReferenceDisplaySnapshot): L3StudyNoteReferenceRow["display_snapshot"] {
  return snapshot as unknown as L3StudyNoteReferenceRow["display_snapshot"];
}

/** 已解析预览（status/liveTitle 由 resolve 计算；导出必须消费它）。 */
function preview(
  id: string,
  status: ReferencePreview["status"],
  displaySnapshot: ReferenceDisplaySnapshot,
  overrides: Partial<ReferencePreview> = {},
): ReferencePreview {
  return {
    id,
    target: { kind: "source", sourceId: SOURCE } as ReferenceTarget,
    status,
    capturedAt: CAPTURED_AT,
    displaySnapshot,
    liveTitle: null,
    ...overrides,
  };
}

interface FakeRepos {
  studyNotes: {
    lockForShare: ReturnType<typeof vi.fn>;
    lock: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    listVenues: ReturnType<typeof vi.fn>;
    listVenuesForNotes: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    createIfAbsent: ReturnType<typeof vi.fn>;
    findByCreateRequestId: ReturnType<typeof vi.fn>;
    updateIfVersion: ReturnType<typeof vi.fn>;
    replaceVenues: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    listTopicBlockers: ReturnType<typeof vi.fn>;
  };
  studyReferences: {
    listForNote: ReturnType<typeof vi.fn>;
    findReferenceOwners: ReturnType<typeof vi.fn>;
    replaceForNote: ReturnType<typeof vi.fn>;
    searchTargets: ReturnType<typeof vi.fn>;
    loadTargets: ReturnType<typeof vi.fn>;
    lockTargets: ReturnType<typeof vi.fn>;
    listBacklinks: ReturnType<typeof vi.fn>;
    getSourceDeleteBlockers: ReturnType<typeof vi.fn>;
    getQuestionDeleteBlockers: ReturnType<typeof vi.fn>;
  };
}

/** 写面全部以「若被调用即断言失败」的探针实现：导出必须零业务写入。 */
function writeProbe(name: string): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    throw new Error(`export must not write: ${name} was called`);
  });
}

function fakeRepos(overrides: {
  note?: L3StudyNoteRow | null;
  venues?: string[];
  refRows?: L3StudyNoteReferenceRow[];
} = {}): FakeRepos {
  const note = overrides.note === undefined ? noteRow() : overrides.note;
  return {
    studyNotes: {
      lockForShare: vi.fn(async () => note),
      lock: vi.fn(async () => note),
      get: vi.fn(async () => note),
      listVenues: vi.fn(async () => overrides.venues ?? ["reading_choice"]),
      listVenuesForNotes: vi.fn(async () => new Map()),
      create: writeProbe("studyNotes.create"),
      createIfAbsent: writeProbe("studyNotes.createIfAbsent"),
      findByCreateRequestId: vi.fn(async () => null),
      updateIfVersion: writeProbe("studyNotes.updateIfVersion"),
      replaceVenues: writeProbe("studyNotes.replaceVenues"),
      list: vi.fn(async () => ({ items: [], total: 0 })),
      listTopicBlockers: vi.fn(async () => []),
    },
    studyReferences: {
      listForNote: vi.fn(async () => overrides.refRows ?? []),
      findReferenceOwners: vi.fn(async () => new Map()),
      replaceForNote: writeProbe("studyReferences.replaceForNote"),
      searchTargets: vi.fn(async () => ({ items: [], total: 0 })),
      loadTargets: vi.fn(async () => new Map()),
      lockTargets: writeProbe("studyReferences.lockTargets"),
      listBacklinks: vi.fn(async () => ({ items: [], total: 0 })),
      getSourceDeleteBlockers: vi.fn(async () => []),
      getQuestionDeleteBlockers: vi.fn(async () => []),
    },
  };
}

let repos: FakeRepos;
let referenceService: { resolve: ReturnType<typeof vi.fn> };
let service: L3StudyNoteExportService;
let txCalls: Array<{ actorId?: string }>;

function makeService(
  fake = repos,
  resolver?: (rows: readonly L3StudyNoteReferenceRow[]) => ReferencePreview[],
): L3StudyNoteExportService {
  const txRunner = (async (
    callback: (tx: unknown) => Promise<unknown>,
    options: { actorId?: string },
  ) => {
    txCalls.push(options ?? {});
    return callback({});
  }) as never;
  if (resolver) {
    referenceService.resolve = vi.fn(async (_userId: string, rows: readonly L3StudyNoteReferenceRow[]) =>
      resolver(rows),
    );
  }
  return new L3StudyNoteExportService(
    txRunner,
    () => fake as never,
    referenceService as never,
  );
}

/** resolve 的默认行为：按行返回 current 预览（保持 id 与快照逐行对应）。 */
function defaultResolve(rows: readonly L3StudyNoteReferenceRow[]): ReferencePreview[] {
  return rows.map((row) => ({
    id: row.id,
    target: { kind: "source", sourceId: row.source_id ?? SOURCE } as ReferenceTarget,
    status: "current" as const,
    capturedAt: row.captured_at,
    displaySnapshot: row.display_snapshot as unknown as ReferenceDisplaySnapshot,
    liveTitle: null,
  }));
}

beforeEach(() => {
  repos = fakeRepos();
  txCalls = [];
  referenceService = {
    resolve: vi.fn(async (_userId: string, rows: readonly L3StudyNoteReferenceRow[]) => defaultResolve(rows)),
  };
  service = makeService();
});

// ── 提取 / 复算工具（对齐先例测试的提取器口径）─────────────────────────────

/** 提取最后一个 JSON 围栏块（行锚定：闭栏=行首同长反引号串）。 */
function extractLastJsonBlock(markdown: string): Record<string, unknown> {
  const matches = [...markdown.matchAll(/(?:^|\n)(`{3,})json\n([\s\S]*?)\n\1\n?/g)];
  expect(matches.length).toBeGreaterThan(0);
  const last = matches[matches.length - 1]!;
  return JSON.parse(last[2]!) as Record<string, unknown>;
}

/** 提取 JSON 围栏块的**开栏串**（断言自适应长度用）。 */
function jsonOpeningFence(markdown: string): string {
  const match = /(?:^|\n)(`{3,})json\n/.exec(markdown);
  expect(match).not.toBeNull();
  return match![1]!;
}

/** 最长反引号连续串长度。 */
function longestBacktickRun(text: string): number {
  const runs = text.match(/`+/g) ?? [];
  return runs.reduce((max, run) => Math.max(max, run.length), 0);
}

/** 删除内容校验行后的全文（双段 hash 复算面）。 */
function withoutChecksumLine(markdown: string): string {
  return markdown.replace(/^- 内容校验: sha256:[0-9a-f]{64}（删除本行后可复算）\n/m, "");
}

function recomputeSha(markdown: string): string {
  return createHash("sha256").update(withoutChecksumLine(markdown), "utf8").digest("hex");
}

// ── A12：顶层 marker 识别 ─────────────────────────────────────────────────

describe("marker 识别（仅顶层 paragraph 完全等于标记；与 domain 同语义）", () => {
  it("replaces top-level markers with readable blocks and appends json", async () => {
    const body = ["第一段。", "", `[[ref:${REF_SOURCE}]]`, "", "第二段。"].join("\n");
    repos = fakeRepos({ note: noteRow({ body_md: body }), refRows: [refRow()] });
    service = makeService();
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    // marker 被替换为引用块（原始标记字面量不再出现在产物中）
    expect(result.markdown).not.toContain(`[[ref:${REF_SOURCE}]]`);
    expect(result.markdown).toContain("引用");
    expect(result.markdown).toContain(REF_SOURCE);
    // 普通 Markdown 段落在位，且顺序保持（引用块插在两段之间）
    const first = result.markdown.indexOf("第一段。");
    const block = result.markdown.indexOf(`引用 · 来源`);
    const second = result.markdown.indexOf("第二段。");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(block).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(block);
  });

  it("does not replace inline or non-paragraph markers", async () => {
    // 行内同形文本 / 围栏代码块内 / 引用块内 / 列表内 / 标题内 一律不替换
    const body = [
      `行内文本 [[ref:${REF_SOURCE}]] 后接内容。`,
      "",
      "```",
      `[[ref:${REF_SOURCE}]]`,
      "```",
      "",
      `> [[ref:${REF_SOURCE}]]`,
      "",
      `- [[ref:${REF_SOURCE}]]`,
      "",
      `# [[ref:${REF_SOURCE}]]`,
    ].join("\n");
    repos = fakeRepos({ note: noteRow({ body_md: body }), refRows: [refRow()] });
    service = makeService();
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });
    const json = extractLastJsonBlock(result.markdown);

    // 无任何引用被识别：JSON 块 references 为空，且五处同形文本原样保留在正文围栏内
    expect(json["references"]).toEqual([]);
    const bodyBlock = fenceBlocks(section(result.markdown, "正文"))[0]!;
    expect(bodyBlock.info).toBe("");
    const literal = `[[ref:${REF_SOURCE}]]`;
    expect(bodyBlock.body.split(literal).length - 1).toBe(5);
  });

  it("does not duplicate reference blocks when a marker appears once", async () => {
    const body = `[[ref:${REF_SOURCE}]]`;
    repos = fakeRepos({ note: noteRow({ body_md: body }), refRows: [refRow()] });
    service = makeService();
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });
    const json = extractLastJsonBlock(result.markdown);
    expect((json["references"] as unknown[]).length).toBe(1);
    // 恰一个引用块、恰一条来源清单条目（不重复渲染）
    const bodyBlock = fenceBlocks(section(result.markdown, "正文"))[0]!;
    expect(bodyBlock.body.split("**引用 ·").length - 1).toBe(1);
    const sources = section(result.markdown, "来源清单");
    expect(sources.split("\n- ").length - 1).toBe(1);
  });
});

// ── A11 / 非 marker Markdown 原序保留 ─────────────────────────────────────

describe("Markdown 保真", () => {
  it("preserves non-marker markdown in its original order", async () => {
    const body = [
      "# 标题",
      "",
      "第一段：有 `行内代码` 的文本。",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "> 引用块",
      "",
      "- 列表项一",
      "- 列表项二",
    ].join("\n");
    repos = fakeRepos({ note: noteRow({ body_md: body }), refRows: [] });
    service = makeService();
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    const bodyBlock = fenceBlocks(section(result.markdown, "正文"))[0]!;
    const positions = ["# 标题", "第一段", "```ts", "const a = 1;", "> 引用块", "- 列表项一", "- 列表项二"]
      .map((needle) => bodyBlock.body.indexOf(needle));
    for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it("exports a plain note without references", async () => {
    repos = fakeRepos({ note: noteRow({ title: "普通笔记", body_md: "没有引用的正文。" }), refRows: [] });
    service = makeService();
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });
    const json = extractLastJsonBlock(result.markdown);
    const payload = json as unknown as StudyNoteExportPayload;

    expect(payload.exportSchemaVersion).toBe(1);
    expect(payload.kind).toBe("study-note");
    expect(payload.references).toEqual([]);
    expect(payload.bodyMd).toBe("没有引用的正文。");
    expect(payload.note.title).toBe("普通笔记");
    expect(payload.note.version).toBe(3);
    expect(payload.note.venues).toEqual(["reading_choice"]);
    expect(result.version).toBe(3);
    expect(result.filename).toBe(`study-note-${NOTE}.md`);
    expect(result.schemaVersion).toBe(1);
  });
});

describe("空行压缩边界（P3-4：块间规整、块内保真）", () => {
  it("keeps consecutive blank lines inside a markdown block byte-for-byte", async () => {
    const body = "段一\n\n\n\n段二"; // 段间 3 个空行：块内部，不得压缩
    repos = fakeRepos({ note: noteRow({ body_md: body }), refRows: [] });
    service = makeService();
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    const bodyBlock = fenceBlocks(section(result.markdown, "正文"))[0]!;
    expect(bodyBlock.body).toContain("段一\n\n\n\n段二");
    const payload = extractLastJsonBlock(result.markdown) as unknown as StudyNoteExportPayload;
    expect(payload.bodyMd).toBe("段一\n\n\n\n段二");
  });

  it("keeps blank lines inside a fenced code block of the note body", async () => {
    const body = "```txt\na\n\n\n\nb\n```"; // 代码块内部 3 个空行：原样保留
    repos = fakeRepos({ note: noteRow({ body_md: body }), refRows: [] });
    service = makeService();
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    const bodyBlock = fenceBlocks(section(result.markdown, "正文"))[0]!;
    expect(bodyBlock.body).toContain("a\n\n\n\nb");
    const payload = extractLastJsonBlock(result.markdown) as unknown as StudyNoteExportPayload;
    expect(payload.bodyMd).toBe("```txt\na\n\n\n\nb\n```");
  });

  it("collapses blank runs only at seams between markdown and reference blocks", async () => {
    const body = `段一\n\n\n\n[[ref:${REF_SOURCE}]]\n\n\n\n段二`;
    repos = fakeRepos({ note: noteRow({ body_md: body }), refRows: [refRow()] });
    service = makeService();
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    const bodyText = fenceBlocks(section(result.markdown, "正文"))[0]!.body;
    // 接缝：段一 与引用块之间恰好一个空行（不堆积、也不吞没）
    expect(bodyText).toContain("段一\n\n> **引用 · 来源**");
    // 接缝：引用块 与 段二之间恰好一个空行
    expect(bodyText).toContain("\n\n段二");
    // 接缝处不得残留 3+ 连续换行（两侧块内空行已被规整）
    expect(bodyText).not.toContain("段一\n\n\n");
    expect(bodyText).not.toContain("\n\n\n段二");
  });
});

describe("缺失引用快照（marker 有、引用行已被应用外删改）", () => {
  it("keeps a readable placeholder block instead of dropping the marker", async () => {
    // 正文含 REF_SOURCE_QUOTE 的 marker，但 repository 只回 REF_SOURCE 一行
    const body = `段一\n\n[[ref:${REF_SOURCE_QUOTE}]]\n\n段二`;
    repos = fakeRepos({ note: noteRow({ body_md: body }), refRows: [refRow()] });
    service = makeService();
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    const bodyText = fenceBlocks(section(result.markdown, "正文"))[0]!.body;
    // 保留可读占位（含 refId），不静默吞掉、也不留裸 marker
    expect(bodyText).toContain(`> **引用 · 未找到快照** \`${REF_SOURCE_QUOTE}\``);
    expect(bodyText).not.toContain(`[[ref:${REF_SOURCE_QUOTE}]]`);
    // 占位块两侧接缝各恰好一个空行（与正常引用块同形）
    expect(bodyText).toContain("段一\n\n> **引用 · 未找到快照**");
    expect(bodyText).toContain("\n\n段二");
    // 来源清单只列正文中实际渲染成功的引用；未找到快照的 marker 无快照可列，
    // 也不得凭 repository 里其它引用行回填（bodyMd 仍逐字保留原 marker）。
    const payload = extractLastJsonBlock(result.markdown) as unknown as StudyNoteExportPayload;
    expect(payload.references).toEqual([]);
    // JSON 块的 bodyMd 是「渲染后正文」（marker 已替换为引用块），原样带占位块、
    // 不带裸 marker——与页面渲染同形，不回退成未渲染的原文。
    expect(payload.bodyMd).toBe(
      `段一\n\n> **引用 · 未找到快照** \`${REF_SOURCE_QUOTE}\`\n\n段二`,
    );
  });
});

// ── 三态引用块 ─────────────────────────────────────────────────────────────

describe("引用块三态", () => {
  const body = `[[ref:${REF_SOURCE}]]`;

  it("renders current references from stored snapshot and marks captured time", async () => {
    repos = fakeRepos({ note: noteRow({ body_md: body }), refRows: [refRow()] });
    service = makeService(repos, (rows) => [
      preview(rows[0]!.id, "current", sourceSnapshot("来源标题", "来源摘要")),
    ]);
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    expect(result.markdown).toContain("status=current");
    expect(result.markdown).toContain("来源标题");
    expect(result.markdown).toContain("来源摘要");
    expect(result.markdown).toContain(CAPTURED_AT);
    expect(result.markdown).toContain("引用时间");
  });

  it("renders changed references from stored snapshot and marks captured time", async () => {
    repos = fakeRepos({ note: noteRow({ body_md: body }), refRows: [refRow()] });
    service = makeService(repos, (rows) => [
      preview(rows[0]!.id, "changed", sourceQuoteSnapshot("旧标题", "历史摘录内容"), {
        liveTitle: "新标题",
      }),
    ]);
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    expect(result.markdown).toContain("status=changed");
    // 已存快照的旧摘录/旧标题必须在场（历史证据）
    expect(result.markdown).toContain("历史摘录内容");
    expect(result.markdown).toContain("旧标题");
    // 对照用的新标题标注为「当前来源」，不得替换历史摘录
    expect(result.markdown).toContain("当前来源");
    expect(result.markdown).toContain("新标题");
    expect(result.markdown).toContain(CAPTURED_AT);

    const json = extractLastJsonBlock(result.markdown);
    const references = json["references"] as Array<Record<string, unknown>>;
    expect(references[0]!["status"]).toBe("changed");
    expect(references[0]!["capturedAt"]).toBe(CAPTURED_AT);
    expect(references[0]!["liveTitle"]).toBe("新标题");
    // 历史摘录仍是快照值，未被新文本替换
    expect(references[0]!["displaySnapshot"]).toEqual(sourceQuoteSnapshot("旧标题", "历史摘录内容"));
  });

  it("renders unavailable references as placeholders from stored snapshot", async () => {
    repos = fakeRepos({ note: noteRow({ body_md: body }), refRows: [refRow()] });
    service = makeService(repos, (rows) => [
      preview(rows[0]!.id, "unavailable", sourceQuoteSnapshot("已删来源", "仍保留的旧摘录"), {
        liveTitle: null,
      }),
    ]);
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    expect(result.markdown).toContain("status=unavailable");
    expect(result.markdown).toContain("目标已不可用");
    expect(result.markdown).toContain("仍保留的旧摘录");
    expect(result.markdown).toContain(CAPTURED_AT);
    const json = extractLastJsonBlock(result.markdown);
    const references = json["references"] as Array<Record<string, unknown>>;
    expect(references[0]!["status"]).toBe("unavailable");
    expect(references[0]!["liveTitle"]).toBeNull();
  });

  it("renders captured time for every reference block", async () => {
    const rows = [
      refRow({ id: REF_SOURCE, captured_at: "2026-09-19T01:00:00.000Z" }),
      refRow({
        id: REF_SOURCE_QUOTE, kind: "source_quote", quote_snapshot: "摘录",
        start_offset: 0, end_offset: 2, captured_at: "2026-09-19T02:00:00.000Z",
        display_snapshot: asJson(sourceQuoteSnapshot("来源", "摘录")),
      }),
    ];
    const body = `[[ref:${REF_SOURCE}]]\n\n[[ref:${REF_SOURCE_QUOTE}]]`;
    repos = fakeRepos({ note: noteRow({ body_md: body }), refRows: rows });
    service = makeService(repos, (all) => defaultResolve(all));
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    expect(result.markdown).toContain("2026-09-19T01:00:00.000Z");
    expect(result.markdown).toContain("2026-09-19T02:00:00.000Z");
    expect(result.markdown).toContain("引用时间");
  });
});

// ── B6：五种引用 kind ──────────────────────────────────────────────────────

describe("五种引用 kind", () => {
  it("renders each of the five reference kinds", async () => {
    const cases: Array<{
      label: string;
      id: string;
      snapshot: ReferenceDisplaySnapshot;
      rowOverrides: Partial<L3StudyNoteReferenceRow>;
      /** 引用块内必须出现的可读文本（kind 由中文标签承载）。 */
      expected: string[];
      /** 该 kind 的中文标签（渲染块头部）。 */
      label_zh: string;
    }> = [
      {
        label: "source",
        label_zh: "引用 · 来源",
        id: REF_SOURCE,
        snapshot: sourceSnapshot("来源标题甲", "来源摘要甲"),
        rowOverrides: { id: REF_SOURCE, kind: "source", source_id: SOURCE },
        expected: ["来源标题甲", "来源摘要甲"],
      },
      {
        label: "source_quote",
        label_zh: "引用 · 来源摘录",
        id: REF_SOURCE_QUOTE,
        snapshot: sourceQuoteSnapshot("来源标题乙", "来源摘录乙"),
        rowOverrides: {
          id: REF_SOURCE_QUOTE, kind: "source_quote", source_id: SOURCE,
          start_offset: 0, end_offset: 4, quote_snapshot: "来源摘录乙",
        },
        expected: ["来源标题乙", "来源摘录乙"],
      },
      {
        label: "question",
        label_zh: "引用 · 题目",
        id: REF_QUESTION,
        snapshot: questionSnapshot({ stem: "题干甲？", options: [{ key: "A", text: "选项甲" }] }),
        rowOverrides: { id: REF_QUESTION, kind: "question", source_id: null, question_id: QUESTION },
        expected: ["题干甲？", "选项甲"],
      },
      {
        label: "stem_quote",
        label_zh: "引用 · 题干摘录",
        id: REF_STEM_QUOTE,
        snapshot: stemQuoteSnapshot("题干摘录丙"),
        rowOverrides: {
          id: REF_STEM_QUOTE, kind: "stem_quote", source_id: null, question_id: QUESTION,
          start_offset: 0, end_offset: 4, quote_snapshot: "题干摘录丙",
        },
        expected: ["题干摘录丙"],
      },
      {
        label: "option_quote",
        label_zh: "引用 · 选项摘录",
        id: REF_OPTION_QUOTE,
        snapshot: optionQuoteSnapshot("B", "选项摘录丁"),
        rowOverrides: {
          id: REF_OPTION_QUOTE, kind: "option_quote", source_id: null, question_id: QUESTION,
          option_key: "B", start_offset: 0, end_offset: 4, quote_snapshot: "选项摘录丁",
        },
        expected: ["选项摘录丁", "选项 B"],
      },
    ];

    for (const testCase of cases) {
      const row = refRow(testCase.rowOverrides);
      const body = `[[ref:${testCase.id}]]`;
      const localRepos = fakeRepos({ note: noteRow({ body_md: body }), refRows: [row] });
      const localService = makeService(localRepos, (rows) => [
        preview(rows[0]!.id, "current", testCase.snapshot),
      ]);
      const result = await localService.export(userId(), NOTE, { expectedVersion: 3 });

      // 引用块：中文 kind 标签 + 该 kind 的展示快照正文
      const block = fenceBlocks(section(result.markdown, "正文"))[0]!;
      expect(block.body, `${testCase.label} 引用块应带 ${testCase.label_zh}`)
        .toContain(testCase.label_zh);
      for (const needle of testCase.expected) {
        expect(block.body, `${testCase.label} 应包含 ${needle}`).toContain(needle);
      }
      // JSON 块：kind 字段冻结为英文枚举值，恰一条引用
      const json = extractLastJsonBlock(result.markdown);
      const references = json["references"] as Array<Record<string, unknown>>;
      expect(references.length, `${testCase.label} 应恰有一条引用`).toBe(1);
      expect(references[0]!["kind"]).toBe(testCase.label);
      expect((references[0]!["displaySnapshot"] as { kind: string }).kind).toBe(testCase.label);
    }
  });

  it("reference ids in body match reference ids in json block", async () => {
    const rows = [
      refRow({ id: REF_SOURCE, captured_at: "2026-09-19T01:00:00.000Z" }),
      refRow({
        id: REF_SOURCE_QUOTE, kind: "source_quote", captured_at: "2026-09-19T02:00:00.000Z",
        start_offset: 0, end_offset: 2, quote_snapshot: "摘",
        display_snapshot: asJson(sourceQuoteSnapshot("来源", "摘")),
      }),
    ];
    const body = `[[ref:${REF_SOURCE}]]\n\n[[ref:${REF_SOURCE_QUOTE}]]`;
    repos = fakeRepos({ note: noteRow({ body_md: body }), refRows: rows });
    service = makeService(repos, (all) => defaultResolve(all));
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    const json = extractLastJsonBlock(result.markdown);
    const jsonIds = (json["references"] as Array<Record<string, unknown>>).map((r) => r["referenceId"]);
    expect(jsonIds).toEqual([REF_SOURCE, REF_SOURCE_QUOTE]);
    // 集合与顺序一致、无重复（同一真源）
    expect(new Set(jsonIds).size).toBe(jsonIds.length);
    const bodyBlock = fenceBlocks(section(result.markdown, "正文"))[0]!;
    expect(bodyBlock.body.indexOf(REF_SOURCE)).toBeLessThan(bodyBlock.body.indexOf(REF_SOURCE_QUOTE));
    // 来源清单按 capturedAt 升序（与正文出现顺序在此例中一致）
    const sources = section(result.markdown, "来源清单");
    expect(sources.indexOf(REF_SOURCE)).toBeLessThan(sources.indexOf(REF_SOURCE_QUOTE));
  });
});

// ── A3：中文 ───────────────────────────────────────────────────────────────

describe("中文", () => {
  it("renders chinese citation titles and quotes", async () => {
    const body = `[[ref:${REF_SOURCE_QUOTE}]]`;
    repos = fakeRepos({
      note: noteRow({ title: "中文笔记标题", body_md: body }),
      refRows: [refRow({
        id: REF_SOURCE_QUOTE, kind: "source_quote", start_offset: 0, end_offset: 6,
        quote_snapshot: "中文摘录内容", display_snapshot: asJson(sourceQuoteSnapshot("中文来源标题", "中文摘录内容")),
      })],
    });
    service = makeService(repos, (rows) => [
      preview(rows[0]!.id, "current", sourceQuoteSnapshot("中文来源标题", "中文摘录内容")),
    ]);
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    expect(result.markdown).toContain("中文笔记标题");
    expect(result.markdown).toContain("中文来源标题");
    expect(result.markdown).toContain("中文摘录内容");
    // 无乱码替换字符
    expect(result.markdown).not.toContain("\uFFFD");
    const json = extractLastJsonBlock(result.markdown);
    // bodyMd 是渲染后的正文（marker 已替换），快照里的中文必须逐字保真
    expect(json["bodyMd"]).toContain("中文摘录内容");
    expect((json["references"] as Array<{ displaySnapshot: unknown }>)[0]!.displaySnapshot)
      .toEqual(sourceQuoteSnapshot("中文来源标题", "中文摘录内容"));
    expect(result.markdown).toContain("## 来源清单");
  });
});

// ── A2：恶意 HTML ──────────────────────────────────────────────────────────

describe("恶意 HTML 与围栏安全", () => {
  it("preserves raw html inside fenced blocks without escaping surface", async () => {
    const malicious = [
      "<script>alert('xss')</script>",
      "<img src=x onerror=\"alert('xss')\">",
      "</div></body></html>",
      "<iframe src=\"javascript:alert(1)\"></iframe>",
    ].join("\n");
    repos = fakeRepos({ note: noteRow({ body_md: `${malicious}\n\n尾段。` }), refRows: [] });
    service = makeService();
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    // 原样保留在围栏内
    expect(result.markdown).toContain("<script>alert('xss')</script>");
    expect(result.markdown).toContain("</div></body></html>");

    // 不得破出结构：HTML 只出现在正文围栏块内，且围栏长度大于内容最长反引号串
    const bodyBlock = fenceBlocks(section(result.markdown, "正文"))[0]!;
    expect(bodyBlock.body).toContain("<script>alert('xss')</script>");
    expect(bodyBlock.fence.length).toBeGreaterThan(longestBacktickRun(malicious));
    // 围栏内的任意一行都不等于围栏（内容未能提前闭合围栏）
    expect(bodyBlock.body.split("\n").includes(bodyBlock.fence)).toBe(false);
    // 恶意闭合标签没有出现在正文围栏之外
    const afterBody = section(result.markdown, "来源清单");
    expect(afterBody).not.toContain("</body></html>");
  });

  it("renders fences longer than the longest backtick run", async () => {
    const cases = ["`", "```", "`````", "````````", "混合 ``` 与 `` 与 ` 的文本"];
    for (const snippet of cases) {
      const body = `片段 A：${snippet}\n\n片段 B：${snippet}`;
      repos = fakeRepos({ note: noteRow({ body_md: body }), refRows: [] });
      service = makeService();
      const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

      const jsonText = JSON.stringify(
        (extractLastJsonBlock(result.markdown) as unknown),
        null,
        2,
      );
      const jsonFence = jsonOpeningFence(result.markdown);
      expect(jsonFence.length).toBeGreaterThan(longestBacktickRun(jsonText));

      const bodyBlock = fenceBlocks(section(result.markdown, "正文"))[0]!;
      expect(bodyBlock.fence.length).toBeGreaterThan(longestBacktickRun(body));
    }
  });

  it("fenceFor returns at least three backticks and exceeds the longest run", () => {
    // 先例口径：max(3, 最长反引号串 + 1)
    expect(fenceFor("无围栏")).toBe("```");
    expect(fenceFor("`")).toBe("```");
    expect(fenceFor("``")).toBe("```");
    expect(fenceFor("```")).toBe("````");
    expect(fenceFor("````")).toBe("`````");
    expect(fenceFor("预围栏 ``` 三连")).toBe("````");
    expect(fenceFor("`````")).toBe("``````");
  });

  it("keeps json payload parseable when body and snapshots contain fences", async () => {
    const nasty = "`````json\n{\"a\": 1}\n`````";
    repos = fakeRepos({
      note: noteRow({ body_md: nasty }),
      refRows: [refRow({ display_snapshot: asJson(sourceSnapshot("来源 ```", "摘录 `````")) })],
    });
    service = makeService(repos, (rows) => [
      preview(rows[0]!.id, "current", sourceSnapshot("来源 ```", "摘录 `````")),
    ]);
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });
    const json = extractLastJsonBlock(result.markdown);
    expect(json["bodyMd"]).toBe(nasty);
    expect(json["bodySha256"]).toBe(
      createHash("sha256").update(nasty, "utf8").digest("hex"),
    );
  });
});

// ── A4：归档笔记 ───────────────────────────────────────────────────────────

describe("归档笔记", () => {
  it("exports archived notes with status marked", async () => {
    repos = fakeRepos({
      note: noteRow({ status: "archived", body_md: "归档正文。" }),
      refRows: [],
    });
    service = makeService();
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    expect(result.markdown).toContain("archived");
    const json = extractLastJsonBlock(result.markdown);
    const payload = json as unknown as StudyNoteExportPayload;
    expect(payload.note.status).toBe("archived");
    expect(payload.bodyMd).toBe("归档正文。");
    expect(result.version).toBe(3);
  });
});

// ── A14/B8：双段 hash ─────────────────────────────────────────────────────

describe("双段 hash", () => {
  it("sha256 recomputes after deleting the checksum line", async () => {
    repos = fakeRepos({ note: noteRow({ body_md: "正文" }), refRows: [] });
    service = makeService();
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(recomputeSha(result.markdown)).toBe(result.sha256);
    // 校验行携带同值
    expect(result.markdown).toContain(`- 内容校验: sha256:${result.sha256}（删除本行后可复算）`);
  });

  it("recomputable hash holds for renderer output with references", () => {
    const body = `[[ref:${REF_SOURCE}]]`;
    const payload: StudyNoteExportPayload = {
      exportSchemaVersion: STUDY_NOTE_EXPORT_SCHEMA_VERSION,
      kind: STUDY_NOTE_EXPORT_ARTIFACT_TYPE,
      exportedAt: "2026-09-22T00:00:00.000Z",
      note: {
        id: NOTE, title: "标题", status: "active", pinned: false, version: 3,
        venues: ["reading_choice"],
      },
      references: [
        {
          referenceId: REF_SOURCE, kind: "source", status: "current",
          capturedAt: CAPTURED_AT,
          displaySnapshot: sourceSnapshot("来源标题", "来源摘要"),
          target: { sourceId: SOURCE },
          liveTitle: null,
        },
      ],
      bodyMd: body,
      bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    };
    const rendered = renderStudyNoteExportMarkdown({ payload, bodyMd: body });
    expect(recomputeSha(rendered.markdown)).toBe(rendered.sha256);
  });
});

// ── A6/P2：JSON 块字段冻结 ────────────────────────────────────────────────

describe("JSON 块", () => {
  it("emits a parseable json block with frozen fields", async () => {
    repos = fakeRepos({ note: noteRow({ body_md: "正文" }), refRows: [] });
    service = makeService();
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });
    const json = extractLastJsonBlock(result.markdown);

    for (const field of FROZEN_JSON_FIELDS) {
      expect(Object.keys(json), `JSON 块应含冻结字段 ${field}`).toContain(field);
    }
    expect(json["exportSchemaVersion"]).toBe(1);
    expect(json["kind"]).toBe("study-note");
    expect(typeof json["exportedAt"]).toBe("string");
    expect(json["note"]).toEqual({
      id: NOTE, title: "我的笔记", status: "active", pinned: false, version: 3,
      venues: ["reading_choice"],
    });
    const bodyMd = json["bodyMd"] as string;
    expect(json["bodySha256"]).toBe(createHash("sha256").update(bodyMd, "utf8").digest("hex"));
  });

  it("emits reference target coordinates in camelCase frozen shape", async () => {
    repos = fakeRepos({
      note: noteRow({ body_md: `[[ref:${REF_OPTION_QUOTE}]]` }),
      refRows: [refRow({
        id: REF_OPTION_QUOTE, kind: "option_quote", source_id: null, question_id: QUESTION,
        option_key: "B", start_offset: 3, end_offset: 7, quote_snapshot: "摘录乙",
        display_snapshot: asJson(optionQuoteSnapshot("B", "摘录乙")),
      })],
    });
    service = makeService(repos, (rows) => defaultResolve(rows));
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });
    const json = extractLastJsonBlock(result.markdown);
    const references = json["references"] as Array<Record<string, unknown>>;

    expect(references[0]!["referenceId"]).toBe(REF_OPTION_QUOTE);
    expect(references[0]!["kind"]).toBe("option_quote");
    expect(references[0]!["target"]).toEqual({
      questionId: QUESTION, optionKey: "B", startOffset: 3, endOffset: 7,
    });
    expect(references[0]!["capturedAt"]).toBe(CAPTURED_AT);
  });
});

// ── A8/P2：无标准答案字段 ─────────────────────────────────────────────────

describe("无标准答案面字段（P2 边界）", () => {
  // 与实现共享同一清单（单真源）：实现侧若新增答案面字段，扫描自动覆盖。
  const ANSWER_FIELD_NAMES = FORBIDDEN_ANSWER_FIELD_NAMES;
  const ANSWER_VALUES = [
    "ANSWER_SENTINEL", "EXPLANATION_SENTINEL", "EVIDENCE_SENTINEL", "MARKING_SENTINEL",
    "标准答案甲", "官方解析甲", "判分标准甲",
  ];

  it("never emits answer or evidence fields in markdown or json", async () => {
    // 目标题的活体对象带标准答案面字段——导出必须在快照边界处切断，不得回填。
    const poisonedSnapshot = {
      ...questionSnapshot({ stem: "题干甲？" }),
      answer: "ANSWER_SENTINEL",
      answerIndex: 0,
      correctOption: "A",
      explanation: "EXPLANATION_SENTINEL",
      evidence: [{ start: 0, end: 3, label: "EVIDENCE_SENTINEL" }],
      marking: "MARKING_SENTINEL",
      grading: { verdict: "MARKING_SENTINEL" },
      selfAssessment: "标准答案甲",
      solution: "官方解析甲",
    } as unknown as ReferenceDisplaySnapshot;

    repos = fakeRepos({
      note: noteRow({ body_md: `[[ref:${REF_QUESTION}]]` }),
      refRows: [refRow({
        id: REF_QUESTION, kind: "question", source_id: null, question_id: QUESTION,
        display_snapshot: asJson(poisonedSnapshot),
      })],
    });
    service = makeService(repos, (rows) => [
      preview(rows[0]!.id, "current", poisonedSnapshot),
    ]);
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    const json = extractLastJsonBlock(result.markdown);
    const jsonText = JSON.stringify(json);
    const references = json["references"] as Array<Record<string, unknown>>;
    const questionRef = references.find((ref) => ref["kind"] === "question")!;
    // 只取 question 引用块（正文围栏内的那一段），避免误扫其他 kind 的块
    const bodyBlock = fenceBlocks(section(result.markdown, "正文"))[0]!;
    const questionBlock = bodyBlock.body.split("> **引用 · ")[1] ?? "";

    // 1) question 引用块内不得出现任何答案面字段名
    for (const field of ANSWER_FIELD_NAMES) {
      expect(questionBlock.toLowerCase(), `引用块不得出现字段名 ${field}`)
        .not.toContain(field.toLowerCase());
    }
    // 2) 全文（含 JSON 块）不得出现任何答案面取值
    for (const value of Object.values(ANSWER_VALUES)) {
      expect(result.markdown, `产物不得出现答案面取值 ${value}`).not.toContain(value);
    }
    // 3) question 快照逐项不得携带答案键
    const snapshot = questionRef["displaySnapshot"] as Record<string, unknown>;
    expect(snapshot).toEqual(questionSnapshot({ stem: "题干甲？" }));
    for (const field of ANSWER_FIELD_NAMES) {
      expect(snapshot, `question 快照不得含 ${field}`).not.toHaveProperty(field);
    }
    // 4) options 逐项只有 key/text
    for (const option of snapshot["options"] as Array<Record<string, unknown>>) {
      expect(Object.keys(option).sort()).toEqual(["key", "text"]);
    }
    // 5) 引用块仍证明题目本体在场（不是靠整体丢弃通过）
    expect(questionBlock).toContain("题干甲？");
    expect(questionBlock).toContain("第一项");
    // 6) JSON 键名扫描（递归）——只用不与正常冻结字段冲突的复合名，避免子串误报
    const collectKeys = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.flatMap(collectKeys);
      if (value && typeof value === "object") {
        return Object.entries(value as Record<string, unknown>)
          .flatMap(([key, child]) => [key, ...collectKeys(child)]);
      }
      return [];
    };
    const allKeys = collectKeys(json);
    const forbiddenKeySubstrings = [
      "answer", "answerindex", "correctoption", "explanation", "evidence",
      "markingscheme", "selfassessment", "officialanswer", "gradingscheme",
    ];
    for (const needle of forbiddenKeySubstrings) {
      expect(allKeys, `JSON 不得含含 ${needle} 的键`).not.toContain(needle);
    }
    for (const key of allKeys) {
      expect(forbiddenKeySubstrings.some((needle) => key.toLowerCase().includes(needle)),
        `JSON 键 ${key} 命中答案面`).toBe(false);
    }
    expect(jsonText).not.toContain("ANSWER_SENTINEL");
  });
});

// ── A9：FOR SHARE 锁与事务 ────────────────────────────────────────────────

describe("锁与事务", () => {
  it("locks the note with for share inside the actor transaction", async () => {
    repos = fakeRepos({ note: noteRow({ body_md: "正文" }), refRows: [] });
    service = makeService();
    await service.export(userId(), NOTE, { expectedVersion: 3 });

    // 导出在同一 actor 事务内取共享锁
    expect(repos.studyNotes.lockForShare).toHaveBeenCalledTimes(1);
    expect(repos.studyNotes.lockForShare).toHaveBeenCalledWith(USER, NOTE);
    expect(txCalls).toEqual([{ actorId: USER }]);
    // 保存路径的 FOR UPDATE 行锁不得被导出复用（方法身份断言）
    expect(repos.studyNotes.lock).not.toHaveBeenCalled();
  });

  it("reads note, venues and references from the same transaction", async () => {
    repos = fakeRepos({
      note: noteRow({ body_md: `[[ref:${REF_SOURCE}]]` }),
      venues: ["reading_choice", "cloze"],
      refRows: [refRow()],
    });
    service = makeService();
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    expect(repos.studyNotes.listVenues).toHaveBeenCalledWith(USER, NOTE);
    expect(repos.studyReferences.listForNote).toHaveBeenCalledWith(USER, NOTE);
    const json = extractLastJsonBlock(result.markdown);
    expect((json["note"] as Record<string, unknown>)["venues"]).toEqual(["cloze", "reading_choice"]);
  });
});

// ── A10/A5：消费已存快照，不用活体文本 ────────────────────────────────────

describe("快照真源", () => {
  it("uses stored snapshots and capturedAt instead of live target text", async () => {
    // 已存快照是历史摘录；resolve 返回的 status 是 changed（活体已变）。
    // 导出的摘录必须是历史值；活体新文本只在「当前来源」对照出现。
    repos = fakeRepos({
      note: noteRow({ body_md: `[[ref:${REF_SOURCE_QUOTE}]]` }),
      refRows: [refRow({
        id: REF_SOURCE_QUOTE, kind: "source_quote", start_offset: 0, end_offset: 6,
        quote_snapshot: "历史摘录甲", display_snapshot: asJson(sourceQuoteSnapshot("历史标题", "历史摘录甲")),
      })],
    });
    service = makeService(repos, (rows) => [
      preview(rows[0]!.id, "changed", sourceQuoteSnapshot("历史标题", "历史摘录甲"), {
        liveTitle: "活体新标题",
      }),
    ]);
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    expect(result.markdown).toContain("历史摘录甲");
    expect(result.markdown).toContain("活体新标题");
    const json = extractLastJsonBlock(result.markdown);
    const references = json["references"] as Array<Record<string, unknown>>;
    expect(references[0]!["displaySnapshot"]).toEqual(sourceQuoteSnapshot("历史标题", "历史摘录甲"));
    expect(references[0]!["capturedAt"]).toBe(CAPTURED_AT);
    // 行内列（quote_snapshot / start_offset / end_offset）与快照同源，且未按新文本重定位
    expect(references[0]!["target"]).toEqual({ sourceId: SOURCE, startOffset: 0, endOffset: 6 });
  });

  it("never substitutes the live target text for the stored excerpt", async () => {
    // 变异守护（M7）：活体文本只作「当前来源」对照，出现次数必须恰为 1；
    // 已存摘录必须在引用块正文/来源清单/JSON 快照三处都保持历史值。
    repos = fakeRepos({
      note: noteRow({ body_md: `[[ref:${REF_SOURCE_QUOTE}]]` }),
      refRows: [refRow({
        id: REF_SOURCE_QUOTE, kind: "source_quote", start_offset: 0, end_offset: 6,
        quote_snapshot: "历史摘录甲",
        display_snapshot: asJson(sourceQuoteSnapshot("历史标题", "历史摘录甲")),
      })],
    });
    service = makeService(repos, (rows) => [
      preview(rows[0]!.id, "changed", sourceQuoteSnapshot("历史标题", "历史摘录甲"), {
        liveTitle: "活体新标题",
      }),
    ]);
    const result = await service.export(userId(), NOTE, { expectedVersion: 3 });

    const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

    // 活体新文本只允许出现在「当前来源」对照行（正文段内恰一次）与 JSON 的
    // liveTitle / bodyMd 回写中；不得出现在任何已存快照位。
    expect(result.markdown).toContain("> 当前来源: 活体新标题");
    const blockBody = fenceBlocks(section(result.markdown, "正文"))[0]!.body;
    expect(occurrences(blockBody, "活体新标题")).toBe(1);
    // 已存摘录在产物中只出现在注释位（正文段 + JSON bodyMd 回写），不被活体文本顶替
    expect(occurrences(result.markdown, "历史摘录甲")).toBeGreaterThanOrEqual(2);

    // 引用块内只有已存摘录 + 已存标题
    const block = fenceBlocks(section(result.markdown, "正文"))[0]!;
    expect(occurrences(block.body, "历史摘录甲")).toBe(2); // 已存快照行 + 摘录行
    expect(occurrences(block.body, "历史标题")).toBe(1);
    expect(block.body).toContain("未按目标当前文本替换");

    // 来源清单仍按已存快照标注
    expect(section(result.markdown, "来源清单")).toContain("来源摘录");

    // JSON 快照逐字为已存值；活体文本只出现在 liveTitle 字段
    const references = extractLastJsonBlock(result.markdown)["references"] as Array<Record<string, unknown>>;
    expect(references[0]!["displaySnapshot"]).toEqual(sourceQuoteSnapshot("历史标题", "历史摘录甲"));
    expect(references[0]!["liveTitle"]).toBe("活体新标题");
    expect(JSON.stringify(references[0]!["displaySnapshot"])).not.toContain("活体新标题");
  });
});

// ── P3：expectedVersion 合同 ──────────────────────────────────────────────

describe("expectedVersion 合同（P3）", () => {
  it("rejects missing expectedVersion with ValidationError", async () => {
    repos = fakeRepos();
    service = makeService();
    const error = await service
      .export(userId(), NOTE, {} as { expectedVersion?: number })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).field).toBe("expectedVersion");
  });

  it("rejects stale expectedVersion with 409 and currentVersion only", async () => {
    repos = fakeRepos({ note: noteRow({ version: 5, body_md: "服务器正文" }) });
    service = makeService();
    const error = await service.export(userId(), NOTE, { expectedVersion: 3 }).catch((e) => e);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).meta).toEqual({ noteId: NOTE, currentVersion: 5 });
    // 409 不得回传服务器正文
    expect(JSON.stringify((error as ConflictError).meta)).not.toContain("服务器正文");
  });

  it("accepts expectedVersion for archived notes (no exemption)", async () => {
    repos = fakeRepos({ note: noteRow({ status: "archived", version: 5 }), refRows: [] });
    service = makeService();
    await expect(service.export(userId(), NOTE, { expectedVersion: 4 })).rejects.toThrow(ConflictError);
  });

  it("throws NotFoundError when the note does not exist or is not owned", async () => {
    repos = fakeRepos({ note: null });
    service = makeService();
    await expect(service.export(userId(), NOTE, { expectedVersion: 1 })).rejects.toThrow(NotFoundError);
    expect(repos.studyReferences.listForNote).not.toHaveBeenCalled();
  });
});

// ── B9/B10/B12：零业务写入 ────────────────────────────────────────────────

describe("只读纪律（零业务写入）", () => {
  it("export performs no business data write", async () => {
    repos = fakeRepos({
      note: noteRow({ body_md: `[[ref:${REF_SOURCE}]]` }),
      refRows: [refRow()],
    });
    service = makeService(repos, (rows) => defaultResolve(rows));

    await service.export(userId(), NOTE, { expectedVersion: 3 });

    // 写面探针（被调用即抛错）全部零调用：无 INSERT/UPDATE/DELETE 路径可走
    expect(repos.studyNotes.create).not.toHaveBeenCalled();
    expect(repos.studyNotes.createIfAbsent).not.toHaveBeenCalled();
    expect(repos.studyNotes.updateIfVersion).not.toHaveBeenCalled();
    expect(repos.studyNotes.replaceVenues).not.toHaveBeenCalled();
    expect(repos.studyReferences.replaceForNote).not.toHaveBeenCalled();
    expect(repos.studyReferences.lockTargets).not.toHaveBeenCalled();
    // 不取写锁：只取共享读锁
    expect(repos.studyNotes.lock).not.toHaveBeenCalled();
  });

  it("contains no write SQL anywhere in the export service module", async () => {
    // 源码级断言：导出模块内不得存在任何写语句（INSERT/UPDATE/DELETE/upsert），
    // 也不得调用题纸/作答入口——只读是结构性的，不只靠 fake 探针。
    const source = await readFile(serviceModulePath(), "utf8");
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    for (const keyword of ["INSERT INTO", "DELETE FROM", "UPDATE l3_", "ON CONFLICT", "now()"]) {
      expect(withoutComments, `导出模块不得含写语句 ${keyword}`).not.toContain(keyword);
    }
    expect(withoutComments).not.toContain("openSheet");
    expect(withoutComments).not.toContain("replaceForNote");
    expect(withoutComments).not.toContain("updateIfVersion");
  });

  it("emits a structured manifest log line with id, version, sha256 and reference count", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    try {
      repos = fakeRepos({
        note: noteRow({ body_md: `[[ref:${REF_SOURCE}]]`, version: 7 }),
        refRows: [refRow()],
      });
      service = makeService(repos, (rows) => defaultResolve(rows));
      const result = await service.export(userId(), NOTE, { expectedVersion: 7 });

      const call = infoSpy.mock.calls.find(([scope]) => scope === "l3-study-note-export");
      expect(call, "导出必须留下 manifest 日志行").toBeDefined();
      const meta = call![2] as Record<string, unknown>;
      expect(meta["noteId"]).toBe(NOTE);
      expect(meta["userId"]).toBe(USER);
      expect(meta["version"]).toBe(7);
      expect(meta["sha256"]).toBe(result.sha256);
      expect(meta["referenceCount"]).toBe(1);
      expect(meta["schemaVersion"]).toBe(1);
      expect(typeof meta["exportedAt"]).toBe("string");
    } finally {
      infoSpy.mockRestore();
    }
  });
});


describe("N2 导出 v2（P4 显式版本 · 验收 V-9…V-14）", () => {
  const ASSESSMENT = "00000000-0000-4000-8000-000000000221";
  const REF_ASSESSMENT = "00000000-0000-4000-8000-000000000006";

  function assessmentRow(): L3StudyNoteReferenceRow {
    return refRow({
      id: REF_ASSESSMENT,
      kind: "assessment",
      source_id: null,
      question_id: QUESTION,
      assessment_id: ASSESSMENT,
      start_offset: null,
      end_offset: null,
      quote_snapshot: null,
      display_snapshot: asJson({
        kind: "assessment",
        excerpt: "评析摘要",
        questionType: "reading_choice",
        sourceTitle: "Fox source",
      }),
    });
  }

  function noteWithAssessmentBody(): string {
    return ["前言。", "", `[[ref:${REF_ASSESSMENT}]]`, "", "后语。"].join("\n");
  }

  async function versionOf(fake: FakeRepos): Promise<number> {
    const lock = fake.studyNotes.lockForShare as unknown as () => Promise<{ version: number }>;
    const note = await lock();
    return note.version;
  }

  function fakeWithAssessment(): FakeRepos {
    const fake = fakeRepos({ refRows: [assessmentRow()] });
    // 正文带 marker：引用只有真正被渲染进正文才进来源清单（既有口径）。
    fake.studyNotes.lockForShare = vi.fn(async () => noteRow({ body_md: noteWithAssessmentBody() })) as never;
    return fake;
  }

  it("schemaVersion=2：payload 用 renderedBodyMarkdown、target 带 kind 判别，且不再出现 bodyMd", async () => {
    const fake = fakeWithAssessment();
    const serviceV2 = makeService(fake);
    const result = await serviceV2.export(USER, NOTE, {
      expectedVersion: await versionOf(fake),
      schemaVersion: 2,
    });

    expect(result.schemaVersion).toBe(2);
    const payload = extractLastJsonBlock(result.markdown) as Record<string, any>;
    expect(payload.exportSchemaVersion).toBe(2);
    expect(typeof payload.renderedBodyMarkdown).toBe("string");
    expect(payload).not.toHaveProperty("bodyMd");
    expect(payload.references[0].target).toEqual({
      kind: "assessment",
      questionId: QUESTION,
      assessmentId: ASSESSMENT,
    });
    expect(payload.references[0].kind).toBe("assessment");
  });

  it("v2 双段 hash 可复算，且标准答案面字段不出现（V-13/V-14）", async () => {
    const fake = fakeWithAssessment();
    const serviceV2 = makeService(fake);
    const result = await serviceV2.export(USER, NOTE, {
      expectedVersion: await versionOf(fake),
      schemaVersion: 2,
    });

    expect(recomputeSha(result.markdown)).toBe(result.sha256);
    const payload = extractLastJsonBlock(result.markdown) as Record<string, any>;
    const text = JSON.stringify(payload);
    for (const forbidden of FORBIDDEN_ANSWER_FIELD_NAMES) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("同一笔记显式请求 v1：N2 引用型不静默降级，直接 422 并指明显式选 v2（V-9/V-10）", async () => {
    const fake = fakeWithAssessment();
    const serviceV1 = makeService(fake);
    const error = await serviceV1
      .export(USER, NOTE, { expectedVersion: await versionOf(fake), schemaVersion: 1 })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ValidationError);
    // 不切版本、不丢引用——正文与 payload 一律不产出
    expect((error as { field?: string }).field).toBe("schemaVersion");
  });

  it("v1 通道不受 v2 影响：纯 N1 引用的笔记按 v1 导出仍是冻结形状（V-15）", async () => {
    const fake = fakeRepos({ refRows: [refRow()] });
    const body = ["第一段。", "", `[[ref:${REF_SOURCE}]]`, "", "第二段。"].join("\n");
    fake.studyNotes.lockForShare = vi.fn(async () => noteRow({ body_md: body })) as never;
    const serviceV1 = makeService(fake);
    const result = await serviceV1.export(USER, NOTE, {
      expectedVersion: await versionOf(fake),
      schemaVersion: 1,
    });

    expect(result.schemaVersion).toBe(1);
    const payload = extractLastJsonBlock(result.markdown) as Record<string, any>;
    expect(payload.exportSchemaVersion).toBe(1);
    expect(payload).toHaveProperty("bodyMd");
    expect(payload).not.toHaveProperty("renderedBodyMarkdown");
    // v1 target 冻结：不带 kind 判别字段
    expect(payload.references[0].target).toEqual({ sourceId: SOURCE });
  });

  it("v2 对 N1 五种引用型一律带 kind 判别（V-11：v2 不是评析专用通道）", async () => {
    const rows: L3StudyNoteReferenceRow[] = [
      refRow({
        id: REF_SOURCE, kind: "source", source_id: SOURCE, question_id: null,
        display_snapshot: asJson(sourceSnapshot("来源标题", "来源摘要")),
      }),
      refRow({
        id: REF_SOURCE_QUOTE, kind: "source_quote", source_id: SOURCE, question_id: null,
        start_offset: 0, end_offset: 3, quote_snapshot: "The",
        display_snapshot: asJson(sourceQuoteSnapshot("来源标题", "The")),
      }),
      refRow({
        id: REF_QUESTION, kind: "question", source_id: null, question_id: QUESTION,
        display_snapshot: asJson(questionSnapshot()),
      }),
      refRow({
        id: REF_STEM_QUOTE, kind: "stem_quote", source_id: null, question_id: QUESTION,
        start_offset: 0, end_offset: 2, quote_snapshot: "下列",
        display_snapshot: asJson(stemQuoteSnapshot("下列")),
      }),
      refRow({
        id: REF_OPTION_QUOTE, kind: "option_quote", source_id: null, question_id: QUESTION,
        option_key: "A", start_offset: 0, end_offset: 1, quote_snapshot: "第",
        display_snapshot: asJson(optionQuoteSnapshot("A", "第一项")),
      }),
    ];
    // marker 只有独占一个顶层段落才被识别，故每个标记之间留空行
    const body = ["前言。", "", ...rows.flatMap((row) => [`[[ref:${row.id}]]`, ""]), "后语。"].join("\n");
    const fake = fakeRepos({ refRows: rows });
    fake.studyNotes.lockForShare = vi.fn(async () => noteRow({ body_md: body })) as never;
    const result = await makeService(fake).export(USER, NOTE, {
      expectedVersion: await versionOf(fake),
      schemaVersion: 2,
    });

    expect(result.schemaVersion).toBe(2);
    const payload = extractLastJsonBlock(result.markdown) as Record<string, any>;
    expect(payload.exportSchemaVersion).toBe(2);
    expect(payload.references.map((ref: any) => ref.target.kind)).toEqual([
      "source", "source_quote", "question", "stem_quote", "option_quote",
    ]);
    expect(payload.references[0].target).toEqual({ kind: "source", sourceId: SOURCE });
    expect(payload.references[1].target).toEqual({ kind: "source_quote", sourceId: SOURCE, startOffset: 0, endOffset: 3 });
    expect(payload.references[2].target).toEqual({ kind: "question", questionId: QUESTION });
    expect(payload.references[3].target).toEqual({ kind: "stem_quote", questionId: QUESTION, startOffset: 0, endOffset: 2 });
    expect(payload.references[4].target).toEqual({
      kind: "option_quote", questionId: QUESTION, optionKey: "A", startOffset: 0, endOffset: 1,
    });
  });

  it("schemaVersion 只接受 1/2：非法值 422 且拒绝前不做内容推断（V-10）", async () => {
    const fake = fakeWithAssessment();
    const error = await makeService(fake)
      .export(USER, NOTE, { expectedVersion: await versionOf(fake), schemaVersion: 3 as never })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as { field?: string }).field).toBe("schemaVersion");
  });
});

describe("N2 笔记互链导出（第二条垂直链 · v2 显式选版 / v1 冻结）", () => {
  const TARGET_NOTE = "00000000-0000-4000-8000-000000000231";
  const REF_NOTE = "00000000-0000-4000-8000-000000000007";

  function noteRefRow(): L3StudyNoteReferenceRow {
    return refRow({
      id: REF_NOTE,
      kind: "note",
      source_id: null,
      question_id: null,
      assessment_id: null,
      target_note_id: TARGET_NOTE,
      start_offset: null,
      end_offset: null,
      quote_snapshot: null,
      display_snapshot: asJson({
        kind: "note",
        title: "被引用笔记",
        excerpt: "被引用正文",
      }),
    });
  }

  function fakeWithNoteRef(): FakeRepos {
    const fake = fakeRepos({ refRows: [noteRefRow()] });
    const body = ["前言。", "", `[[ref:${REF_NOTE}]]`, "", "后语。"].join("\n");
    fake.studyNotes.lockForShare = vi.fn(async () => noteRow({ body_md: body })) as never;
    return fake;
  }

  async function versionOf(fake: FakeRepos): Promise<number> {
    const lock = fake.studyNotes.lockForShare as unknown as () => Promise<{ version: number }>;
    const note = await lock();
    return note.version;
  }

  it("v2：note 引用 target 带 kind 判别且只含 noteId（不递归展开目标笔记内部引用）", async () => {
    const fake = fakeWithNoteRef();
    const result = await makeService(fake).export(USER, NOTE, {
      expectedVersion: await versionOf(fake),
      schemaVersion: 2,
    });

    expect(result.schemaVersion).toBe(2);
    const payload = extractLastJsonBlock(result.markdown) as Record<string, any>;
    expect(payload.references[0].kind).toBe("note");
    expect(payload.references[0].target).toEqual({ kind: "note", noteId: TARGET_NOTE });
    // 只展开一层：快照不得携带目标笔记自身的引用集合
    expect(payload.references[0].displaySnapshot).toEqual({
      kind: "note",
      title: "被引用笔记",
      excerpt: "被引用正文",
    });
    expect(payload.references[0].displaySnapshot).not.toHaveProperty("references");
  });

  it("v1：含 note 引用的笔记显式请求 v1 → 422，不静默切版、不丢引用", async () => {
    const fake = fakeWithNoteRef();
    const error = await makeService(fake)
      .export(USER, NOTE, { expectedVersion: await versionOf(fake), schemaVersion: 1 })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as { field?: string }).field).toBe("schemaVersion");
  });

  it("v1 通道不受影响：纯 N1 引用仍按冻结形状导出（升级不改 v1）", async () => {
    const fake = fakeRepos({ refRows: [refRow()] });
    const body = ["第一段。", "", `[[ref:${REF_SOURCE}]]`, "", "第二段。"].join("\n");
    fake.studyNotes.lockForShare = vi.fn(async () => noteRow({ body_md: body })) as never;
    const result = await makeService(fake).export(USER, NOTE, {
      expectedVersion: await versionOf(fake),
      schemaVersion: 1,
    });

    expect(result.schemaVersion).toBe(1);
    const payload = extractLastJsonBlock(result.markdown) as Record<string, any>;
    expect(payload.references[0].target).toEqual({ sourceId: SOURCE });
  });
});

describe("N2 第三条链导出（sheet / attempt · v2 显式选版 / v1 冻结）", () => {
  const SHEET = "00000000-0000-4000-8000-000000000321";
  const ATTEMPT = "00000000-0000-4000-8000-000000000331";
  const REF_SHEET = "00000000-0000-4000-8000-000000000008";
  const REF_ATTEMPT = "00000000-0000-4000-8000-000000000009";

  function sheetRefRow(revisionNo: number | null): L3StudyNoteReferenceRow {
    return refRow({
      id: REF_SHEET,
      kind: "sheet",
      source_id: null,
      question_id: null,
      assessment_id: null,
      target_note_id: null,
      submission_id: SHEET,
      submission_revision_no: revisionNo,
      attempt_id: null,
      writing_task_id: null,
      start_offset: null,
      end_offset: null,
      quote_snapshot: null,
      display_snapshot: asJson({
        kind: "sheet",
        scope: "file",
        summaryExcerpt: "卷面小结",
      }),
    });
  }

  function attemptRefRow(): L3StudyNoteReferenceRow {
    return refRow({
      id: REF_ATTEMPT,
      kind: "attempt",
      source_id: null,
      question_id: null,
      assessment_id: null,
      target_note_id: null,
      submission_id: null,
      submission_revision_no: null,
      attempt_id: ATTEMPT,
      writing_task_id: null,
      start_offset: null,
      end_offset: null,
      quote_snapshot: null,
      display_snapshot: asJson({
        kind: "attempt",
        venue: "file",
        answerExcerpt: `{"value":"A"}`,
      }),
    });
  }

  async function versionOf(fake: FakeRepos): Promise<number> {
    const lock = fake.studyNotes.lockForShare as unknown as () => Promise<{ version: number }>;
    const note = await lock();
    return note.version;
  }

  it("v2：sheet 引用 target 带 kind 判别，revisionNo 显式可空（V-25）", async () => {
    for (const revisionNo of [null, 2]) {
      const fake = fakeRepos({ refRows: [sheetRefRow(revisionNo)] });
      const body = ["前言。", "", `[[ref:${REF_SHEET}]]`, ""].join("\n");
      fake.studyNotes.lockForShare = vi.fn(async () => noteRow({ body_md: body })) as never;

      const result = await makeService(fake).export(USER, NOTE, {
        expectedVersion: await versionOf(fake),
        schemaVersion: 2,
      });
      const payload = extractLastJsonBlock(result.markdown) as Record<string, any>;
      expect(payload.references[0].kind).toBe("sheet");
      expect(payload.references[0].target).toEqual({
        kind: "sheet",
        submissionId: SHEET,
        revisionNo,
      });
      // 快照白名单：只有 scope + summary 摘录，不含 answers / 评卷字段（K7 / K14）
      expect(payload.references[0].displaySnapshot).toEqual({
        kind: "sheet",
        scope: "file",
        summaryExcerpt: "卷面小结",
      });
      expect(payload.references[0].displaySnapshot).not.toHaveProperty("answers");
      // 正文引用块与来源列表同源（marker 被替换为引用块）
      expect(payload.renderedBodyMarkdown).toContain("稿次范围: file");
    }
  });

  it("v2：attempt 引用 target 只含 attemptId（K9 单值身份）", async () => {
    const fake = fakeRepos({ refRows: [attemptRefRow()] });
    const body = ["前言。", "", `[[ref:${REF_ATTEMPT}]]`, ""].join("\n");
    fake.studyNotes.lockForShare = vi.fn(async () => noteRow({ body_md: body })) as never;

    const result = await makeService(fake).export(USER, NOTE, {
      expectedVersion: await versionOf(fake),
      schemaVersion: 2,
    });
    const payload = extractLastJsonBlock(result.markdown) as Record<string, any>;
    expect(payload.references[0].kind).toBe("attempt");
    expect(payload.references[0].target).toEqual({ kind: "attempt", attemptId: ATTEMPT });
    expect(payload.references[0].displaySnapshot).toEqual({
      kind: "attempt",
      venue: "file",
      answerExcerpt: `{"value":"A"}`,
    });
    expect(payload.renderedBodyMarkdown).toContain("场景: file");
  });

  it("v1：含 sheet / attempt 引用的笔记显式请求 v1 → 422（K16 不静默降级）", async () => {
    for (const row of [sheetRefRow(null), attemptRefRow()]) {
      const fake = fakeRepos({ refRows: [row] });
      const error = await makeService(fake)
        .export(USER, NOTE, { expectedVersion: await versionOf(fake), schemaVersion: 1 })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as { field?: string }).field).toBe("schemaVersion");
    }
  });
});

function userId(): string {
  return USER;
}

/**
 * N2 第四条链：评卷引用的导出口径（ADR-0039 决策 6/7）。
 *
 * - v2 承载新 kind，target 只带 {sheetId, questionId}（**不带**版本号 —— 决策 2
 *   否决了 ②b，所以导出里也不该凭空长出一个没有语义来源的字段）；
 * - v1 遇到 grading 必须 422 fail-closed，而不是把它悄悄降级成别的 kind。
 */
describe("N2 评卷引用导出（第四条链 · v2 承载 / v1 冻结）", () => {
  const SHEET = "00000000-0000-4000-8000-000000000301";
  const REF_GRADING = "00000000-0000-4000-8000-000000000008";
  const QUESTION_ID = "00000000-0000-4000-8000-000000000211";

  function gradingRefRow(): L3StudyNoteReferenceRow {
    return refRow({
      id: REF_GRADING,
      kind: "grading",
      source_id: null,
      question_id: QUESTION_ID,
      assessment_id: null,
      target_note_id: null,
      submission_id: SHEET,
      start_offset: null,
      end_offset: null,
      quote_snapshot: null,
      display_snapshot: asJson({
        kind: "grading",
        verdict: "wrong",
        analysisExcerpt: "限定词读错",
        gradedBy: "agent-1",
        gradedAt: "2026-09-26T00:00:00Z",
        questionOrdinal: 2,
        questionType: "reading_choice",
        sourceTitle: "来源",
      }),
    });
  }

  function fakeWithGradingRef(): FakeRepos {
    const fake = fakeRepos({ refRows: [gradingRefRow()] });
    const body = ["复盘。", "", `[[ref:${REF_GRADING}]]`, "", "结论。"].join("\n");
    fake.studyNotes.lockForShare = vi.fn(async () => noteRow({ body_md: body })) as never;
    return fake;
  }

  async function versionOf(fake: FakeRepos): Promise<number> {
    const lock = fake.studyNotes.lockForShare as unknown as () => Promise<{ version: number }>;
    return (await lock()).version;
  }

  it("v2：target 只带 {sheetId, questionId}，快照保留判定与归属事实", async () => {
    const fake = fakeWithGradingRef();
    const result = await makeService(fake).export(USER, NOTE, {
      expectedVersion: await versionOf(fake),
      schemaVersion: 2,
    });
    const payload = extractLastJsonBlock(result.markdown) as Record<string, any>;
    expect(payload.references[0].kind).toBe("grading");
    expect(payload.references[0].target).toEqual({
      kind: "grading",
      sheetId: SHEET,
      questionId: QUESTION_ID,
    });
    // 决策 2 的否决点在导出面也成立：没有版本维度可导出。
    expect(payload.references[0].target).not.toHaveProperty("version");
    expect(payload.references[0].target).not.toHaveProperty("gradingVersion");
    const snapshot = payload.references[0].displaySnapshot as Record<string, unknown>;
    expect(snapshot.verdict).toBe("wrong");
    expect(snapshot.analysisExcerpt).toBe("限定词读错");
    expect(snapshot.gradedBy).toBe("agent-1");
  });

  it("Markdown 正文出现评卷引用块，判定与分析可读", async () => {
    const fake = fakeWithGradingRef();
    const result = await makeService(fake).export(USER, NOTE, {
      expectedVersion: await versionOf(fake),
      schemaVersion: 2,
    });
    expect(result.markdown).toContain("评卷");
    expect(result.markdown).toContain("限定词读错");
  });

  it("v1：含评卷引用的笔记显式请求 v1 → 422，不静默切版、不降级", async () => {
    const fake = fakeWithGradingRef();
    const error = await makeService(fake)
      .export(USER, NOTE, { expectedVersion: await versionOf(fake), schemaVersion: 1 })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as { field?: string }).field).toBe("schemaVersion");
  });
});

/**
 * N2 写作引用导出（第五条链 · v2 承载 / v1 冻结）。
 *
 * 两个 kind 各有各的导出断言重点：
 * - writing_task：target 只带 {taskId}（题干不重复展开 —— 题干另有 question kind）。
 * - writing_feedback：target 只带 {sheetId}；Markdown 块**无分数、无判定行**
 *   （决策 10-⑨：schema 显式无 score，渲染分数即编造数据）。
 */
describe("N2 写作引用导出（第五条链 · v2 承载 / v1 冻结）", () => {
  const TASK = "00000000-0000-4000-8000-000000000401";
  const SHEET = "00000000-0000-4000-8000-000000000301";
  const REF_TASK = "00000000-0000-4000-8000-000000000009";
  const REF_FEEDBACK = "00000000-0000-4000-8000-000000000010";

  function taskRefRow(): L3StudyNoteReferenceRow {
    return refRow({
      id: REF_TASK,
      kind: "writing_task",
      source_id: null,
      question_id: null,
      assessment_id: null,
      target_note_id: null,
      submission_id: null,
      submission_revision_no: null,
      attempt_id: null,
      writing_task_id: TASK,
      start_offset: null,
      end_offset: null,
      quote_snapshot: null,
      display_snapshot: asJson({
        kind: "writing_task",
        title: "考研英语一 2023 作文",
        taskKind: "whole",
        direction: "考研",
      }),
    });
  }

  function feedbackRefRow(): L3StudyNoteReferenceRow {
    return refRow({
      id: REF_FEEDBACK,
      kind: "writing_feedback",
      source_id: null,
      question_id: null,
      assessment_id: null,
      target_note_id: null,
      submission_id: SHEET,
      submission_revision_no: null,
      attempt_id: null,
      writing_task_id: null,
      start_offset: null,
      end_offset: null,
      quote_snapshot: null,
      display_snapshot: asJson({
        kind: "writing_feedback",
        summary: "论点清晰，但第二段论证跳步。",
        excerpt: "紧扣题意，没有跑题。",
      }),
    });
  }

  function fakeWithWritingRefs(): FakeRepos {
    const fake = fakeRepos({ refRows: [taskRefRow(), feedbackRefRow()] });
    const body = ["复盘。", "", `[[ref:${REF_TASK}]]`, "", `[[ref:${REF_FEEDBACK}]]`, "", "结论。"].join("\n");
    fake.studyNotes.lockForShare = vi.fn(async () => noteRow({ body_md: body })) as never;
    return fake;
  }

  async function versionOf(fake: FakeRepos): Promise<number> {
    const lock = fake.studyNotes.lockForShare as unknown as () => Promise<{ version: number }>;
    return (await lock()).version;
  }

  it("v2：task target 只带 {taskId}，feedback target 只带 {sheetId}，都不带版本维度", async () => {
    const fake = fakeWithWritingRefs();
    const result = await makeService(fake).export(USER, NOTE, {
      expectedVersion: await versionOf(fake),
      schemaVersion: 2,
    });
    const payload = extractLastJsonBlock(result.markdown) as Record<string, any>;
    expect(payload.references[0].kind).toBe("writing_task");
    expect(payload.references[0].target).toEqual({ kind: "writing_task", taskId: TASK });
    expect(payload.references[0].target).not.toHaveProperty("questionId");
    expect(payload.references[1].kind).toBe("writing_feedback");
    expect(payload.references[1].target).toEqual({ kind: "writing_feedback", sheetId: SHEET });
    expect(payload.references[1].target).not.toHaveProperty("version");
    expect(payload.references[1].target).not.toHaveProperty("revisionNo");
  });

  it("Markdown 正文出现任务块与评阅块；评阅块无分数、无判定行", async () => {
    const fake = fakeWithWritingRefs();
    const result = await makeService(fake).export(USER, NOTE, {
      expectedVersion: await versionOf(fake),
      schemaVersion: 2,
    });
    expect(result.markdown).toContain("写作任务");
    expect(result.markdown).toContain("考研英语一 2023 作文");
    expect(result.markdown).toContain("评阅");
    expect(result.markdown).toContain("论点清晰");
    // 决策 10-⑨：块里一旦出现「得分/判定」，就是把评阅渲染成了评卷。
    expect(result.markdown).not.toMatch(/得分|评分|判定/);
  });

  it("v1：含写作引用的笔记显式请求 v1 → 422，不静默切版、不降级", async () => {
    const fake = fakeWithWritingRefs();
    const error = await makeService(fake)
      .export(USER, NOTE, { expectedVersion: await versionOf(fake), schemaVersion: 1 })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as { field?: string }).field).toBe("schemaVersion");
  });
});