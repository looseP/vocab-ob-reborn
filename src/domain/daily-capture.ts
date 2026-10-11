/**
 * 每日捕获（Daily Capture，2026-10-10 设计定稿）—— 领域层。
 *
 * 概念模型：条目（DB 真相，追加式）→ 日文件（(entry_date, seq) 确定性投影，
 * 人读 + agent 读 + 可复制进 Obsidian）→ 吸收（M3，proposal-only 单向晋级）。
 *
 * 本文件**零出向依赖**（arch: domain-no-outbound）：
 * - 不 import src/db/* —— 显示时区日键与时钟格式化由仓储层提供
 *   （services 被禁 import db/timezone，见 .dependency-cruiser.cjs），渲染器
 *   接受注入的 `formatClock`，保持纯函数可测。
 * - 渲染是**确定性**的：同一 (date, types, entries) 恒产出同一 markdown ——
 *   日文件不是存储形态，是投影，随时可重生成。
 */

/** 条目状态机：raw（流水）→ reviewed（回顾过）/ absorbed（已吸收）| archived（归档）。 */
export type DailyCaptureEntryStatus = "raw" | "reviewed" | "absorbed" | "archived";

/** 类型轻字段（meta jsonb）。词引用是**软引用**：流水期词可能尚不存在，吸收时才解析。 */
export interface DailyCaptureEntryMeta {
  /** 词组释义 / 简短注（词组类）。 */
  meaning?: string;
  /** 例句翻译（例句类）。 */
  translation?: string;
  /** 来源网页链接。 */
  sourceUrl?: string;
  /** obsidian:// 引用（与词语捕获同款）。 */
  obsidianRef?: string;
  /** 关联词 slug 列表（⤳ [[slug]]）。 */
  wordSlugs?: string[];
  /** 置要（M2 §14 拍板①：与状态流转正交的标记，true 恒显式写、false 摘除键）。 */
  important?: boolean;
}

export interface DailyCaptureEntryRow {
  id: string;
  user_id: string;
  /** 显示时区（Asia/Shanghai）日历日，YYYY-MM-DD。 */
  entry_date: string;
  /** 当日自增序号（≥1）：投影稳定排序 + agent 引用的稳定 ID。 */
  seq: number;
  entry_type: string;
  content: string;
  meta: DailyCaptureEntryMeta | null;
  status: DailyCaptureEntryStatus;
  /** 吸收回执（M3）：采纳动作的留痕数组；未吸收为 null。 */
  absorption: DailyCaptureAbsorptionReceipt[] | null;
  created_at: string;
  hidden_at: string | null;
}

/**
 * 词信号状态（读时投影）：`stub` 仅词形（`definition_md` 空）/ `ready` 已有正式释义 /
 * `gone` 词库中已无此 slug（硬删除，或该原样形态从未入本）。
 */
export type DailyCaptureWordSignalState = "stub" | "ready" | "gone";

/**
 * 词信号（读时投影，**不落库**）：条目 `⤳ [[slug]]` 上那个词的当前状态。
 *
 * 语义与证据包 `words` 数组一致：按 slug **精确匹配**（不做 alias 兜底）——
 * 解析不到即 `gone`，不报错、不隐藏流水文本（账本不可变，投影如实反映）。
 */
export interface DailyCaptureWordSignal {
  /** 条目 `meta.wordSlugs` 的原样 slug（信号按此键对齐）。 */
  slug: string;
  state: DailyCaptureWordSignalState;
  /** `words.definition_md` 非空；与 `findPublic` 的 `scope=content/stub` 同一口径。 */
  hasDefinition: boolean;
  /** 当前用户是否已为该词晋升 L2 行（跨词书 EXISTS，与详情页 `l2_promoted` 同口径）。 */
  l2Promoted: boolean;
  /** `words.updated_at`（该词上次变动）；`gone` 为 null。 */
  updatedAt: string | null;
}

/** 日视图条目 = 行 + 读时词信号投影（响应专属，不落库；吸收/回顾响应仍只回行）。 */
export interface DailyCaptureDayEntry extends DailyCaptureEntryRow {
  wordSignals: DailyCaptureWordSignal[];
}

/** 吸收动作全集（§9 提案模型）。 */
export const DAILY_CAPTURE_ABSORB_ACTIONS = [
  "bind_l3",
  "add_word",
  "enqueue_review",
  "file_method",
  "rewrite",
  "none",
] as const;

export type DailyCaptureAbsorbAction = (typeof DAILY_CAPTURE_ABSORB_ACTIONS)[number];

/**
 * 吸收回执行（absorption jsonb 数组元素）：采纳即留痕——action/去向/引用 ID/时间。
 * `deduped: true` 表示目标已存在（同句已绑 / 已在复习队列），本次为幂等收尾。
 */
