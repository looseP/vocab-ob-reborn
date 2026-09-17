/** Domain types — pure, zero DB/runtime dependencies. */

import type { ParsedCoreDefinition } from "./ingest/types";
import type { L3PracticeType } from "./l3-practice-task";

export type { L3PracticeType };

// ── Common ──────────────────────────────────────────────────────────────
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// ── Plaza（词汇广场 · 自生长集合）────────────────────────────────────────
/** 语义场集合的 slug 前缀（对齐原版 collection-note 约定）。 */
export const PLAZA_SEMANTIC_SLUG_PREFIX = "semantic";
/** 词根词缀集合的 slug 前缀。 */
export const PLAZA_ROOT_SLUG_PREFIX = "root";

export type PlazaKind = "semantic_field" | "root_affix";

/** 语义场集合分组行（由 words.source_path 实时推导）。 */
export interface SemanticFieldGroupRow {
  field: string;
  count: number;
  updatedAt: string;
}

/** 词根家族分组行（由 words.morphology_root 提取 token 后聚合）。 */
export interface RootFamilyGroupRow {
  root: string;
  count: number;
  updatedAt: string;
}

/** 词汇广场集合摘要（语义场或词根家族）。 */
export interface PlazaCollectionSummary {
  slug: string;
  title: string;
  kind: PlazaKind;
  count: number;
  updatedAt: string;
}

/** 词汇广场集合详情查询行（WordSummary + updated_at，不落响应契约外字段）。 */
export interface PlazaWordRow extends WordSummary {
  updated_at: string;
}

/** 集合详情页的词卡。 */
export interface PlazaWordCard {
  id: string;
  slug: string;
  lemma: string;
  cefr: string | null;
  short_definition: string | null;
  semantic_chain: string | null;
}

/** 词根集合详情页的词卡：词根结构（prefix/root/suffix）+ 语义链。 */
export interface RootWordCard extends PlazaWordCard {
  root: string | null;
  prefix: string | null;
  suffix: string | null;
}

/** 集合详情：摘要 + 关联词卡。 */
export interface PlazaCollectionDetail extends PlazaCollectionSummary {
  words: PlazaWordCard[];
}

/** 词根集合详情：摘要 + 词根结构词卡。 */
export interface RootCollectionDetail extends PlazaCollectionSummary {
  type: "simple" | "compound" | "mixed";
  words: RootWordCard[];
}

/** 广场分组（语义场 / 词根词缀）。 */
export interface PlazaGroup {
  kind: PlazaKind;
  label: string;
  count: number;
  collections: PlazaCollectionSummary[];
}

/** 广场总览响应。 */
export interface PlazaOverview {
  available: boolean;
  counts: { showing: number; total: number };
  groups: PlazaGroup[];
  total: number;
}

/** 词根词缀广场响应（独立端点 /api/plaza/roots，避免触碰冻结的语义场契约）。 */
export interface RootsOverview {
  available: boolean;
  counts: { showing: number; total: number };
  collections: PlazaCollectionSummary[];
  total: number;
}

/** 集合内复习统计（E1）：按 wordIds 聚合 user_word_progress。 */
export interface PlazaReviewStats {
  tracked: number;
  due: number;
}

// ── Word ────────────────────────────────────────────────────────────────
export type ReviewRating = "again" | "hard" | "good" | "easy";

export interface WordRow {
  id: string;
  slug: string;
  title: string;
  lemma: string;
  pos: string | null;
  cefr: string | null;
  ipa: string | null;
  aliases: string[];
  short_definition: string | null;
  definition_md: string;
  body_md: string;
  prototype_text: string | null;
  examples: Json;
  metadata: Json;
  source_path: string;
  source_updated_at: string | null;
  content_hash: string;
  is_published: boolean;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
  /** L2 enrichment JSONB caches（NOT NULL DEFAULT '[]'，SELECT * 必返；旧测试 mock 可省略）。 */
  collocations?: Json;
  corpus_items?: Json;
  synonym_items?: Json;
  antonym_items?: Json;
  /** 核心释义义项列表（NOT NULL DEFAULT '[]'；旧测试 mock 可省略）。 */
  core_definitions?: ParsedCoreDefinition[];
}

export interface WordSummary {
  id: string;
  slug: string;
  title: string;
  lemma: string;
  pos: string | null;
  cefr: string | null;
  ipa: string | null;
  short_definition: string | null;
  metadata: Json;
}

/** L2 enrichment 内容展示结构（来自 words 表四列 JSONB 缓存，恒为对象，缺省为空数组）。 */
export interface WordDetailL2Content {
  collocations: Json[];
  corpus_items: Json[];
  synonym_items: Json[];
  antonym_items: Json[];
}

/** Public wire-safe word detail. Internal ingestion and lifecycle fields are excluded. */
export interface WordDetail extends WordSummary {
  aliases: string[];
  definition_md: string;
  body_md: string;
  examples: Json;
  prototype_text: string | null;
  /** 核心释义义项列表（Bound sense 圈记条下拉数据源）。 */
  core_definitions: ParsedCoreDefinition[];
  l2_content: WordDetailL2Content;
  /** 当前用户是否已为该词晋升 L2 行（待扩展提示；未带用户语义时为 false）。 */
  l2_promoted: boolean;
}

export interface WordFilters {
  q?: string;
  review?: string;
  cefr?: string;
}

export interface GetPublicWordsOptions {
  filters?: WordFilters;
  pagination: { limit: number; offset: number };
  userId: string;
  wordbookId?: string;
}

// ── Review / Progress ───────────────────────────────────────────────────
export type ReviewState = "new" | "learning" | "review" | "relearning" | "suspended";

export interface UserWordProgressRow {
  id: string;
  user_id: string;
  word_id: string;
  wordbook_id: string;
  state: ReviewState;
  stability: number | null;
  difficulty: number | null;
  retrievability: number | null;
  desired_retention: number;
  due_at: string | null;
  last_reviewed_at: string | null;
  last_rating: ReviewRating | null;
  review_count: number;
  lapse_count: number;
  again_count: number;
  hard_count: number;
  good_count: number;
  easy_count: number;
  interval_days: number | null;
  scheduler_payload: Json;
  content_hash_snapshot: string | null;
  l1_content_hash_snapshot: string | null;
  skip_count: number;
  created_at: string;
  updated_at: string;
  /**
   * Sliding window of the most recent L1 ratings (chronological order, max 5).
   * Backs the Phase 2C cross-track cascade: the last N entries drive L1→L2
   * pause/unpause. Stored as jsonb in the DB.
   */
  recent_ratings: ReviewRating[];
  /**
   * Weak-signal flag set when L2辨析 fails repeatedly (3× again). Phase 2C
   * decision-2: L2→L1 only marks, never auto-re-cards — the user decides
   * whether to re-grind L1 after seeing the flag in the UI.
   */
  l1_weak_signal: boolean;
}

export interface ReviewLogRow {
  id: string;
  user_id: string;
  word_id: string;
  wordbook_id: string;
  progress_id: string;
  session_id: string | null;
  rating: ReviewRating | null;
  state: ReviewState;
  stability: number | null;
  difficulty: number | null;
  due_at: string | null;
  reviewed_at: string;
  elapsed_days: number;
  scheduled_days: number;
  metadata: Json;
  previous_progress_snapshot: Json;
  idempotency_key: string | null;
  created_at: string;
}

export interface ReviewQueueItem {
  progress: UserWordProgressRow;
  word: { id: string; slug: string; title: string; lemma: string };
}

// ── Note entry(条目制笔记,2026-09-06)──────────────────────────────────
// notes/note_revisions(单文档+版本链)为遗留模型,只读保留;新写入路径全部走 note_entries。
export interface NoteEntryRow {
  id: string;
  user_id: string;
  word_id: string;
  wordbook_id: string;
  content_md: string;
  /** 非空 = 已隐藏(非破坏管理);恢复时置回 NULL。 */
  hidden_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Wordbook ────────────────────────────────────────────────────────────

/**
 * Direction（方向，ADR-0017）：考试/用途风味轴，挂在词书、L2 内容行与 L3 来源上。
 * `通用` 是方向无关桶——方向专属界面先展示本方向，再回退 `通用`。
 * 词书方向不建列，落在 `wordbooks.settings` jsonb（见 WordbookSettings）。
 */
export type Direction = "通用" | "考研" | "雅思";

/** `wordbooks.settings` jsonb 的形状（0 迁移；direction 缺省视为 `通用`）。 */
export type WordbookSettings = {
  direction?: Direction;
  review?: {
    desired_retention?: number;
    fsrs_weights?: number[];
  };
};

export interface WordbookRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  settings: WordbookSettings | null;
  created_at: string;
  updated_at: string;
}