export interface DailyCaptureAbsorptionReceipt {
  action: DailyCaptureAbsorbAction;
  /** l3_context | wordbook | review_card | null（file_method/rewrite/none 无写入目标）。 */
  target: string | null;
  id: string | null;
  at: string;
  word_slug: string | null;
  deduped?: boolean;
}

/** 证据包（M3）里的一个关联词：释义快照 + 既有语境计数（agent 判重/判新颖的依据）。 */
export interface DailyCaptureEvidenceWord {
  slug: string;
  title: string;
  lemma: string;
  ipa: string | null;
  short_definition: string | null;
  existing_context_count: number;
  /** 词信号投影（与日视图同一份；此处 slug 已精确命中，state 只会是 stub|ready）。 */
  signal: DailyCaptureWordSignal;
}

/** 证据包条目：稳定 ID + 类型提示 + 关联词上下文，喂给 agent 提案。 */
export interface DailyCaptureEvidenceEntry {
  seq: number;
  id: string;
  entry_type: string;
  label: string | null;
  absorption_hint: string | null;
  content: string;
  status: DailyCaptureEntryStatus;
  meta: DailyCaptureEntryMeta | null;
  created_at: string;
  words: DailyCaptureEvidenceWord[];
}

/** 证据包整体：markdown（人读）+ 结构化条目（机器读），一次请求给足。 */
export interface DailyCaptureEvidencePack {
  version: 1;
  date: string;
  markdown: string;
  entries: DailyCaptureEvidenceEntry[];
}

export interface DailyCaptureTypeRow {
  user_id: string;
  type_key: string;
  label: string;
  /** 吸收去向提示（agent 证据包与提案规范共用）。 */
  absorption_hint: string | null;
  sort: number;
  hidden: boolean;
  created_at: string;
}

/** 日期流聚合行（GROUP BY entry_date）。raw = 未回顾数（侧栏徽标与「今晚回顾」口径）。 */
export interface DailyCaptureDaySummary {
  date: string;
  total: number;
  raw: number;
  reviewed: number;
  absorbed: number;
}

/**
 * 状态流转图（M2 回顾面；M2 定稿 §14）：
 *   raw → reviewed | archived；reviewed → absorbed | archived；
 *   absorbed 与 archived 为**终态**（absorbed 的出口在 M3 吸收回执里写）。
 * 同状态 PATCH 视为 no-op（幂等）。
 */
export const DAILY_CAPTURE_TRANSITIONS: Readonly<Record<DailyCaptureEntryStatus, readonly DailyCaptureEntryStatus[]>> = {
  raw: ["reviewed", "archived"],
  reviewed: ["absorbed", "archived"],
  absorbed: [],
  archived: [],
};

export function canTransitionEntryStatus(from: DailyCaptureEntryStatus, to: DailyCaptureEntryStatus): boolean {
  return from === to || DAILY_CAPTURE_TRANSITIONS[from].includes(to);
}

/** 自定义类型的缺省吸收提示（M3 证据包照常携带）。 */
export const CUSTOM_TYPE_DEFAULT_HINT = "自定义类型：吸收时由 agent 编排（rewrite/none）。";

/** 可见（非 hidden）类型总数上限（M2 定稿 §14：7 内置 + 4 自定义席位）。 */
export const DAILY_CAPTURE_VISIBLE_TYPE_CAP = 11;

/**
 * seed 默认类型（单一真源；仓储 ensureDefaultTypes 据此幂等落库）。
 * `note` 恒排最后作 catch-all 兜底；吸收去向提示同时是 agent 提案规范的依据。
 */
export const DEFAULT_DAILY_CAPTURE_TYPES: ReadonlyArray<{
  typeKey: string;
  label: string;
  absorptionHint: string;
  sort: number;
}> = [
  {
    typeKey: "phrase",
    label: "词组",
    absorptionHint: "含目标词的搭配：吸收时绑定 L3 语境（collocation/摘录），并顺带入本相关词。",
    sort: 0,
  },
  {
    typeKey: "sentence",
    label: "例句",
    absorptionHint: "吸收时经 buildL3TrioInputs 写 l3_sources/l3_contexts/l3_occurrences 三件套（context_type=sentence）。",
    sort: 1,
  },
  {
    typeKey: "method",
    label: "学习方法",
    absorptionHint: "v1 留存日文件；吸收时由 agent 编排进学习笔记专题（l3_study_notes 绑题型，不硬塞）。",
    sort: 2,
  },
  {
    typeKey: "question",
    label: "疑问",
    absorptionHint: "吸收时由 agent 产出答复提案，或挂到相关词上。",
    sort: 3,
  },
  {
    typeKey: "idea",
    label: "想法",
    absorptionHint: "吸收时由 agent 改写为上述任一具体类型的提案（rewrite），不直接执行。",
    sort: 4,
  },
  {
    typeKey: "word",
    label: "生词",
    // 入本即记流水（设计稿 2026-10-11 §3.1）：捕获窗「加入生词本」触发的条目。
    // L3 三件套在捕获时已写入，故吸收阶段不再提 add_word / bind_l3。
    absorptionHint:
      "出生即入本（捕获窗触发）；L3 三件套已在捕获时写入；吸收时不再提 add_word / bind_l3，可提 enqueue_review（补复习卡）或 file_method（留档）。",
    sort: 5,
  },
  {
    typeKey: "note",
    label: "杂记",
    absorptionHint: "catch-all 兜底；吸收时由 agent 编排或归档。",
    sort: 6,
  },
];