// ── Session ─────────────────────────────────────────────────────────────
export interface SessionRow {
  id: string;
  user_id: string;
  wordbook_id: string;
  mode: string;
  cards_seen: number;
  started_at: string;
  ended_at: string | null;
}

// ── Highlight / Annotation ──────────────────────────────────────────────
export interface HighlightRow {
  id: string;
  user_id: string;
  word_id: string;
  wordbook_id: string;
  source_field: string | null;
  text_snippet: string;
  color: string;
  created_at: string;
}

export interface AnnotationRow {
  id: string;
  user_id: string;
  word_id: string;
  wordbook_id: string;
  content: string;
  updated_at: string;
}

// ── L2 Progress ──────────────────────────────────────────────────────────────

export interface UserWordL2ProgressRow {
  id: string;
  user_id: string;
  word_id: string;
  wordbook_id: string;
  l2_stability: number | null;
  l2_difficulty: number | null;
  l2_retrievability: number | null;
  l2_state: string;
  l2_desired_retention: number;
  l2_due_at: string | null;
  l2_last_reviewed_at: string | null;
  l2_last_rating: string | null;
  l2_review_count: number;
  l2_lapse_count: number;
  l2_interval_days: number | null;
  l2_scheduler_payload: unknown;
  l2_again_count: number;
  l2_hard_count: number;
  l2_good_count: number;
  l2_easy_count: number;
  l2_content_hash_snapshot: string | null;
  recent_ratings: string[];
  l2_paused: boolean;
  l2_paused_at: string | null;
  l2_paused_reason: string | null;
  l2_inherited_from_l1: boolean;
  l2_weights_source: string;
  l2_predicted_retrievability: number | null;
  // 2026-08-24 l2-drill spec：产出步自评标记（非 FSRS 字段）。
	l2_production_status: string | null;
	created_at: string;
}

/** 辨析训练会话步骤明细（l2_drill_session_steps 行）。事实记录，非调度器。 */
export interface L2DrillStepRow {
  id: string;
  session_id: string;
  user_id: string;
  wordbook_id: string;
  word_id: string;
  progress_id: string;
  step_index: number;
  step_type: "l2_discrimination" | "l2_production";
  status: "pending" | "completed" | "skipped";
  task_id: string | null;
  task_type: string | null;
  task_payload: Json;
  outcome: "correct" | "incorrect" | "self_passed" | "self_weak" | null;
  mapped_rating: ReviewRating | null;
  review_log_id: string | null;
  created_at: string;
  completed_at: string | null;
}

// ── L2 Content ───────────────────────────────────────────────────────────
// Multi-source L2 enrichment content for a word (collocations / corpus /
// synonym / antonym). `content` is opaque JSONB; `field` discriminates the
// kind so refreshL2Cache can group rows back into the words JSONB columns.

export interface L2ContentRow {
  id: string;
  word_id: string;
  field: string;
  /** ADR-0017 §2：内容行方向（默认 `通用`）。读取侧按"当前方向 + 通用兜底"过滤。 */
  direction: Direction;
  content: Json;
  source: string;
  source_ref: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  is_active: boolean;
}

// ── Upgrade Work Order ───────────────────────────────────────────────────
/**
 * 升级工单状态机（ADR-0018 §1；DB CHECK 同值）：
 *   标记中 → 升级中 → 已完成；任意进行中态可 → 已取消。
 * 部分唯一索引保证同一 (user, word, wordbook) 至多一张进行中工单。
 */
export type UpgradeWorkOrderStatus = "标记中" | "升级中" | "已完成" | "已取消";

/** 升级工单行（upgrade_work_orders，0028）。direction 由工单指定（ADR-0017 §2）。 */
export interface UpgradeWorkOrderRow {
  id: string;
  user_id: string;
  word_id: string;
  wordbook_id: string;
  direction: Direction;
  status: UpgradeWorkOrderStatus;
  /** 标记时刻的升级建议快照（三档 + 输入证据）；纯提示、零 FSRS 写入。 */
  suggestion_snapshot: Json | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// ── L3 Context Space ────────────────────────────────────────────────────
export type L3SourceType = "article" | "book" | "video" | "audio" | "chat" | "manual" | "web" | "other";
export type L3ContextType = "sentence" | "paragraph" | "excerpt" | "dialogue" | "note";
export type L3ContextLinkType =
  | "supports"
  | "illustrates"
  | "contrasts"
  | "collocates_with"
  | "synonym_of"
  | "antonym_of"
  | "derived_from"
  | "topic_related"
  | "manual_link";
export type L3ContextLinkTargetType = "word" | "l2_item" | "context" | "source" | "topic" | "external";
export type L3ImportJobStatus = "pending" | "processing" | "completed" | "failed";

export interface L3SourceRow {
  id: string;
  user_id: string;
  wordbook_id: string | null;
  source_type: L3SourceType;
  title: string;
  author: string | null;
  url: string | null;
  language: string | null;
  metadata: Json;
  content_text: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface L3ContextRow {
  id: string;
  source_id: string;
  user_id: string;
  context_type: L3ContextType;
  text: string;
  normalized_text: string | null;
  language: string | null;
  position: Json;
  metadata: Json;
  created_at: string;
  updated_at: string;
}

export interface L3OccurrenceRow {
  id: string;
  context_id: string;
  word_id: string;
  user_id: string;
  surface: string;
  lemma: string | null;
  start_offset: number | null;
  end_offset: number | null;
  confidence: number | string | null;
  evidence: Json;
  /** 语境义快照（圈记时绑定的释义/搭配文本；快照语义，不随 L1 词义更新） */
  bound_sense: string | null;
  created_at: string;
}

export interface L3ContextLinkRow {
  id: string;
  user_id: string;
  context_id: string | null;
  word_id: string | null;
  link_type: L3ContextLinkType;
  target_type: L3ContextLinkTargetType;
  target_id: string | null;
  target_ref: Json;
  confidence: number | string | null;
  provenance: Json;
  created_at: string;
}

export interface L3ImportJobRow {
  id: string;
  user_id: string;
  source_id: string | null;
  status: L3ImportJobStatus;
  input_hash: string;
  input_summary: string | null;
  stats: Json;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// ── L3 practice attempts（ADR-0019 §1/§3）───────────────────────────────
/**
 * 子空间（能力域轴，ADR-0019 §4）：固定枚举，与 Direction（考试轴）正交。
 * 落在 l3_source_spaces junction（多对多），DB CHECK 同值。
 */
export type L3SubSpace = "语法" | "阅读" | "作文" | "翻译" | "通用";

/** 练习判定结果（l3_practice_attempts.outcome CHECK 同值）。 */
export type L3PracticeOutcome = "correct" | "wrong" | "skip";

/** L3 练习记录行（l3_practice_attempts，0028）。零 FSRS 列：有记录、无调度。 */
export interface L3PracticeAttemptRow {
  id: string;
  user_id: string;
  context_id: string;
  occurrence_id: string | null;
  session_id: string | null;
  practice_type: L3PracticeType;
  outcome: L3PracticeOutcome;
  payload: Json;
  created_at: string;
}

/** 练习记录分页（offset 口径，对齐 l3-context.listSources 的既有 L3 列表惯例）。 */
export interface L3PracticeAttemptPage {
  items: L3PracticeAttemptRow[];
  total: number;
  limit: number;
  offset: number;
}

// ── L3 题目 / 试卷（ADR-0030：题与 context 严格分离，文件为派生视图）────────
import type {
  L3EvidenceAnchor,
  L3PaperPayload,
  L3PaperSection,
  L3PaperStatus,
  L3QuestionAnswer,
  L3QuestionOption,
  L3QuestionStatus,
  L3QuestionType,
} from "./l3-question-types";
export type {
  L3EvidenceAnchor,
  L3PaperPayload,
  L3PaperSection,
  L3PaperStatus,
  L3QuestionAnswer,
  L3QuestionOption,
  L3QuestionStatus,
  L3QuestionType,
};

/** l3_questions 行（jsonb 列以结构化形态读出，由 repository 负责反序列化收窄）。 */
export interface L3QuestionRow {
  id: string;
  user_id: string;
  source_id: string | null;
  file_key: string | null;
  space: L3SubSpace;
  question_type: L3QuestionType;
  ordinal: number;
  stem: string;
  options: L3QuestionOption[];
  answer: L3QuestionAnswer;
  explanation: string | null;
  evidence: L3EvidenceAnchor[];
  status: L3QuestionStatus;
  created_by: string;
  input_hash: string | null;
  created_at: string;
  updated_at: string;
}

/** l3_papers 行（卷面 sections 存 payload 引用，不建 sections 表）。 */
export interface L3PaperRow {
  id: string;
  user_id: string;
  title: string;
  direction: Direction | null;
  metadata: Json;
  payload: L3PaperPayload;
  payload_version: number;
  status: L3PaperStatus;
  created_by: string;
  input_hash: string | null;
  created_at: string;
  updated_at: string;
}

/** 做题文件列表项：文件 = (source_id, question_type) 或 file_key 上的题组聚合。 */
export interface L3PracticeFileListItem {
  question_type: L3QuestionType;
  source_id: string | null;
  file_key: string | null;
  /** 有正文文件取材料标题；无正文取题组键。 */
  title: string;
  direction: Direction | null;
  question_count: number;
  latest_created_at: string;
}

export interface L3PracticeFilePage {
  items: L3PracticeFileListItem[];
  total: number;
  limit: number;
  offset: number;
}

/** 试卷列表项（不含 payload）。 */
export interface L3PaperListItem {
  id: string;
  title: string;
  direction: Direction | null;
  status: L3PaperStatus;
  section_count: number;
  question_count: number;
  created_at: string;
  updated_at: string;
}

export interface L3PaperListPage {
  items: L3PaperListItem[];
  total: number;
  limit: number;
  offset: number;
}

/** 卷面组装后的 section：引用缺失时降级 missing 占位而不是 500（ADR-0030 §2 护栏②）。 */
export type L3AssembledSection =
  | (L3PaperSection & { missing: false; source_title: string | null; source_content: string | null; questions: L3QuestionRow[] })
  | (L3PaperSection & { missing: true; missing_reason: string; source_title: string | null; source_content: string | null; questions: L3QuestionRow[] });

export interface L3PaperDetail extends Omit<L3PaperRow, "payload"> {
  payload: L3PaperPayload;
  sections: L3AssembledSection[];
}

// ── 批次一（0033）：做题注记（原文分析条目）与规律标签字典 ────────────────
import type { AnnotationStage } from "./l3-annotations";
import type { SealMode, SheetScope, SheetStatus } from "./l3-sheets";
export type { AnnotationStage, SealMode, SheetScope, SheetStatus };
export type L3AnnotationTagKind = "entry" | "option";
export type L3AnnotationOptionKey = "A" | "B" | "C" | "D";

/** l3_question_annotations 行（jsonb 列由 repository 反序列化收窄）。 */
export interface L3QuestionAnnotationRow {
  id: string;
  user_id: string;
  question_id: string;
  ordinal: number;
  anchor_start: number | null;
  anchor_end: number | null;
  excerpt: string | null;
  note: string;
  entry_tags: string[];
  option_tags: Partial<Record<L3AnnotationOptionKey, string[]>>;
  /** 批次二（ADR-0034 §3）：stage 生命周期（draft→submitted→confirmed），与软删 status 正交。 */
  stage: AnnotationStage;
  /** 草稿期挂题纸（定格升格后保留溯源；题纸删除 SET NULL）。 */
  sheet_id: string | null;
  /** agent 检验产物（批次三写；note/锚点/原判标签不可篡改，订正归 owner）。 */
  review: Json | null;
  status: "active" | "deleted";
  created_at: string;
  updated_at: string;
}

/** l3_annotation_tags 行（预置 + 用户增删改，按用户隔离）。 */
export interface L3AnnotationTagRow {
  id: string;
  user_id: string;
  kind: L3AnnotationTagKind;
  label: string;
  ordinal: number;
  status: "active" | "deleted";
  created_at: string;
  updated_at: string;
}

// ── 批次二（0034）：题纸与作答历史（ADR-0034 §1/§2）─────────────────────
/** l3_submissions 行（题纸：draft 期含 answers；定格后 answers 清空、明细从 attempts 派生）。 */
export interface L3SubmissionRow {
  id: string;
  user_id: string;
  scope: SheetScope;
  /** 'file:<source_id>:<question_type>' 或 'paper:<paper_id>'（domain 构造器单一收口）。 */
  scope_key: string;
  source_id: string | null;
  question_type: L3QuestionType | null;
  paper_id: string | null;
  status: SheetStatus;
  /** 仅 draft 期有效；定格物化 attempts 后清空（attempts 是唯一作答真源）。 */
  answers: Record<string, Json>;
  seal_mode: SealMode | null;
  summary: string | null;
  sealed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** l3_question_attempts 行（题级作答历史；读取过滤 deleted；无判定列——verdict 真源归一 l3_grading_results）。 */
export interface L3QuestionAttemptRow {
  id: string;
  user_id: string;
  question_id: string;
  sheet_id: string | null;
  venue: SheetScope;
  answer: Json;
  /** 当场自评快照（形状宽松，题类型各自定义键）。 */
  self_assessment: Json | null;
  status: "active" | "deleted";
  deleted_at: string | null;
  created_at: string;
}

// ── L3 error book（T11 加固：服务端聚合 + cursor 纯新增）───────────────────
/**
 * 错题库条目：wrong attempt 行 + **服务端聚合**的语境级统计。
 * wrongCount = 该语境全量 outcome='wrong' 计数；latestOutcome / latestAt 取自
 * 该语境最近一次作答（不限 outcome）——三者均不受任何分页窗口/页大小限制。
 */
export interface L3PracticeErrorBookItem extends L3PracticeAttemptRow {
  wrongCount: number;
  latestOutcome: L3PracticeOutcome;
  /** 与该 latestOutcome 同源的最近作答时间（ISO 字符串）。 */
  latestAt: string;
}

/**
 * 错题库分页：offset 参数保留（兼容窗口不删），cursor 纯新增；两者同时出现
 * 时以 cursor 为准（offset 被忽略，响应 offset 恒 0）。`nextCursor` 在两种
 * 模式下均给出：null = 已到末页（当前 items 已含过滤条件下全部记录）。
 */
export interface L3PracticeErrorBookPage {
  items: L3PracticeErrorBookItem[];
  total: number;
  limit: number;
  offset: number;
  nextCursor: string | null;
}

// ── L3 sessions（ADR-0019 §2：慢学习容器）─────────────────────────────
export type L3SessionType = "l2_upgrade" | "l3_practice" | "cram_pack" | "knowledge";
export type L3SessionStatus = "active" | "completed" | "abandoned";

/** L3 会话行（l3_sessions，0028）。plan 只存实体 id 引用 + version，不存产物。 */
export interface L3SessionRow {
  id: string;
  user_id: string;
  type: L3SessionType;
  title: string | null;
  plan: Json;
  version: number;
  status: L3SessionStatus;
  started_at: string;
  ended_at: string | null;
  created_at: string;
}

/** 会话计划的一天：只存 context id 引用（不存文本）。 */
export interface L3SessionPlanItem {
  day: number;
  contextIds: string[];
}

/** 会话计划（plan jsonb）：实体引用 + version（借 TypeWords flow version 思路）。 */
export interface L3SessionPlan {
  version: number;
  days: number;
  seed: string;
  items: L3SessionPlanItem[];
}

/** 会话渲染用的语境投影（现拉现渲染，非冻结产物）。 */
export interface L3SessionContextSummary {
  id: string;
  text: string;
  context_type: L3ContextType;
  source_id: string;
  source_title: string;
}

/** 渲染描述的一天：plan 的 id 引用 + 当次现拉的语境数据。 */
export interface L3SessionRenderItem {
  day: number;
  contexts: L3SessionContextSummary[];
}

export interface L3SessionRenderDescription {
  session: L3SessionRow;
  items: L3SessionRenderItem[];
}

export interface L3WordContextListItem {
  context: L3ContextRow;
  source: L3SourceRow;
  occurrence: L3OccurrenceRow | null;
  links: L3ContextLinkRow[];
}

export interface L3SourceContextListItem {
  context: L3ContextRow;
  source: L3SourceRow;
  occurrences: L3OccurrenceRow[];
  links: L3ContextLinkRow[];
}

export interface L3PaginatedList<T> {
  items: T[];
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
}

export interface L3ContextDetail {
  context: L3ContextRow;
  source: L3SourceRow;
  occurrences: L3OccurrenceRow[];
  links: L3ContextLinkRow[];
}

export interface L3ReadStats {
  sourceCount: number;
  contextCount: number;
  occurrenceCount: number;
  linkCount: number;
}

export interface L3WordSpace {
  word: WordRow;
  contexts: L3ContextRow[];
  sources: L3SourceRow[];
  occurrences: L3OccurrenceRow[];
  links: L3ContextLinkRow[];
  stats: L3ReadStats;
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
}

export interface L3SourceSpace {
  source: L3SourceRow;
  contexts: L3ContextRow[];
  occurrences: L3OccurrenceRow[];
  links: L3ContextLinkRow[];
  /** 素材空间相关词卡片（short_definition 供 Bound sense 预填/兜底显示）。 */
  words: Array<{ id: string; slug: string; title: string; short_definition: string | null }>;
  stats: L3ReadStats;
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
}

export interface L3SourceListItem {
  id: string;
  title: string;
  source_type: string;
  url: string | null;
  created_at: string;
  context_count: number;
  /** 能力域标签（l3_source_spaces，ADR-0019 §4；V0 接通写入；V0 前历史数据可能为空数组，新建恒至少含「通用」）。 */
  spaces: L3SubSpace[];
}

export interface L3SourceListPage {
  items: L3SourceListItem[];
  total: number;
  limit: number;
  offset: number;
}

/** L3 证据列表项（ADR-0029 §6①）：occurrence 主行 + 词 / 语境 / 来源三件套（一屏够用）。 */
export interface L3OccurrenceListItem {
  occurrence: L3OccurrenceRow;
  word: { id: string; slug: string; title: string };
  context: L3ContextRow;
  source: L3SourceRow;
}

/** L3 证据列表项（ADR-0029 §6①）：context-link 主行 + 其词 / 语境 / 来源（随 link 挂点可空）。 */
export interface L3ContextLinkListItem {
  link: L3ContextLinkRow;
  word: { id: string; slug: string; title: string } | null;
  context: L3ContextRow | null;
  source: L3SourceRow | null;
}

export type L3GraphNodeType = "word" | "context" | "source" | "l2_item" | "topic" | "external";

export interface L3GraphNode {
  id: string;
  type: L3GraphNodeType;
  label: string;
  ref: Json;
  metadata?: Json;
}

export interface L3GraphEdge {
  id: string;
  type: L3ContextLinkType | "occurs_in" | "belongs_to";
  sourceNodeId: string;
  targetNodeId: string;
  confidence?: number | string | null;
  provenance?: Json;
  evidence?: Json;
}

export interface L3GraphReadModel {
  nodes: L3GraphNode[];
  edges: L3GraphEdge[];
  stats: L3ReadStats & {
    nodeCount: number;
    edgeCount: number;
  };
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  metadata?: Json;
}

/** 空间汇总的每日新增行（B1 素材宇宙 / 生长趋势）：显示时区（Asia/Shanghai）自然日。 */
export interface L3SpaceSummaryDay {
  /** YYYY-MM-DD（显示时区切日，对齐 review/stats 的日界口径）。 */
  day: string;
  sourceCount: number;
  contextCount: number;
  occurrenceCount: number;
  linkCount: number;
}

/**
 * 空间汇总（B1 素材宇宙）：全量计数 + 生长趋势。
 * - counts：四类实体全量计数（与 L3ReadStats 同语义，不随任何过滤器变化）；
 * - growth.byDay：窗口内**每日新增**，升序、稀疏（仅含产生过新增的日期；
 *   展示端按 windowDays 补零并自行累加出累计曲线）。
 */
export interface L3SpaceSummary {
  counts: L3ReadStats;
  growth: {
    windowDays: number;
    byDay: L3SpaceSummaryDay[];
  };
}

export type L3ProposalSourceType = "agent" | "import" | "external_tool" | "manual_draft" | "other";
export type L3ProposalStatus = "pending" | "confirmed" | "rejected" | "canceled";
export type L3ProposalItemType = "source" | "context" | "occurrence" | "context_link";
export type L3ProposalItemStatus = "pending" | "confirmed" | "rejected";
export type L3ProposalActiveEntityType = "source" | "context" | "occurrence" | "context_link";

export interface L3ProposalRow {
  id: string;
  user_id: string;
  wordbook_id: string | null;
  /**
   * 契约桥接：写路径已收敛（L3_PROPOSAL_SOURCE_TYPES / 0031 CHECK 均无
   * mcp_future），但 HTTP 响应契约冻结窗口未到（l3-response-contract /
   * generated client 仍保留该字面量），读模型类型与之保持一致；service 层
   * requireEnum 保证新写入不可能出现 mcp_future。
   */
  source_type: L3ProposalSourceType | "mcp_future";
  status: L3ProposalStatus;
  title: string | null;
  summary: string | null;
  input_hash: string | null;
  proposed_by: string | null;
  provenance: Json;
  review_note: string | null;
  confirmed_at: string | null;
  rejected_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface L3ProposalItemRow {
  id: string;
  proposal_id: string;
  user_id: string;
  item_type: L3ProposalItemType;
  ordinal: number;
  payload: Json;
  status: L3ProposalItemStatus;
  validation_errors: Json;
  active_entity_type: L3ProposalActiveEntityType | null;
  active_entity_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface L3ProposalBundle {
  proposal: L3ProposalRow;
  items: L3ProposalItemRow[];
}

export interface L3ProposalValidationIssue {
  itemId: string;
  ordinal: number;
  itemType: L3ProposalItemType;
  field: string;
  message: string;
}

export interface L3ProposalValidationResult extends L3ProposalBundle {
  valid: boolean;
  errors: L3ProposalValidationIssue[];
}

export interface L3ProposalConfirmResult extends L3ProposalBundle {
  activeEntities: Array<{
    itemId: string;
    itemType: L3ProposalItemType;
    activeEntityType: L3ProposalActiveEntityType;
    activeEntityId: string;
  }>;
}

export type L3RecommendationType =
  | "review_pack"
  | "learn_next"
  | "link_gap"
  | "context_gap"
  | "l2_gap"
  | "weak_word"
  | "related_word";
export type L3RecommendationStatus = "pending" | "accepted" | "rejected" | "dismissed" | "expired";
export type L3RecommendationRunMode = "review_pack" | "learn_next" | "gap_scan" | "link_suggestions";
export type L3RecommendationRunStatus = "completed" | "failed";
export type L3RecommendationEvidenceType =
  | "graph_edge"
  | "occurrence_count"
  | "fsrs_due"
  | "fsrs_weak"
  | "l2_missing_field"
  | "l3_context_missing"
  | "wordbook_neighbor"
  | "recent_import"
  | "manual_seed";

export interface L3RecommendationEvidence {
  type: L3RecommendationEvidenceType;
  ref: Json;
  weight?: number;
  note?: string;
}

export interface L3RecommendationRunRow {
  id: string;
  user_id: string;
  wordbook_id: string | null;
  mode: L3RecommendationRunMode;
  status: L3RecommendationRunStatus;
  input_hash: string | null;
  stats: Json;
  created_at: string;
  completed_at: string | null;
}

export interface L3RecommendationItemRow {
  id: string;
  run_id: string;
  user_id: string;
  wordbook_id: string | null;
  recommendation_type: L3RecommendationType;
  status: L3RecommendationStatus;
  title: string;
  summary: string;
  priority_score: number | string;
  confidence: number | string;
  reason_codes: Json;
  evidence: Json;
  payload: Json;
  accepted_proposal_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  dismissed_at: string | null;
}

export interface L3RecommendationBundle {
  run: L3RecommendationRunRow;
  items: L3RecommendationItemRow[];
  stats: Json;
}

export interface L3RecommendationAcceptResult {
  item: L3RecommendationItemRow;
  proposal?: L3ProposalBundle;
  actionPayload?: Json;
}