export interface RenderDailyCaptureFileInput {
  /** 显示时区日历日，YYYY-MM-DD。 */
  date: string;
  /** 类型注册表（已按 sort 升序、未 hidden）。条目类型缺 label 时回退用 type_key。 */
  types: DailyCaptureTypeRow[];
  /** 当日条目（未 hidden、seq 升序）。 */
  entries: DailyCaptureEntryRow[];
  /** 时钟格式化（ISO → "HH:MM"，显示时区）——由仓储层注入（arch 约束）。 */
  formatClock: (iso: string) => string;
}

function metaOf(entry: DailyCaptureEntryRow): DailyCaptureEntryMeta {
  return typeof entry.meta === "object" && entry.meta !== null ? entry.meta : {};
}

/** 条目渲染行：`- [#seq] HH:MM 内容 — 释义 ⤳ [[词]]（来源: url）`，置要加 ★，译句换行缩进。 */
function renderEntryLine(entry: DailyCaptureEntryRow, formatClock: (iso: string) => string): string {
  const meta = metaOf(entry);
  const star = meta.important ? "★ " : "";
  const firstLine = `- [#${entry.seq}] ${formatClock(entry.created_at)} ${star}${entry.content}`;
  const suffixes: string[] = [];
  if (meta.meaning) suffixes.push(`— ${meta.meaning}`);
  for (const slug of meta.wordSlugs ?? []) {
    suffixes.push(`⤳ [[${slug}]]`);
  }
  if (meta.sourceUrl) suffixes.push(`（来源: ${meta.sourceUrl}）`);
  // 全角括号前不补半角空格（排版口径）；其余后缀以单空格相连。
  const suffixText = suffixes
    .join(" ")
    .replace(/ （/g, "（");
  // 多行内容（含学习方法的长描述）：续行统一缩进两格，保持列表形状。
  const indent = (text: string): string => text.split("\n").join("\n  ");
  const lines = [indent(`${firstLine}${suffixText ? " " + suffixText : ""}`)];
  if (meta.translation) lines.push(`  译：${indent(meta.translation)}`);
  return lines.join("\n");
}

/**
 * 把当日条目投影为「一天一文件」的纯文本 markdown（设计 §6 格式规范）。
 *
 * - 分节顺序 = 类型注册表 sort；空类型不出节；
 * - `[#seq]` 是条目的稳定 ID（agent 证据包引用、吸收回执对账都靠它）；
 * - 页脚统计供 5 秒自检（已回顾/已吸收，M1 恒为 0 但口径从现在就钉住）。
 */
export function renderDailyCaptureFile(input: RenderDailyCaptureFileInput): string {
  const { date, types, entries, formatClock } = input;
  const lines: string[] = [`# 每日捕获 · ${date}`, ""];
  const labelByType = new Map(types.map((type) => [type.type_key, type.label]));

  for (const type of types) {
    const group = entries.filter((entry) => entry.entry_type === type.type_key);
    if (group.length === 0) continue;
    lines.push(`## ${labelByType.get(type.type_key) ?? type.type_key} (${group.length})`);
    for (const entry of group) {
      lines.push(renderEntryLine(entry, formatClock));
    }
    lines.push("");
  }

  // 条目类型不在注册表（理论上仅注册表回退窗口可能出现）：兜底节，不丢数据。
  const knownTypes = new Set(types.map((type) => type.type_key));
  const orphans = entries.filter((entry) => !knownTypes.has(entry.entry_type));
  if (orphans.length > 0) {
    lines.push(`## 其他 (${orphans.length})`);
    for (const entry of orphans) {
      lines.push(renderEntryLine(entry, formatClock));
    }
    lines.push("");
  }

  if (entries.length === 0) {
    lines.push("（今日暂无条目）", "");
  }

  const reviewed = entries.filter((entry) => entry.status === "reviewed").length;
  const absorbed = entries.filter((entry) => entry.status === "absorbed").length;
  lines.push("---", `共 ${entries.length} 条 · 已回顾 ${reviewed} · 已吸收 ${absorbed}`, "");
  return lines.join("\n");
}
