/**
 * Repository interfaces — contracts that concrete repositories implement.
 *
 * Parameter order convention: (userId, wordbookId, wordId, ...) —
 * wordbookId always precedes wordId for consistency.
 */

import type {
  BatchImportMode,
  BatchImportOutcome,
} from "../domain/ingest/batch-import-mode";

import type {
  Direction,
  WordRow,
  WordSummary,
  PaginatedResult,
  GetPublicWordsOptions,
  UserWordProgressRow,
  UserWordL2ProgressRow,
  UpgradeWorkOrderRow,
  L2DrillStepRow,
  L2ContentRow,
  L3ContextLinkListItem,
  L3ContextLinkRow,
  L3ContextLinkTargetType,
  L3ContextLinkType,
  L3ContextRow,
  L3ContextDetail,
  L3GraphReadModel,
  L3ImportJobRow,
  L3OccurrenceListItem,
  L3OccurrenceRow,
  L3PaginatedList,
  L3PaperListPage,
  L3PaperRow,
  L3AnnotationOptionKey,
  L3AnnotationTagRow,
  L3QuestionAnnotationRow,
  L3QuestionAssessmentRow,
  L3QuestionAttemptRow,
  L3GradingResultRow,
  GradingVerdict,
  L3SheetArchiveRow,
  L3SubmissionRow,
  SealMode,
  SheetScope,
  L3PracticeAttemptPage,
  L3PracticeFilePage,
  L3QuestionRow,
  L3PracticeAttemptRow,
  L3PracticeErrorBookPage,
  L3ErrorBookKind,
  L3ErrorBookPage,
  L3PracticeOutcome,
  L3PracticeType,
  L3ProposalBundle,
  L3ProposalItemRow,
  L3ProposalRow,
  L3ReadStats,
  L3RecommendationItemRow,
  L3RecommendationRunRow,
  L3SessionContextSummary,
  L3SessionRow,
  L3SessionStatus,
  L3SessionType,
  L3SourceContextListItem,
  L3SourceRow,
  L3SourceListPage,
  L3SourceSpace,
  L3SpaceSummaryDay,
  L3SubSpace,
  L3WordSpace,
  L3WordContextListItem,
  NoteEntryRow,
  WordbookRow,
  HighlightRow,
  AnnotationRow,
  SessionRow,
  ReviewState,
  ReviewRating,
  SemanticFieldGroupRow,
  PlazaWordRow,
  RootFamilyGroupRow,
  RootMasteryFamilyRow,
  Json,
} from "../domain";
import type {
  HuluPageWordRow,
  HuluPlanRow,
  HuluPlanStatus,
  HuluProtocolVersion,
  HuluRoundKind,
  HuluRoundRow,
} from "../domain/hulu-sprint";
import type { OtherBookL2Signal } from "../domain/upgrade-suggestion";
import type { IL3WritingRepository } from "./l3-writing.repository";
import type { IL3WritingFeedbackRepository } from "./l3-writing-feedback.repository";
import type { IL3StudyNoteRepository } from "./l3-study-notes.repository";
import type { IL3StudyTopicRepository } from "./l3-study-topics.repository";
import type { IL3StudyReferenceRepository } from "./l3-study-references.repository";

// ── Word ────────────────────────────────────────────────────────────────
export interface FindBySlugOptions {
  /**
   * 允许用 `words.aliases` 兜底解析。
   *
   * 背景：读侧（详情页 / L3 划词查词）拿到的是**语料里的原样形态**
   * （`hospitals` / `today's` / `abandoned`），而 slug 只登记基词
   * （`hospital` / `today` / `abandon`）。不开这个开关时这些形态一律 404，
   * L3 还会因此判定「不在库」并新建 stub 词条。
   *
   * **默认关闭**，因为并非所有调用方都想要模糊解析：
   * `deleteStubWord` 必须精确匹配 —— 否则 `DELETE /words/abandoned` 会解析到
   * `abandon` 并可能删掉一个与该 URL 无关的词条。
   */
  allowAlias?: boolean;
}

export interface IWordRepository {
  findById(id: string): Promise<WordRow | null>;
  findBySlug(slug: string, options?: FindBySlugOptions): Promise<WordRow | null>;
  findPublic(options: GetPublicWordsOptions): Promise<PaginatedResult<WordSummary>>;
  /** 输入联想：按 lemma / 拼音前缀返回 top-N 建议（L1-2）。 */
  suggest(q: string, limit?: number): Promise<WordSummary[]>;
  /**
   * 词汇广场（P4）：按 L1 语义场 source_path 前缀实时聚合分组（自生长集合）。
   * q 非空时在 SQL 层按语义场名过滤。
   */
  findSemanticFieldGroups(q?: string): Promise<SemanticFieldGroupRow[]>;
  /**
   * 词汇广场（P4）：按 morphology_root 提取词根 token 聚合家族（自生长集合）。
   * minCount 过滤最小家族规模；q 按词根子串；letter 按词根首字母。
   */
  findRootFamilyGroups(opts?: { minCount?: number; q?: string; letter?: string }): Promise<RootFamilyGroupRow[]>;
  /** 词汇广场（P4）：取某语义场 source_path 前缀下的全部已发布词（含 updated_at）。 */
  findBySourcePathPrefix(prefix: string): Promise<PlazaWordRow[]>;
  /** 词汇广场（P4）：取词根 token 命中（作为 morphology_root 任一部分）的全部已发布词。 */
  findByRootToken(token: string): Promise<PlazaWordRow[]>;
  /**
   * 词汇广场（P4 E1）：按 wordIds 聚合集合内的复习统计（已追踪 / 待复习 /
   * 掌握分档 P1-B：mastered=review 态，learning=learning+relearning）。
   * user_word_progress 走 owner RLS，必须在携带 actorId=userId 的事务内执行。
   */
  countReviewStatsByWordIds(
    userId: string,
    wordIds: string[],
  ): Promise<{ tracked: number; due: number; mastered: number; learning: number }>;
  /**
   * 词汇广场（0052 / P1-C）：按 token 批量取词根词典（核心义 + 变体族）。
   * 全局共享只读表（RLS public read）；未命中返回空 Map。
   */
  findRootLexiconByTokens(
    tokens: string[],
  ): Promise<Map<string, { meaningZh: string; variants: string[] }>>;
  /**
   * 词汇广场（P2-2）：词根家族掌握矩阵（mastered/learning 分档）。
   * 须在携带 actorId=userId 的事务内执行（owner-scoped RLS 表）。
   */
  findRootMasteryMatrix(
    userId: string,
    opts?: { minCount?: number; tokens?: string[] },
  ): Promise<RootMasteryFamilyRow[]>;
  count(): Promise<number>;
  findSlugs(limit?: number): Promise<string[]>;
  /**
   * 批量导入词条（导入页的「JSON 粘贴」路径 = `POST /words/batch`）。
   *
   * ⚠️ 这条路径的 `definition_md` / `body_md` 是从 `short_definition` **派生**的，
   * 所以「无条件覆盖」会把库里已有的富内容冲成一句话（实测 abandon 的
   * definition_md 从 240 字符塌缩到 19 字符；short 缺省时更会变成空串，
   * 把词条打成 stub）。因此默认 `fill-only`：已有非空字段不被覆盖，
   * 且**根本不写** definition_md / body_md。
   *
   * `mode: "overwrite"` 才恢复旧行为（调用方要显式声明「就是要改写」）。
   * 返回值区分新增 / 更新 / 未变，便于告诉使用者这批到底改了什么。
   */
  insertMany?(words: Array<{
    slug: string; title: string; lemma: string; pos: string | null;
    cefr: string | null; ipa: string | null; short_definition: string | null;
  }>, mode?: BatchImportMode): Promise<BatchImportOutcome>;
  /**
   * Full-note upsert through the dedicated batch-import role. Hash-guarded:
   * when the stored content_hash already equals the incoming one the update
   * is skipped ("unchanged"). Writes definition/body/metadata/etc. beyond the
   * minimal stub fields handled by insertMany. MUST be called outside an app
   * transaction (uses its own pool); each call is atomic on its own.
   */
  upsertFullWord?(input: UpsertFullWordInput): Promise<"imported" | "unchanged">;
  /**
   * 详情页硬删 stub 词条（0023，stub 生命周期）：锁定 + 阻塞检查 + 守卫删除。
   * words 全局无 user_id，stub 谓词 definition_md='' 是唯一安全护栏
   * （DB 触发器 enforce_word_stub_delete 双重兜底）。
   */
  lockStubWordById(wordId: string): Promise<WordRow | null>;
  getWordDeleteBlockers(userId: string, wordId: string): Promise<WordDeleteBlockers>;
  deleteWordById(userId: string, wordId: string): Promise<WordRow | null>;
}

/** 详情页删除 stub 词条的 409 阻塞详情（三项；复习进度/词单成员随 FK 级联，不阻塞）。 */
export interface WordDeleteBlockers {
  /** 绑定的 L3 语境（occurrence）——引导先到素材空间删除语境。 */
  l3OccurrenceCount: number;
  /** 用户笔记条目——真实用户数据，不可静默级联。 */
  noteEntryCount: number;
  /** 入站语境链接软引用（target_type='word'，target_id 为 text 无 FK，防悬挂）。 */
  inboundWordLinkCount: number;
}

/** Payload for the rich-note import upsert (all words-table content fields). */
export interface UpsertFullWordInput {
  slug: string;
  title: string;
  lemma: string;
  pos: string | null;
  cefr: string | null;
  ipa: string | null;
  aliases: string[];
  shortDefinition: string | null;
  definitionMd: string;
  bodyMd: string;
  /** JSON.stringify-ready payload for the examples jsonb column. */
  examplesJson: unknown;
  metadataJson: unknown;
  coreDefinitionsJson: unknown;
  prototypeText: string | null;
  contentHash: string;
  sourcePath: string;
  sourceUpdatedAt: string | null;
  isPublished: boolean;
  qualityStatus: "ok" | "needs_supplement";
  qualityIssuesJson: unknown;
}

// ── Review ──────────────────────────────────────────────────────────────
/** Progress row joined with words for FOR UPDATE locking. */
export interface ProgressWithContentHash extends UserWordProgressRow {
  content_hash: string;
  /**
   * L1 专属 hash（`words.l1_content_hash`，ADR-0002 双轨隔离）。
   * 作答时随 L1 快照一并落库；列可空（历史 stub / 未回填的词），
   * 缺失时服务层回退用 `content_hash`（全量）填快照。
   */
  l1_content_hash: string | null;
  word_slug: string;
  word_title: string;
  word_lemma: string;
}

/** Minimal progress fields needed for skip/suspend (not full row). */
export interface ProgressForAction {
  id: string;
  word_id: string;
  wordbook_id: string;
  state: ReviewState;
  skip_count: number;
}

/** Input for creating a brand-new L1 card (state='new'). */
export interface InsertNewCardInput {
  userId: string;
  wordId: string;
  wordbookId: string;
  /** Numeric string written to desired_retention, e.g. "0.850". */
  desiredRetention: string;
}

/** Result status of an atomic new-card insert attempt. */
export type InsertNewCardStatus =
  | { status: "inserted"; progressId: string }
  | { status: "duplicate"; progressId: null }
  | { status: "word_not_found"; progressId: null }
  | { status: "wordbook_invalid"; progressId: null };

/**
 * 一键遗忘预览行（ADR-0020）：该书每条 L1 进度 + 词条锚点元数据（词根/助记/语义链/别名）。
 * 纯读，喂 computeAnchorCandidates 的入参形状；numeric 列已在仓库层归一为 number|null。
 */
export interface ForgettingPreviewRow {
  wordId: string;
  state: string;
  stability: number | null;
  retrievability: number | null;
  recentRatings: string[];
  lapseCount: number;
  /** words.metadata->>'morphology_root'（如 "pre+dict"）。 */
  morphology: string | null;
  /** words.metadata->>'mnemonic_text'（回退 metadata->>'mnemonic'）。 */
  mnemonic: string | null;
  /** words.metadata->>'semantic_chain'。 */
  semanticChain: string | null;
  /** words.aliases（屈折/变体形）。 */
  aliases: string[];
}

/** 一键遗忘批量挂起入参（keepWordIds = 锚点保留集，永不挂起）。 */
export interface BulkSuspendByWordbookInput {
  userId: string;
  wordbookId: string;
  keepWordIds: string[];
  /** 服务生成；写入每条 review_logs.metadata.batchId，供 restore 精确回溯。 */
  batchId: string;
}

/** 一键遗忘批量恢复入参（只回溯本批次日志）。 */
export interface BulkForgetBatchInput {
  userId: string;
  wordbookId: string;
  batchId: string;
}

/**
 * 葫芦冲刺挂起入参（ADR-0041 决策 5 / 完备设计 R1）。
 *
 * 与一键遗忘的区别：**范围含 `new`**（有快照即安全，且目标是整批退出到期队列；
 * 一键遗忘排除 `new` 的动机不同）；**不写 review_logs** —— 快照直接落在计划行
 * 的 `suspend_snapshot`，故没有 batchId。
 */
export interface BulkSuspendByWordIdsInput {
  userId: string;
  wordbookId: string;
  wordIds: string[];
}

/** 队列编辑（P1）：移出复习队列输入（物理删除进度行 + card_removed 审计）。 */
export interface RemoveCardsByWordIdsInput {
  userId: string;
  wordbookId: string;
  wordIds: string[];
}

/** 队列编辑（P1）：提前到期输入（due_at 提到现在，从不延后；挂起词除外）。 */
export interface ExpireCardsByWordIdsInput {
  userId: string;
  wordbookId: string;
  wordIds: string[];
}

/** 挂起恢复入参：快照 `{wordId: 挂起前 state}`（只回写仍处挂起的行）。 */
export interface RestoreSuspendSnapshotInput {
  userId: string;
  wordbookId: string;
  snapshot: Record<string, string>;
}

/** 挂起回返的逐行快照（wordId → 挂起前 state）。 */
export interface SuspendedWordSnapshot {
  wordId: string;
  oldState: string;
}

export interface SaveAnswerInput {
  progressId: string;
  userId: string;
  wordId: string;
  wordbookId: string;
  sessionId: string | null;
  rating: ReviewRating;
  /** M-NEW-4 fix: current word content_hash to refresh snapshot */
  contentHash: string;
  /**
   * L1 专属 hash（`words.l1_content_hash`）—— 写入 `l1_content_hash_snapshot`。
   *
   * 快照列必须装**同一 hash 空间**的值：`deriveContentStaleness` 拿
   * `words.l1_content_hash` 与 `l1_content_hash_snapshot` 配对比较（L1 专属对），
   * 装全量 hash 会跨空间比对、恒不相等 ⇒ 每张学过的词都被误报"重新核对"。
   * 词条无 L1 hash 时由调用方回退传 `contentHash`（全量）——此时 L1 对仍不可比，
   * 派生自动降级到全量对（见 src/domain/content-staleness.ts）。
   */
  l1ContentHash: string | null;
  scheduling: {
    difficulty: number | null;
    dueAt: string;
    logDueAt: string | null;
    elapsedDays: number;
    scheduledDays: number;
    retrievability: number | null;
    stability: number | null;
    state: ReviewState;
    nextPayload: Json;
  };
  idempotencyKey: string | null;
  previousSnapshot: Json;
  logMetadata: Record<string, unknown>;
  /**
   * 阶梯起步档结算结果（ADR-0036 决策 1）：服务层用 domain 纯函数结算后传入，
   * saveAnswer 以 COALESCE 落列；null/缺省 = 保持原值（mock/旧调用兼容）。
   */
  ladderRung?: number | null;
}

/** Result of an undo RPC call. */
export interface UndoRpcResult {
  success: boolean;
  progressId: string | null;
  wordId: string | null;
  errorMessage: string | null;
}

export interface IReviewRepository {
  findDueCards(userId: string, wordbookId: string, limit: number): Promise<
    Array<{ progress: UserWordProgressRow; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null; examples: unknown[]; prototype_text: string | null; mnemonic_text: string | null; mnemonic_type: string | null; semantic_chain: string | null } }>
  >;

  /**
   * Due candidate pool consumed by the P1 queue-priority builder. Carries the
   * row-level needs_recheck mark plus the words-side hashes, so the service can
   * derive "content changed" at read time (ADR-0021).
   */
  findDueCandidates(userId: string, wordbookId: string, limit: number): Promise<
    Array<{ progress: UserWordProgressRow & { needs_recheck: boolean; content_hash: string; l1_content_hash: string | null }; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null; examples: unknown[]; prototype_text: string | null; mnemonic_text: string | null; mnemonic_type: string | null; semantic_chain: string | null } }>
  >;

  /** All active (non-suspended) cards regardless of due_at — used by cram/preview practice modes. */
  findPracticeCards(userId: string, wordbookId: string, limit: number): Promise<
    Array<{ progress: UserWordProgressRow; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null; examples: unknown[]; prototype_text: string | null; mnemonic_text: string | null; mnemonic_type: string | null; semantic_chain: string | null } }>
  >;

  /** Free-review selection: fetch words by ids directly (published only), independent of review progress. */
  findWordsByIds(wordIds: string[]): Promise<
    Array<{ id: string; slug: string; title: string; lemma: string; short_definition: string | null; ipa: string | null; pos: string | null; cefr: string | null; examples: unknown[]; prototype_text: string | null; mnemonic_text: string | null; mnemonic_type: string | null; semantic_chain: string | null }>
  >;

  /** Drill candidates: already-reviewed words joined with examples for cloze resolution. */
  findDrillCandidates(userId: string, wordbookId: string, limit: number): Promise<
    Array<{ progress: UserWordProgressRow; word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null; examples: Json } }>
  >;

  getStats?(userId: string, wordbookId: string): Promise<{
    todayCount: number;
    totalCount: number;
    ratingDist: { again: number; hard: number; good: number; easy: number };
    /** 阶梯会话分组（ADR-0036 LW-2）：metadata.source='typing' 的作答聚合。 */
    ladder?: {
      sessions: number;
      tierDist: { dictation: number; listen: number; copy: number };
      downgradeRate: number | null;
      avgWrongTimes: number | null;
    };
  }>;

  findLeeches?(userId: string, wordbookId: string, limit: number): Promise<Array<UserWordProgressRow & { slug: string; title: string; lemma: string; w_id: string; short_definition: string | null }>>;

  getTimeline?(userId: string, wordbookId: string, limit: number): Promise<Array<{ id: string; rating: string; created_at: string; word_slug: string; word_lemma: string }>>;

  getHeatmap?(userId: string, wordbookId: string, days: number): Promise<Array<{ date: string; count: string }>>;

  /** User-scoped advisory lock + idempotency check. MUST be in a transaction. */
  checkIdempotency(userId: string, idempotencyKey: string): Promise<string | null>;

  /** Owner-scoped SELECT FOR UPDATE with word join. MUST be in a transaction. */
  findProgressForUpdate(progressId: string, userId: string): Promise<ProgressWithContentHash | null>;

  /** SELECT FOR UPDATE minimal fields for skip. MUST be in a transaction. */
  findProgressForSkip(progressId: string, userId: string): Promise<ProgressForAction | null>;

  /** SELECT FOR UPDATE minimal fields for suspend. MUST be in a transaction. */
  findProgressForSuspend(progressId: string, userId: string): Promise<ProgressForAction | null>;

  /**
   * 主动晋升入口（Phase F）：按 (user, wordbook, word) 读 L1 进度行。
   * owner-RLS 表——调用方必须在 actor 事务内执行（无 requireTx，读侧由注入闭包保证）。
   */
  findByUserWordbookWord(userId: string, wordbookId: string, wordId: string): Promise<UserWordProgressRow | null>;

  /** Load the current authoritative progress for outbox convergence. MUST be in a transaction. */
  findProgressForOutbox(progressId: string, userId: string, wordbookId: string): Promise<UserWordProgressRow | null>;

  /**
   * Atomically create a new L1 card (state='new', algo='fsrs'). Guards word
   * existence and wordbook ownership in the same transaction; duplicate
   * (user_id, word_id, wordbook_id) resolves to 'duplicate' instead of throwing.
   * MUST be in a transaction.
   */
  insertNewCard(input: InsertNewCardInput): Promise<InsertNewCardStatus>;

  /** UPDATE progress + INSERT review_log. MUST be in a transaction. */
  saveAnswer(input: SaveAnswerInput): Promise<{ reviewLogId: string }>;

  /** UPDATE skip_count + INSERT review_log (action=skip). MUST be in a transaction. */
  skipCard(progress: ProgressForAction, userId: string, sessionId: string | null, idempotencyKey: string | null): Promise<{ reviewLogId: string }>;

  /** UPDATE state=suspended + INSERT review_log (action=suspend). MUST be in a transaction. */
  suspendCard(progress: ProgressForAction, userId: string, sessionId: string | null, idempotencyKey: string | null): Promise<{ reviewLogId: string }>;

  // ── 一键遗忘（ADR-0020，书级批量挂起/恢复）────────────────────────────
  /**
   * 该书预览行（L1 进度 + 词条锚点元数据），只读。owner-RLS 表，
   * 调用方必须在携带 actorId 的事务内执行。
   */
  findForgettingPreviewRows(userId: string, wordbookId: string): Promise<ForgettingPreviewRow[]>;

  /**
   * 预览计数：与 {@link bulkSuspendByWordbook} **完全同条件**的可挂起行数
   * （state NOT IN ('suspended','new') AND word_id <> ALL(keepWordIds)）。
   */
  countBulkSuspendCandidates(input: {
    userId: string;
    wordbookId: string;
    keepWordIds: string[];
  }): Promise<number>;

  /**
   * 一键遗忘批量挂起（单条 set-based 写）：非锚点、非 suspended/new 的 L1 行置
   * state='suspended' + 单条 INSERT…SELECT 写 review_logs（rating=NULL、metadata
   * action='bulk_forget'、previous_progress_snapshot 保真旧 state）。**不删、不改
   * stability、不推 due**。返回受影响（挂起）行数。MUST be in a transaction。
   */
  bulkSuspendByWordbook(input: BulkSuspendByWordbookInput): Promise<number>;

  /** restore 前置校验：该 (user, wordbook, batchId) 是否存在 bulk_forget 日志。 */
  findBulkForgetBatch(input: BulkForgetBatchInput): Promise<boolean>;

  /**
   * 只按本批次日志回写 user_word_progress.state（取 previous_progress_snapshot->>'state'）。
   * 不触碰 stability/due_at。返回受影响行数。MUST be in a transaction。
   */
  restoreBulkForget(input: BulkForgetBatchInput): Promise<number>;

  /**
   * 葫芦冲刺批量挂起（ADR-0041 决策 5，经批准的第 9 个 state 写点）。
   *
   * 单条语句完成「快照 + 挂起」并回返快照：把 wordIds 中 `state <> 'suspended'`
   * 的行置为 suspended，`RETURNING` 出每行的**挂起前** state 供计划行落快照。
   * **不写 review_logs**（与 bulkSuspendByWordbook 的关键区别：葫芦的快照在计划
   * 行上，不需要批次日志；这也是「零 FSRS 写入」的落点）。
   * MUST be in a transaction。
   *
   * P0 期只加方法、不接线（服务层在 P0 拒绝 suspendReview=true）。
   */
  bulkSuspendByWordIds(input: BulkSuspendByWordIdsInput): Promise<SuspendedWordSnapshot[]>;

  /**
   * 队列编辑（P1）：移出复习队列 —— 按 wordIds 物理删除进度行，逐词写
   * `card_removed` 审计日志（rating=NULL；review_logs.progress_id 无外键，
   * 审计可安全引用已删行）。scope 钉死 (user, wordbook)；未命中幂等零行。
   * MUST be in a transaction。
   */
  removeCardsByWordIds(input: RemoveCardsByWordIdsInput): Promise<string[]>;

  /**
   * 队列编辑（P1）：提前到期 —— `due_at = LEAST(COALESCE(due_at, now()), now())`
   * （只提前、从不延后；挂起词除外）。候选池排序 due_at ASC NULLS LAST 会把它
   * 提到新卡之前、到期桶内按到期先后排队。MUST be in a transaction。
   */
  expireCardsByWordIds(input: ExpireCardsByWordIdsInput): Promise<string[]>;

  /**
   * 葫芦冲刺挂起恢复（ADR-0041 决策 5，第 10 个 state 写点）：
   * 用 `jsonb_to_recordset` 展开快照，**只回写仍处 suspended 的行**（用户手动
   * 恢复过的词不动）。返回回写行数。**不写 review_logs**。MUST be in a transaction。
   *
   * P0 期只加方法、不接线。
   */
  restoreSuspendSnapshot(input: RestoreSuspendSnapshotInput): Promise<number>;

  /** Resolve the owner-scoped wordbook for an undoable review log. MUST be in a transaction. */
  findReviewLogWordbookForUndo(reviewLogId: string, userId: string): Promise<string | null>;

  /** Call owner/wordbook-scoped undo_review_log RPC + insert idempotency log. MUST be in a transaction. */
  undoReviewLog(
    reviewLogId: string,
    userId: string,
    wordbookId: string,
    sessionId: string,
    idempotencyKey: string | null,
  ): Promise<UndoRpcResult>;

  findStaleCards(wordId: string): Promise<UserWordProgressRow[]>;

  /** @deprecated Use {@link markL1StaleForRecheck} — tracks the L1 hash
   *  snapshot separately. Kept for backward compatibility. */
  markStaleForRecheck(wordId: string, newHash: string): Promise<number>;

  /** Mark stale cards for recheck using the L1 content hash snapshot. */
  markL1StaleForRecheck(wordId: string, newL1Hash: string): Promise<number>;

  /**
   * Set the L1 weak-signal flag for a single progress row, scoped to
   * (user, wordbook, word). Phase 2C decision-2: L2→L1 only *marks* — it
   * never re-cards or touches due_at/needs_recheck. The user decides whether
   * to re-grind L1 after seeing the flag in the UI.
   *
   * Returns the number of rows updated (0 if no progress row exists).
   */
  markL1WeakSignal(
    userId: string,
    wordbookId: string,
    wordId: string,
    value: boolean,
  ): Promise<number>;
}

// ── Transactional Outbox ───────────────────────────────────────────────
export type OutboxStatus = "pending" | "retry" | "processing" | "processed" | "dead_letter";

export interface OutboxEventRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Json;
  dedupe_key: string;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  available_at: string;
  locked_at: string | null;
  locked_until: string | null;
  locked_by: string | null;
  last_error: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueOutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Json;
  dedupeKey: string;
  maxAttempts?: number;
}

export interface OutboxMetrics {
  pending: number;
  processing: number;
  deadLetter: number;
  oldestPendingAgeSeconds: number | null;
}

export interface IOutboxRepository {
  /** Insert an event in the caller's authoritative transaction. */
  enqueue(input: EnqueueOutboxEventInput): Promise<{ id: string; inserted: boolean }>;
  /** Requeue expired leases, or dead-letter them when attempts are exhausted. */
  recoverExpiredLeases(): Promise<number>;
  /** Atomically claim an ordered batch using FOR UPDATE SKIP LOCKED. */
  claimBatch(workerId: string, limit: number, leaseSeconds: number): Promise<OutboxEventRow[]>;
  /** Lock the claimed event and return false when this effect already has a receipt. */
  beginEffect(eventId: string, effectName: string, workerId: string): Promise<boolean>;
  /** Record a completed effect in the same transaction as the effect write. */
  completeEffect(eventId: string, effectName: string): Promise<void>;
  markProcessed(eventId: string, workerId: string): Promise<void>;
  markFailed(eventId: string, workerId: string, errorMessage: string, retryDelaySeconds: number): Promise<OutboxStatus>;
  replayDeadLetter(eventId: string): Promise<boolean>;
  getMetrics(): Promise<OutboxMetrics>;
}

// ── Note entry(条目制笔记)──────────────────────────────────────────────
export interface INoteEntryRepository {
  /** 词的全部条目(含已隐藏),按创建时间正序。 */
  listByWord(userId: string, wordbookId: string, wordId: string): Promise<NoteEntryRow[]>;
  /** 复习队列附带:批量取多个词的可见条目(hidden_at IS NULL)。 */
  listVisibleByWordIds(
    userId: string,
    wordbookId: string,
    wordIds: string[],
  ): Promise<Array<NoteEntryRow>>;
  insert(userId: string, wordbookId: string, wordId: string, contentMd: string): Promise<NoteEntryRow>;
  /** 编辑单条内容;条目不存在或非本人 → null。 */
  updateContent(userId: string, entryId: string, contentMd: string): Promise<NoteEntryRow | null>;
  /** 非破坏隐藏:置 hidden_at;幂等。 */
  hide(userId: string, entryId: string): Promise<NoteEntryRow | null>;
  /** 恢复:清 hidden_at;幂等。 */
  restore(userId: string, entryId: string): Promise<NoteEntryRow | null>;
  /** 硬删除(破坏性,详情页专属);返回是否删除了行。 */
  remove(userId: string, entryId: string): Promise<boolean>;
  /** 笔记列表页:可见条目 + 词信息,按创建时间倒序分页。 */
  listByUser(userId: string, limit: number, offset: number): Promise<Array<NoteEntryRow & { word_slug: string; word_lemma: string; word_title: string }>>;
}

// ── Wordbook ────────────────────────────────────────────────────────────
export interface IWordbookRepository {
  findById(id: string): Promise<WordbookRow | null>;
  findDefaultByUser(userId: string): Promise<WordbookRow | null>;
  findAllByUser(userId: string): Promise<WordbookRow[]>;
  create(userId: string, name: string, isDefault?: boolean, description?: string | null): Promise<WordbookRow>;
  getOrCreateDefault(userId: string): Promise<WordbookRow>;
  countWords(wordbookId: string): Promise<number>;
  getWordIds(wordbookId: string): Promise<string[]>;
  addWords(wordbookId: string, wordIds: string[]): Promise<void>;
}

// ── Highlight ───────────────────────────────────────────────────────────
export interface IHighlightRepository {
  findByWords(userId: string, wordbookId: string, wordIds: string[]): Promise<HighlightRow[]>;
  create(
    userId: string,
    wordId: string,
    wordbookId: string,
    sourceField: string | null,
    textSnippet: string,
    color: string,
  ): Promise<HighlightRow>;
  delete(userId: string, wordbookId: string, highlightId: string): Promise<void>;
}

// ── Annotation ──────────────────────────────────────────────────────────
export interface IAnnotationRepository {
  findByWord(userId: string, wordbookId: string, wordId: string): Promise<AnnotationRow | null>;
  upsert(userId: string, wordbookId: string, wordId: string, content: string): Promise<AnnotationRow>;
  delete(userId: string, wordbookId: string, annotationId: string): Promise<void>;
}

// ── Session ─────────────────────────────────────────────────────────────
export interface ISessionRepository {
  findActiveByUser(userId: string, wordbookId: string, mode?: string): Promise<SessionRow | null>;
  getOrCreateToday(userId: string, wordbookId: string, mode?: string): Promise<SessionRow>;
  create(userId: string, wordbookId: string, mode?: string): Promise<SessionRow>;
  /** Lock and verify an active Session belongs to the actor and wordbook. MUST be in a transaction. */
  assertActiveOwned(sessionId: string, userId: string, wordbookId: string): Promise<void>;
  incrementCardsSeen(sessionId: string, userId: string, wordbookId: string): Promise<void>;
  /** Apply a previously authorized review event even if the Session ended after commit. MUST be in a transaction. */
  incrementCardsSeenFromOutbox(sessionId: string, userId: string, wordbookId: string): Promise<void>;
  endSession(sessionId: string, userId: string, wordbookId: string): Promise<void>;
}

// ── L2 Progress ─────────────────────────────────────────────────────────
/** Input for creating a new L2 progress row (inherited from L1 FSRS state). */
export interface NewL2Progress {
  user_id: string;
  wordbook_id: string;
  word_id: string;
  l2_stability: number;
  l2_difficulty: number;
  l2_state: string;
  l2_desired_retention: number;
  l2_due_at: string;
  l2_inherited_from_l1: boolean;
  l2_weights_source: string;
  /**
   * Initial StoredSchedulerCard (2026-08-24 l2-drill spec §四 payload 断路修复).
   * Inherited rows are born in ts-fsrs Review state with the inherited
   * S/D — without this, toCard({}) degrades the card to a fresh New card.
   */
  l2_scheduler_payload?: Json;
}

/** Word content caches joined for L2 drill queue/task generation (spec §五). */
export interface L2WordContent {
  id: string;
  slug: string;
  title: string;
  lemma: string;
  pos: string | null;
  ipa: string | null;
  cefr: string | null;
  short_definition: string | null;
  corpus_items: Json;
  synonym_items: Json;
  antonym_items: Json;
}

/** SELECT FOR UPDATE result for the L2 answer path (spec §八 step 2). */
export interface L2ProgressForUpdate {
  progress: UserWordL2ProgressRow;
  word: L2WordContent;
}

/** Persist one L2 review: full l2_* reschedule + track='l2' review log. */
export interface SaveL2AnswerInput {
  progressId: string;
  userId: string;
  wordbookId: string;
  wordId: string;
  rating: ReviewRating;
  state: string;
  stability: number | string | null;
  difficulty: number | string | null;
  retrievability: number | string | null;
  dueAt: string;
  lastReviewedAt: string;
  intervalDays: number | null;
  scheduledDays: number | null;
  /** H3 修复：距上次复习的流逝天数（来自 FSRS scheduling.elapsedDays）。
   * 之前 INSERT 把 scheduledDays 错填到 elapsed_days 列、scheduled_days 恒为 null，
   *  导致 L2 track 的 review_logs 审计数据错乱。 */
  elapsedDays: number | null;
  nextPayload: Json;
  contentHashSnapshot: string;
  previousSnapshot: Json;
  logMetadata: Json;
  sessionId: string | null;
  idempotencyKey: string | null;
}

export interface NewL2DrillStep {
  session_id: string;
  user_id: string;
  wordbook_id: string;
  word_id: string;
  progress_id: string;
  step_index: number;
  step_type: "l2_discrimination" | "l2_production";
  task_id?: string | null;
  task_type?: string | null;
  task_payload?: Json;
}

export interface IL2ProgressRepository {
  /**
   * Find a single L2 progress row scoped to (user, wordbook, word).
   * Wordbook scoping is mandatory: the same user reviewing the same word in
   * two different wordbooks must have independent L2 progress rows.
   */
  findByWordbookWordAndUser(
    userId: string,
    wordbookId: string,
    wordId: string,
  ): Promise<UserWordL2ProgressRow | null>;
  /**
   * 是否已为该词晋升出 L2 行（跨词书 EXISTS）。供词条详情"待扩展"提示使用。
   */
  existsByUserAndWord(userId: string, wordId: string): Promise<boolean>;
  /**
   * 他书该词的"最佳"L2 行（ADR-0018 §3 提前升级 seed 来源，只读）。
   *
   * 排序键**写死在此处**，避免各调用方各自重解释"最佳"：
   *   1. l2_state 优先级：review > relearning > learning > new > 其他；
   *   2. l2_stability DESC（NULL 视为 -1，排最后）；
   *   3. l2_due_at DESC（NULLS LAST —— 越晚到期视作越新近的掌握状态）；
   *   4. id ASC（稳定 tie-break，保证同输入恒同输出）。
   *
   * 只返回单行；excludeWordbookId 排除当前书（seed 只许取"他书"）。
   */
  findBestByWordAndUser(
    userId: string,
    wordId: string,
    excludeWordbookId: string,
  ): Promise<UserWordL2ProgressRow | null>;
  /**
   * 他书 L2 掌握信号（只读最小投影），直接喂
   * {@link computeUpgradeSuggestion} 的 otherBooksL2 入参（ADR-0018 §2）。
   * 已由 SQL 排除当前书；一行 = 一本他书的 L2 状态。
   */
  findOtherBookSignals(
    userId: string,
    wordId: string,
    excludeWordbookId: string,
  ): Promise<OtherBookL2Signal[]>;
  /**
   * ADR-0018 §3 提前升级（seed）审计行：track='l2'、rating=NULL，
   * metadata 记 seeded_from（来源 progress id / wordbook id）。仅 seed 路径写。
   * MUST be in a transaction（actor RLS）。
   */
  insertL2SeedAuditLog(input: {
    userId: string;
    wordId: string;
    wordbookId: string;
    /** 新建 L2 行的 progress id。 */
    progressId: string;
    /** seed 来源（他书最佳行）。 */
    seededFromProgressId: string;
    seededFromWordbookId: string;
    state: string;
    dueAt: string;
    stability: number;
    difficulty: number;
  }): Promise<void>;
    insert(data: NewL2Progress): Promise<UserWordL2ProgressRow>;
    /** L2 到期口径队列（l2_drill spec §一）：未暂停且 l2_due_at <= now，按到期升序。 */
    findDueCards(
      userId: string,
      wordbookId: string,
      limit: number,
    ): Promise<Array<{ progress: UserWordL2ProgressRow; word: L2WordContent }>>;
    /** SELECT FOR UPDATE + JOIN words 缓存（spec §八 step 2）。MUST be in a transaction. */
    findForUpdate(progressId: string, userId: string): Promise<L2ProgressForUpdate | null>;
    /**
     * Atomically persist one L2 review: reschedule every l2_* field, append
     * recent_ratings, bump the rating counter + lapse counter, refresh the
     * content-hash snapshot, and INSERT the track='l2' review log.
     * MUST be in a transaction. Returns the new log id for outbox wiring.
     */
    saveL2Answer(input: SaveL2AnswerInput): Promise<{ reviewLogId: string }>;
    /** Capability-stage marker for the production step (spec §〇½ D6'). NULL = 未做过产出。 */
    updateProductionStatus(
      userId: string,
      wordbookId: string,
      wordId: string,
      status: "passed" | "weak" | null,
    ): Promise<void>;
    /** 幂等建步（UNIQUE(session,word,step_index) 冲突时静默返回既有行）。 */
    insertDrillStepIfAbsent(data: NewL2DrillStep): Promise<L2DrillStepRow>;
    /** SELECT FOR UPDATE。MUST be in a transaction. */
    findDrillStepForUpdate(stepId: string, userId: string): Promise<L2DrillStepRow | null>;
    findLastDrillStep(sessionId: string, userId: string): Promise<L2DrillStepRow | null>;
    /**
     * M5 修复：幂等重放查找同会话同词的指定 step_index 行。
     * 用于辨析步重放命中已结算记录后，重新找回产出步入口。
     * 不上锁（SELECT 不带 FOR UPDATE），调用方仅在已确认幂等重放时使用。
     */
    findDrillStepBySessionWordStep(
      sessionId: string,
      userId: string,
      wordId: string,
      stepIndex: number,
    ): Promise<L2DrillStepRow | null>;
    /**
     * M8 修复：取本会话所有 pending 产出步（含 progress + word JOIN）。
     * getQueue 在常规到期卡之外追加这些半截会话步，让前端刷新后能继续走产出。
     * 不上锁：调用方在写路径（INSERT 已完成，仅做读侧补集）。
     */
    findPendingProductionStepsForResume(
      sessionId: string,
      userId: string,
    ): Promise<
      Array<{
        step: L2DrillStepRow;
        progress: UserWordL2ProgressRow;
        word: L2WordContent;
      }>
    >;
    /**
     * M7 修复：L2 辨析步撤销所需的 review_log 行读取。
     * 返回 review_logs.undone / previous_progress_snapshot / word_id / wordbook_id；
     * 必须是 track='l2'、未撤销、且 snapshot 非空。MUST be in a transaction.
     */
    findReviewLogForL2Undo(
      reviewLogId: string,
      userId: string,
    ): Promise<{
      wordId: string;
      wordbookId: string;
      undone: boolean;
      previousSnapshot: Json;
    } | null>;
    /**
     * M7 修复：把 previous_progress_snapshot 回写到 user_word_l2_progress 行。
     * 与 L1 undo_review_log RPC 对 L1 表的等价动作，但作用于 L2 表。
     * MUST be in a transaction. 返回受影响行数（0 表示 progress 已不存在/不属该用户）。
     */
    applyL2UndoSnapshot(
      progressId: string,
      userId: string,
      previousSnapshot: Json,
    ): Promise<number>;
    /**
     * M7 修复：标记 review_logs 行 undone=true + undone_at=now()。
     * MUST be in a transaction. 返回受影响行数。
     */
    markL2ReviewLogUndone(reviewLogId: string, userId: string): Promise<number>;
    /**
     * M7 修复：插入撤销幂等审计行到 review_logs（track='l2'、rating=NULL、
     * metadata={action:'undo', undone_log_id}）。与 L1 undoReviewLog 的
     * 幂等日志结构对齐，复用 checkIdempotency 的检测路径。MUST be in a transaction.
     */
    insertL2UndoAuditLog(input: {
      userId: string;
      wordId: string;
      wordbookId: string;
      progressId: string;
      sessionId: string;
      reviewLogId: string;
      restoredState: string;
      idempotencyKey: string | null;
    }): Promise<void>;
    completeDrillStep(
      stepId: string,
      userId: string,
      patch: {
        outcome: NonNullable<L2DrillStepRow["outcome"]>;
        mappedRating?: L2DrillStepRow["mapped_rating"];
        reviewLogId?: string | null;
      },
    ): Promise<void>;
    /** 竞态降级：步标 skipped（不产生 outcome/计数）。 */
    skipDrillStep(stepId: string, userId: string): Promise<void>;
    deleteDrillStep(stepId: string, userId: string): Promise<void>;
    /**
     * Atomically persist the canonical L2/full hashes and schedule stale,
     * non-paused L2 progress rows for recheck. L2 content is global per word,
     * so every user/wordbook snapshot for that word is considered.
     */
  finalizeL2ContentHash(wordId: string, newL2Hash: string, newContentHash: string): Promise<number>;
  /** Pause L2 progress scoped to (user, wordbook, word). */
  pause(userId: string, wordbookId: string, wordId: string, reason: string): Promise<void>;
  /** Unpause L2 progress scoped to (user, wordbook, word) by reason. */
  unpauseByReason(userId: string, wordbookId: string, wordId: string, reason: string): Promise<void>;
  /**
   * 一键遗忘 · 书级批量暂停 L2（ADR-0020）：该书全部非锚点 L2 行
   * l2_paused=true / l2_paused_at=now() / l2_paused_reason='manual'，排除 keepWordIds。
   * 不触碰 l2_stability / l2_due_at。返回受影响行数。MUST be in a transaction。
   */
  batchPauseByWordbook(input: {
    userId: string;
    wordbookId: string;
    keepWordIds: string[];
  }): Promise<number>;
  /**
   * 一键遗忘 · 书级恢复 L2（ADR-0020）：仅 unpause 本功能的 manual 暂停
   * （l2_paused_reason='manual'），回到 l2_due_at=now()。返回受影响行数。
   * MUST be in a transaction。
   */
  batchUnpauseManual(userId: string, wordbookId: string): Promise<number>;
}

// ── L2 Content ─────────────────────────────────────────────────────────
/** Input for inserting a new L2 content row (multi-source enrichment). */
export interface NewL2Content {
  word_id: string;
  field: string;
  /**
   * ADR-0017 §2：内容行方向。缺省 `通用`（既有调用方零改动；
   * 升级工单/候选池在生成时指定 `考研`/`雅思` 等）。
   */
  direction?: Direction;
  content: Json;
  source: string;
  source_ref?: string | null;
  approved_by?: string | null;
  /** Phase G 候选池：false = Agent 提案待选（不入缓存）。缺省 true。 */
  is_active?: boolean;
}

export interface IL2ContentRepository {
  insert(data: NewL2Content): Promise<L2ContentRow>;
  findByWord(wordId: string, field?: string): Promise<L2ContentRow[]>;
  /** Phase G 候选池：待选提案（is_active=false 且从未采纳，approved_at IS NULL）。 */
  findCandidatesByWord(wordId: string): Promise<L2ContentRow[]>;
  /** Phase G 管理面板：已退休行（被替换/停用，approved_at 有值）。 */
  findRetiredByWord(wordId: string): Promise<L2ContentRow[]>;
  /** Phase G 管理面板：某字段的全部生效行（替换模式批量停用用）。 */
  findActiveByField(wordId: string, field: string): Promise<L2ContentRow[]>;
  /** Phase G 管理模型：采纳候选 = 激活 + 记录 approved_at/approved_by（与 proposal 永久区分）。 */
  approveAndActivate(id: string, content: unknown): Promise<void>;
  findById(id: string): Promise<L2ContentRow | null>;
  setActive(id: string, isActive: boolean): Promise<void>;
  /** 条目化管理：重写生效行 content（保持原 JSON 形态由调用方负责）。 */
  updateContent(id: string, content: unknown): Promise<void>;
  /** Phase G：拒绝候选 = 硬删。 */
  deleteById(id: string): Promise<void>;
  softDelete(id: string): Promise<void>;
  /** Aggregate active L2 content rows into the words JSONB cache columns. */
  refreshL2Cache(wordId: string): Promise<void>;
}

// ── Upgrade Work Order ─────────────────────────────────────────────────
/** 建工单输入（ADR-0018 §1）。 */
export interface NewUpgradeWorkOrder {
  user_id: string;
  word_id: string;
  wordbook_id: string;
  /** 方向由工单指定（ADR-0017 §2）。 */
  direction: Direction;
  status?: string;
  suggestion_snapshot?: Json | null;
}

/**
 * 待升级清单行：工单行 + words 词面（LEFT JOIN）。
 * `word_slug` / `word_text` 为 null 仅当词行缺失——FK cascade 下理论不可达，
 * 类型上仍如实为 nullable（不假装 join 必然命中）。
 */
export interface UpgradeWorkOrderPendingRow extends UpgradeWorkOrderRow {
  word_slug: string | null;
  word_text: string | null;
}

export interface IUpgradeWorkOrderRepository {
  /** 插入工单。同 (user,word,wordbook) 已有进行中工单时由 23505 暴露给调用方。 */
  insert(data: NewUpgradeWorkOrder): Promise<UpgradeWorkOrderRow>;
  /** 重复标记：刷新既有工单的 direction + suggestion_snapshot（不动 status）。 */
  updateSuggestion(
    userId: string,
    workOrderId: string,
    direction: Direction,
    suggestionSnapshot: Json,
  ): Promise<UpgradeWorkOrderRow | null>;
  /** 进行中工单（标记中 / 升级中）；无则 null。 */
  findActiveByScope(
    userId: string,
    wordbookId: string,
    wordId: string,
  ): Promise<UpgradeWorkOrderRow | null>;
  findByIdForUser(userId: string, workOrderId: string): Promise<UpgradeWorkOrderRow | null>;
  /** 待升级清单：进行中工单（含词面，LEFT JOIN words），按创建时间倒序。 */
  listPending(userId: string, wordbookId: string, limit: number): Promise<UpgradeWorkOrderPendingRow[]>;
  /**
   * 状态推进。`completed: true` 时写 completed_at=now()（其余状态保留原值）。
   * 返回更新行；不存在 / 非本人 → null。
   */
  updateStatus(
    userId: string,
    workOrderId: string,
    status: string,
    options?: { completed?: boolean },
  ): Promise<UpgradeWorkOrderRow | null>;
}

// ── L3 Context Space ───────────────────────────────────────────────────
export interface NewL3Source {
  user_id: string;
  wordbook_id?: string | null;
  source_type: string;
  title: string;
  author?: string | null;
  url?: string | null;
  language?: string | null;
  metadata?: Json;
  content_text?: string | null;
  content_hash?: string | null;
}

export interface NewL3Context {
  user_id: string;
  source_id: string;
  context_type: string;
  text: string;
  normalized_text?: string | null;
  language?: string | null;
  position?: Json;
  metadata?: Json;
}

export interface NewL3Occurrence {
  user_id: string;
  context_id: string;
  word_id: string;
  surface: string;
  lemma?: string | null;
  start_offset?: number | null;
  end_offset?: number | null;
  confidence?: number | null;
  evidence?: Json;
  /** 语境义快照：选自 core_definitions 或手动录入的释义/搭配文本 */
  bound_sense?: string | null;
}

export interface NewL3ContextLink {
  user_id: string;
  context_id?: string | null;
  word_id?: string | null;
  link_type: string;
  target_type: string;
  target_id?: string | null;
  target_ref?: Json;
  confidence?: number | null;
  provenance?: Json;
}

export interface NewL3ImportJob {
  user_id: string;
  source_id?: string | null;
  status: string;
  input_hash: string;
  input_summary?: string | null;
  stats?: Json;
  error?: string | null;
}

export interface L3WordLookup {
  userId: string;
  wordId?: string;
  slug?: string;
  /** 两轴过滤（ADR-0029 §6②）：方向 × 子空间（与练习线同语义）。 */
  direction?: Direction | null;
  space?: L3SubSpace | null;
  limit: number;
  cursor?: string | null;
}

export interface L3SourceLookup {
  userId: string;
  sourceId: string;
  limit: number;
  cursor?: string | null;
}

export interface L3OccurrenceLookup {
  userId: string;
  slug?: string;
  wordId?: string;
  contextId?: string;
  direction?: Direction | null;
  space?: L3SubSpace | null;
  limit: number;
  cursor?: string | null;
}

export interface L3ContextLinkLookup {
  userId: string;
  slug?: string;
  wordId?: string;
  contextId?: string;
  linkType?: L3ContextLinkType;
  targetType?: L3ContextLinkTargetType;
  direction?: Direction | null;
  space?: L3SubSpace | null;
  limit: number;
  cursor?: string | null;
}

export interface L3WordSpaceLookup {
  userId: string;
  slug: string;
  wordbookId?: string | null;
  limit: number;
  cursor?: string | null;
}

export interface L3SourceSpaceLookup {
  userId: string;
  sourceId: string;
  limit: number;
  cursor?: string | null;
}

export interface L3GraphLookup {
  userId: string;
  wordbookId?: string | null;
  slug?: string | null;
  sourceId?: string | null;
  depth: number;
  limit: number;
  cursor?: string | null;
}

export interface L3SourceDeleteBlockers {
  contextCount: number;
  inboundContextLinkCount: number;
  importJobCount: number;
}

export interface L3ContextDeleteBlockers {
  occurrenceCount: number;
  contextLinkCount: number;
  inboundContextLinkCount: number;
}

export interface IL3ContextRepository {
  /**
   * 建来源；spaces 非空时同事务写入 l3_source_spaces junction（V0 接通死轴）。
   * 调用方负责枚举校验/去重/默认值（见 L3ContextService.normalizeSourceSpaces）。
   */
  createSource(input: NewL3Source, spaces?: readonly string[]): Promise<L3SourceRow>;
  /** 全量替换来源的能力域标签（事务内 delete+insert）；调用方须先做所有权校验。 */
  replaceSourceSpaces(userId: string, sourceId: string, spaces: readonly string[]): Promise<void>;
  /** 增量挂载能力域标签（只增不删，ON CONFLICT DO NOTHING）；录题自动打标用。 */
  ensureSourceSpaces(userId: string, sourceId: string, spaces: readonly string[]): Promise<void>;
  createContext(input: NewL3Context): Promise<L3ContextRow>;
  createOccurrence(input: NewL3Occurrence): Promise<L3OccurrenceRow>;
  createContextLink(input: NewL3ContextLink): Promise<L3ContextLinkRow>;
  deleteOccurrence(userId: string, occurrenceId: string): Promise<L3OccurrenceRow | null>;
  deleteContextLink(userId: string, contextLinkId: string): Promise<L3ContextLinkRow | null>;
  lockSourceByIdForUser(userId: string, sourceId: string): Promise<L3SourceRow | null>;
  lockContextByIdForUser(userId: string, contextId: string): Promise<L3ContextRow | null>;
  /** Cache/clear a translation on a context row (migration 0049). Owner-scoped. */
  setContextTranslation(
    userId: string,
    contextId: string,
    translation: string | null,
    source: string | null,
  ): Promise<L3ContextRow | null>;
  lockActiveL3TargetReference(userId: string, targetType: "source" | "context" | "word", targetId: string): Promise<void>;
  getSourceDeleteBlockers(userId: string, sourceId: string): Promise<L3SourceDeleteBlockers>;
  getContextDeleteBlockers(userId: string, contextId: string): Promise<L3ContextDeleteBlockers>;
  deleteSource(userId: string, sourceId: string): Promise<L3SourceRow | null>;
  deleteContext(userId: string, contextId: string): Promise<L3ContextRow | null>;
  createImportJob(input: NewL3ImportJob): Promise<L3ImportJobRow>;
  /** Find a completed import job by (userId, inputHash) for idempotent re-submission. */
  findImportJobByInputHash(userId: string, inputHash: string): Promise<L3ImportJobRow | null>;
  updateImportJobStatus(
    importJobId: string,
    userId: string,
    status: string,
    stats?: Json,
    error?: string | null,
  ): Promise<L3ImportJobRow>;
  findWordbookByIdForUser(userId: string, wordbookId: string): Promise<WordbookRow | null>;
  findSourceById(userId: string, sourceId: string): Promise<L3SourceRow | null>;
  /**
   * 批量取源（ADR-0037 待录核对面）：一次拿齐 ≤N 个 source_id，避免逐题 N+1 查询
   * ——待录列表要按锚点算原文切片，200 条待录题若逐条查会打 200 次库。
   * 只返回属于该 user 的行；入参空数组直接返回 []（不发查询）。
   */
  findSourcesByIds(userId: string, sourceIds: readonly string[]): Promise<L3SourceRow[]>;
  findSourceByContentHash(userId: string, contentHash: string): Promise<L3SourceRow | null>;
  listSources(input: {
    userId: string;
    sourceType?: string;
    q?: string;
    sort: "recent" | "captures";
    /** 两轴过滤（ADR-0029 §6②）：方向 × 子空间。 */
    direction?: Direction | null;
    space?: L3SubSpace | null;
    limit: number;
    offset: number;
  }): Promise<L3SourceListPage>;
  findContextById(userId: string, contextId: string): Promise<L3ContextRow | null>;
  /** 圈记幂等复用（2026-09-08）：按全文锚点定位既有语境——一句话多词共用一条语境。 */
  findContextByAnchor(
    userId: string,
    sourceId: string,
    anchorStart: number,
    anchorEnd: number,
  ): Promise<L3ContextRow | null>;
  /** 圈记幂等：同语境同词的既有 occurrence（重复圈记返回既有行，不重复写入）。 */
  listOccurrencesForContext(userId: string, contextId: string): Promise<L3OccurrenceRow[]>;
  findContextWithSourceById(
    userId: string,
    contextId: string,
  ): Promise<{ context: L3ContextRow; source: L3SourceRow } | null>;
  findWordById(wordId: string): Promise<WordRow | null>;
  findWordBySlug(slug: string): Promise<WordRow | null>;
  findWordInWordbookById(wordbookId: string, wordId: string): Promise<WordRow | null>;
  findWordInWordbookBySlug(wordbookId: string, slug: string): Promise<WordRow | null>;
  listContextsForWord(input: L3WordLookup): Promise<L3PaginatedList<L3WordContextListItem>>;
  listContextsForSource(input: L3SourceLookup): Promise<L3PaginatedList<L3SourceContextListItem>>;
  /** ADR-0029 §6①：证据列表（cursor 分页 + 词 / 语境 / 两轴过滤）。 */
  listOccurrences(input: L3OccurrenceLookup): Promise<L3PaginatedList<L3OccurrenceListItem>>;
  listContextLinks(input: L3ContextLinkLookup): Promise<L3PaginatedList<L3ContextLinkListItem>>;
  getContextDetail(userId: string, contextId: string): Promise<L3ContextDetail | null>;
  getWordSpace(input: L3WordSpaceLookup): Promise<L3WordSpace | null>;
  getSourceSpace(input: L3SourceSpaceLookup): Promise<L3SourceSpace | null>;
  getGraph(input: L3GraphLookup): Promise<L3GraphReadModel>;
  /** B1 素材宇宙：四类 L3 实体的全量计数（user-scoped，无任何过滤轴）。 */
  getSpaceSummaryCounts(userId: string): Promise<L3ReadStats>;
  /**
   * B1 素材宇宙：近 windowDays 天每日新增（显示时区 Asia/Shanghai 切日，
   * 升序、稀疏——仅含产生过新增的日期）。
   */
  getSpaceGrowth(userId: string, windowDays: number): Promise<L3SpaceSummaryDay[]>;
}

export interface NewL3Proposal {
  user_id: string;
  wordbook_id?: string | null;
  source_type: string;
  status?: string;
  title?: string | null;
  summary?: string | null;
  input_hash?: string | null;
  proposed_by?: string | null;
  provenance?: Json;
  review_note?: string | null;
}

export interface NewL3ProposalItem {
  proposal_id: string;
  user_id: string;
  item_type: string;
  ordinal: number;
  payload: Json;
  status?: string;
  validation_errors?: Json;
}

export interface L3ProposalLookup {
  userId: string;
  status?: string | null;
  limit: number;
  cursor?: string | null;
}

export interface IL3ProposalRepository {
  createProposal(input: NewL3Proposal): Promise<L3ProposalRow>;
  createProposalItem(input: NewL3ProposalItem): Promise<L3ProposalItemRow>;
  findProposalByIdForUser(userId: string, proposalId: string): Promise<L3ProposalRow | null>;
  /** Find a proposal by (userId, inputHash) for idempotent import dedup. */
  findProposalByInputHash(userId: string, inputHash: string): Promise<L3ProposalRow | null>;
  lockProposalByIdForUser(userId: string, proposalId: string): Promise<L3ProposalRow | null>;
  findProposalItems(userId: string, proposalId: string): Promise<L3ProposalItemRow[]>;
  getProposalBundle(userId: string, proposalId: string): Promise<L3ProposalBundle | null>;
  listProposals(input: L3ProposalLookup): Promise<L3PaginatedList<L3ProposalRow>>;
  updateProposalItemValidation(itemId: string, userId: string, validationErrors: Json): Promise<L3ProposalItemRow>;
  markProposalItemConfirmed(
    itemId: string,
    userId: string,
    activeEntityType: string,
    activeEntityId: string,
  ): Promise<L3ProposalItemRow>;
  markProposalItemsRejected(proposalId: string, userId: string): Promise<void>;
  markProposalConfirmed(proposalId: string, userId: string, reviewNote?: string | null): Promise<L3ProposalRow>;
  markProposalRejected(proposalId: string, userId: string, reviewNote?: string | null): Promise<L3ProposalRow>;
}

export interface NewL3RecommendationRun {
  user_id: string;
  wordbook_id?: string | null;
  mode: string;
  status?: string;
  input_hash?: string | null;
  stats?: Json;
}

export interface NewL3RecommendationItem {
  run_id: string;
  user_id: string;
  wordbook_id?: string | null;
  recommendation_type: string;
  status?: string;
  title: string;
  summary: string;
  priority_score: number;
  confidence: number;
  reason_codes: Json;
  evidence: Json;
  payload: Json;
  expires_at?: string | null;
}

export interface L3RecommendationLookup {
  userId: string;
  status?: string | null;
  recommendationType?: string | null;
  limit: number;
  cursor?: string | null;
}

export interface L3RecommendationSignalLookup {
  userId: string;
  wordbookId?: string | null;
  seedSlug?: string | null;
  horizonDays: number;
  limit: number;
}

export interface L3RecommendationSignal {
  word_id: string;
  slug: string;
  title: string;
  due_at: string | null;
  state: string | null;
  retrievability: number | string | null;
  l1_weak_signal: boolean | null;
  review_count: number | null;
  l2_retrievability: number | string | null;
  l2_due_at: string | null;
  l2_review_count: number | null;
  l2_paused: boolean | null;
  l2_fields: string[] | null;
  l3_context_count: number | string | null;
  l3_occurrence_count: number | string | null;
  l3_link_count: number | string | null;
  graph_neighbor_count: number | string | null;
}

export interface L3RecommendationLinkGapCandidate {
  context_id: string;
  source_id: string;
  word_id: string;
  word_slug: string;
  target_word_id: string;
  target_word_slug: string;
  cooccurrence_count: number | string;
}

export interface IL3RecommendationRepository {
  createRun(input: NewL3RecommendationRun): Promise<L3RecommendationRunRow>;
  createItem(input: NewL3RecommendationItem): Promise<L3RecommendationItemRow>;
  listItems(input: L3RecommendationLookup): Promise<L3PaginatedList<L3RecommendationItemRow>>;
  findItemByIdForUser(userId: string, itemId: string): Promise<L3RecommendationItemRow | null>;
  lockItemByIdForUser(userId: string, itemId: string): Promise<L3RecommendationItemRow | null>;
  markItemStatus(
    itemId: string,
    userId: string,
    status: string,
    acceptedProposalId?: string | null,
  ): Promise<L3RecommendationItemRow>;
  findSignals(input: L3RecommendationSignalLookup): Promise<L3RecommendationSignal[]>;
  findLinkGapCandidates(input: L3RecommendationSignalLookup): Promise<L3RecommendationLinkGapCandidate[]>;
}

// ── L3 Practice Attempts (ADR-0019 §1/§3) ──────────────────────────────
/** 插入一条练习记录（INSERT ... RETURNING *）。payload 必带 taskId 幂等身份。 */
export interface NewL3PracticeAttempt {
  user_id: string;
  context_id: string;
  occurrence_id: string | null;
  session_id: string | null;
  practice_type: L3PracticeType;
  outcome: L3PracticeOutcome;
  payload: Json;
}

/** 练习记录/错题库查询（offset 口径；space/direction 两轴过滤）。 */
export interface L3AttemptLookup {
  userId: string;
  practiceType?: L3PracticeType | null;
  outcome?: L3PracticeOutcome | null;
  /** 子空间过滤：走 l3_source_spaces junction（EXISTS）。 */
  space?: L3SubSpace | null;
  /** 方向过滤：走 l3_sources.direction。 */
  direction?: Direction | null;
  limit: number;
  offset: number;
  /**
   * 错题库 cursor 分页（T11 加固；null/缺省 = offset 模式）。与 offset 同时
   * 给出时以 cursor 为准（offset 被忽略）。练习记录列表不使用本字段。
   */
  cursor?: string | null;
}

export interface IL3PracticeRepository {
  insertAttempt(input: NewL3PracticeAttempt): Promise<L3PracticeAttemptRow>;
  /**
   * 幂等身份锁（taskId 维度）：pg_advisory_xact_lock(hashtext(userId), hashtext(taskId))。
   * MUST be in a transaction（先例 review.repository.checkIdempotency）。
   */
  lockAttemptIdentity(userId: string, taskId: string): Promise<void>;
  /** 幂等查找：payload->>'taskId' 命中即返回既有行。 */
  findAttemptByTaskId(userId: string, taskId: string): Promise<L3PracticeAttemptRow | null>;
  /** 练习记录列表（可选 practiceType/outcome/space/direction 过滤）。 */
  listAttempts(input: L3AttemptLookup): Promise<L3PracticeAttemptPage>;
  /**
   * 错题库 = attempts(outcome='wrong') 派生查询（不建第二真相源）；条目附语境级
   * 聚合（wrongCount/latestOutcome/latestAt），支持 cursor 分页（cursor 为准）。
   */
  listWrongAttempts(input: L3AttemptLookup): Promise<L3PracticeErrorBookPage>;
}

// ── 错题库统一投影（2026-09-26）────────────────────────────────────────

/** 统一错题查询入参。`kind` = null 时两腿合并。 */
export interface L3ErrorBookLookup {
  userId: string;
  /** 腿选择：null = 句级 + 题级合并（错题库默认口径）。 */
  kind: L3ErrorBookKind | null;
  /** 能力域：句级走 l3_source_spaces EXISTS；题级走 l3_questions.space。 */
  space?: L3SubSpace | null;
  /** 考试轴：两腿都取 l3_sources.direction。 */
  direction?: Direction | null;
  limit: number;
  offset: number;
}

/**
 * 错题库统一投影仓储（**只读**）。合并句级 wrong 与题级 wrong/partial 两条腿，
 * 合并后统一排序分页。不建表、不新增真源（见仓储文件头纪律）。
 */
export interface IL3ErrorBookRepository {
  listUnified(input: L3ErrorBookLookup): Promise<L3ErrorBookPage>;
}

// ── L3 Sessions (ADR-0019 §2) ──────────────────────────────────────────
/** 建会话输入：plan 只存实体 id 引用 + version。 */
export interface NewL3Session {
  user_id: string;
  type: L3SessionType;
  title: string | null;
  plan: Json;
  version: number;
}

/** 确定性抽样入参（space/direction 两轴；seed 决定顺序 → 同 seed 恒同结果）。 */
export interface L3SessionContextLookup {
  userId: string;
  space?: L3SubSpace | null;
  direction?: Direction | null;
  limit: number;
  seed: string;
}

export interface IL3SessionRepository {
  insertSession(input: NewL3Session): Promise<L3SessionRow>;
  findSessionByIdForUser(userId: string, sessionId: string): Promise<L3SessionRow | null>;
  /** ended=true → ended_at=now()；否则保留原值。 */
  updateStatus(
    userId: string,
    sessionId: string,
    status: L3SessionStatus,
    options: { ended: boolean },
  ): Promise<L3SessionRow | null>;
  /**
   * 确定性抽样 context id：ORDER BY md5(c.id::text || seed) LIMIT n。
   * 同 (userId, space, direction, limit, seed) 恒同结果（getSession re-render 稳定）。
   */
  sampleContextIds(input: L3SessionContextLookup): Promise<string[]>;
  /** 按 id 批量取语境投影（现拉现渲染；供 getSession 组描述）。 */
  findContextsByIds(userId: string, contextIds: string[]): Promise<L3SessionContextSummary[]>;
}

// ── 葫芦冲刺（ADR-0041，2026-10-06）────────────────────────────────────────
/**
 * 建计划入参。`suspend_snapshot` 仅在创建时挂起成功后非空（P2 才接线；
 * P0 期服务层拒绝 suspendReview=true，故恒为 null）。
 * `protocol_version` / `include_new_words` 由服务层显式给 'v2' / 用户选择
 * （迁移 0051；不吃 DB 默认值 —— 默认值 'legacy'/false 是给旧写入路径的兜底）。
 */
export interface NewHuluPlan {
  user_id: string;
  wordbook_id: string;
  direction: string | null;
  exam_date: string;
  target_rounds: number;
  page_size: number;
  gate_ratio: number;
  word_ids: string[];
  protocol_version: HuluProtocolVersion;
  include_new_words: boolean;
  suspend_review: boolean;
  suspend_snapshot: Record<string, string> | null;
}

/**
 * 开轮入参；`started_at` 为 null 时由 DB now() 兜底。
 * `kind` 由服务层显式给（'exposure' 曝光轮 / 'recall' 复习轮），不吃默认值。
 */
export interface NewHuluRound {
  plan_id: string;
  user_id: string;
  round_no: number;
  started_at: string | null;
  words_total: number;
  kind: HuluRoundKind;
}

/**
 * 葫芦冲刺持久化（只写 hulu_plans / hulu_rounds，零 FSRS）。
 * 多语句方法（insertPlan 的唯一索引兜底、setPlanStatus 的读改写、
 * lockPlanForUpdate）MUST be in a transaction。
 */
export interface IHuluRepository {
  /** 插入计划行；并发撞 idx_hulu_plans_one_active 抛 unique_violation（23505）。 */
  insertPlan(input: NewHuluPlan): Promise<HuluPlanRow>;
  findPlanById(userId: string, planId: string): Promise<HuluPlanRow | null>;
  /** 计划行加锁（FOR UPDATE）：串行化「至多一个未收尾轮」的判断。MUST be in a transaction。 */
  lockPlanForUpdate(userId: string, planId: string): Promise<HuluPlanRow | null>;
  findActivePlanByWordbook(userId: string, wordbookId: string): Promise<HuluPlanRow | null>;
  /** 置状态；ended=true 写 ended_at=now()；suspendSnapshot=null 清快照。MUST be in a transaction。 */
  setPlanStatus(
    userId: string,
    planId: string,
    status: HuluPlanStatus,
    options: { ended: boolean; suspendSnapshot?: Record<string, string> | null },
  ): Promise<HuluPlanRow | null>;
  /**
   * 写回挂起快照（创建事务的第二步）。快照来自
   * `ReviewRepository.bulkSuspendByWordIds` 的回返，本层只落库、不解释语义。
   * MUST be in a transaction。
   */
  saveSuspendSnapshot(
    userId: string,
    planId: string,
    snapshot: Record<string, string>,
  ): Promise<HuluPlanRow | null>;
  findRoundsByPlan(userId: string, planId: string): Promise<HuluRoundRow[]>;
  insertRound(input: NewHuluRound): Promise<HuluRoundRow>;
  /** 当前未收尾轮（ended_at IS NULL）；至多一行由服务层保证。 */
  findOpenRound(userId: string, planId: string): Promise<HuluRoundRow | null>;
  findRoundByNo(userId: string, planId: string, roundNo: number): Promise<HuluRoundRow | null>;
  /**
   * 页结算（R7）：单条条件 UPDATE，`pages_passed` 即页游标。
   * 命中（返回行）表示结算成功；null 表示游标不匹配（由服务层分流幂等/跳页）。
   * MUST be in a transaction。
   */
  settlePage(input: {
    userId: string;
    roundId: string;
    pageIndex: number;
    passed: number;
  }): Promise<HuluRoundRow | null>;
  /** 轮次收尾：条件 UPDATE（ended_at IS NULL）。null = 已收尾或不存在。MUST be in a transaction。 */
  finishRound(input: {
    userId: string;
    roundId: string;
    endedAt: string;
    elapsedSeconds: number;
    /** 结算词集指纹（R13）：服务层推导后写入；null = 不写（曝光轮以外恒有值）。 */
    wordSetFingerprint: string | null;
  }): Promise<HuluRoundRow | null>;
  /** 词书归属显式检查（照 insertNewCard 先例）：越权 → false。 */
  assertWordbookOwned(userId: string, wordbookId: string): Promise<boolean>;
  /**
   * 显示时区（Asia/Shanghai）的今天键 YYYY-MM-DD —— 风险校验 `left` 的基准。
   * 同步纯函数（零 IO）；置于仓库层是分层纪律（服务层不得依赖 db/timezone）。
   */
  findTodayKeyInDisplayTz(): string;
  /**
   * 定格取词（R9 / 修订轮 D-A「先学后刷」；R12 加可选「含未学词」）：
   * 该词书**复习牌堆**的词（`user_word_progress`），稳定序
   * `created_at ASC, word_id ASC`。两档都排除 `suspended`（用户主动放下的不捡回来）：
   *
   *   - `opts.includeNew` 缺省/false → `state ∈ ('learning','review','relearning')`
   *     （排除 `new`：没见过的词不逼回忆）；
   *   - `opts.includeNew` true → 四态含 `new`（先过曝光轮再冲刺）。
   *
   * 只读、零写入（唯一的 FSRS 可见面接触）；MUST be in a transaction
   * （owner-RLS 表须带 actor claim，否则静默返回空集）。
   */
  listReviewDeckWordIds(
    userId: string,
    wordbookId: string,
    opts?: { includeNew?: boolean },
  ): Promise<string[]>;
  /**
   * 页载荷取词（R10 / 修订轮 D-B）：按 id 批量取**卡面全字段**（Tier0 短释、
   * 义项、助记锚、例句、Tier2 语义链），一次带下 ⇒ 单卡路径零请求。
   *
   * 与 `reviews.findWordsByIds`（preview 队列在用，不动）分工：那个是队列最小集。
   * 只读 `words`（公开读策略），零副作用；返回序由 DB 决定，服务层按切片序重排。
   */
  findHuluPageWords(wordIds: string[]): Promise<HuluPageWordRow[]>;
}

// ── LLM Usage ──────────────────────────────────────────────────────────
/**
 * LLM token usage persistence — backs the UsageTracker budget enforcement.
 *
 * Lives at the repository boundary so src/llm never touches the DB directly
 * (Phase 2B architecture cleanup). `dayKey` is an ISO date string (YYYY-MM-DD);
 * when omitted, the repository sums usage for the current UTC day.
 */
export interface LlmReservationReaperMetrics {
  pendingCount: number;
  expiredPendingCount: number;
  oldestPendingAgeSeconds: number;
}

export interface ILlmUsageRepository {
  /** Total active budget (settled usage + non-expired reservations) for a UTC day. */
  getDailyUsage(dayKey?: string): Promise<number>;
  /** Atomically reserve tokens against the shared daily counter. */
  reserveDailyTokens(
    dayKey: string,
    tokens: number,
    dailyBudget: number,
    ttlSeconds?: number,
  ): Promise<string | null>;
  /** Extend the lease of a live reservation while its provider call is still active. */
  renewDailyTokens(reservationId: string, ttlSeconds: number): Promise<boolean>;
  /** Replace a pending or reaped reservation with actual usage; supports late provider settlement. */
  settleDailyTokens(
    reservationId: string,
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void>;
  /** Idempotently release a live reservation when the provider call fails. */
  releaseDailyTokens(reservationId: string): Promise<void>;
  /** Atomically mark up to `limit` expired pending reservations as expired. */
  expireReservations(limit: number): Promise<number>;
  /** Reservation backlog metrics for dashboards and alerts. */
  getReservationMetrics(): Promise<LlmReservationReaperMetrics>;
  /** Persist a single settled LLM call's token usage. */
  record(
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void>;
}

// ── Stats ───────────────────────────────────────────────────────────────
export interface DashboardL2Stats {
  /** 已晋升 L2 轨的词数（跨词书 EXISTS 口径）。 */
  promoted: number;
  /** L2 到期待练（未暂停且 l2_due_at <= now）。 */
  dueNow: number;
  /** L1 弱信号词数（l2 连败标记，词书 scope）。 */
  weakSignal: number;
  /** 今日 L2 作答数（L2-only：`track = 'l2'` AND `rating IS NOT NULL`；按书、今日）。 */
  reviewedToday: number;
}

export interface DashboardSummary {
  totalWords: number;
  trackedWords: number;
  /**
   * 「已掌握」= `state = 'review'` 的词数（词书 scope）。
   *
   * 刻意**不**让前端用 `totalWords - dueToday` 推：那等于把「今天没到期」当成「已掌握」，
   * 2026-10-07 实测前端显示 **6754**（6768 − 14）而真值是 **14**。学习态晋升到
   * `review` 才算掌握；分母用 `trackedWords`（已开始的词）才是有意义的进度。
   */
  masteredWords: number;
  dueToday: number;
  reviewedToday: number;
  reviewed7d: number;
  reviewed30d: number;
  streakDays: number;
  notesCount: number;
  /** Phase E：双轨可视化统计。 */
  l2: DashboardL2Stats;
}

export interface RatingDistribution {
  again: number;
  hard: number;
  good: number;
  easy: number;
}

/** 到期预测的一个时间桶（`getDueForecast` 的出参单元；M1，2026-10-07）。 */
export interface DueForecastBucket {
  /** 从「今天」（显示时区日历日）起算的天数。 */
  horizonDays: number;
  /** 截至「今天零点 + horizonDays」仍到期未复习的词数（口径见仓储实现注释）。 */
  count: number;
}

/** 按显示时区日历日分桶的一天计数（M2 日历用）。 */
export interface DailyCount {
  /** `YYYY-MM-DD`（Asia/Shanghai 日历日）。 */
  date: string;
  count: number;
}

/** 日历单日列词用的词条摘要（只读展示，不进复习流）。 */
export interface DayWordBrief {
  id: string;
  slug: string;
  title: string;
  lemma: string;
  shortDefinition: string | null;
}

/** 单日列词的两个视角：`due` = 该日到期 / `reviewed` = 该日复习过。 */
export type DayScope = "due" | "reviewed";

export interface IStatsRepository {
  getDashboardSummary(userId: string, wordbookId: string): Promise<DashboardSummary>;
  getRatingDistribution(userId: string, wordbookId: string, days?: number): Promise<RatingDistribution>;
  /**
   * 真实到期预测（M1，2026-10-07）：按 `due_at` 的**日历日累计**桶计数，
   * 取代仪表盘上此前的 `dueToday × 1.5 / × 2` 假推算（V10 类假指标）。
   * 单条往返：一次 `unnest` 出全部 horizon。判据见 `StatsRepository` 的实现注释。
   */
  getDueForecast(
    userId: string,
    wordbookId: string,
    horizons: readonly number[],
  ): Promise<DueForecastBucket[]>;
  /**
   * M2（2026-10-08）：日历**未来侧** —— `due_at` 按显示时区日历日分桶。
   * 积压（`due_at < 今天零点`）并入「今天」那一桶；排除 `state = 'suspended'`。
   * 同时带回 `todayDate`（显示时区的今天键）：调用方拿它去序列里定位「今天」，
   * **不必自己算时区**（HTTP 层被 arch 规则禁止直接 import `db/*`）。
   */
  getDailyDueCounts(
    userId: string,
    wordbookId: string,
    days: number,
  ): Promise<{ todayDate: string; buckets: DailyCount[] }>;
  /** M2：日历**单日列词**（只读）—— `scope = due` 该日到期 / `scope = reviewed` 该日复习过。 */
  getDayWords(
    userId: string,
    wordbookId: string,
    date: string,
    scope: DayScope,
    limit: number,
  ): Promise<{ total: number; items: DayWordBrief[] }>;
}

// ── ADR-0030：L3 题目 / 试卷（题与 context 分离；卷面存 payload 引用）──────
export interface NewL3Question {
  user_id: string;
  source_id: string | null;
  file_key: string | null;
  space: string;
  question_type: string;
  ordinal: number;
  stem: string;
  options?: Json;
  answer?: Json;
  explanation?: string | null;
  evidence?: Json;
  status?: string;
  created_by?: string;
  input_hash?: string | null;
}

export interface NewL3Paper {
  user_id: string;
  title: string;
  direction: string | null;
  metadata: Json;
  payload: Json;
  payload_version: number;
  status: string;
  created_by?: string;
  input_hash?: string | null;
}

export interface L3PracticeFileLookup {
  userId: string;
  questionType?: string | null;
  direction?: string | null;
  q?: string | null;
  /** R3：精确来源过滤（q.source_id / q.file_key 精确匹配；精确读面用）。 */
  sourceId?: string | null;
  fileKey?: string | null;
  limit: number;
  offset: number;
}

export interface L3PaperLookup {
  userId: string;
  status?: string | null;
  q?: string | null;
  limit: number;
  offset: number;
}

export interface L3PaperRef {
  id: string;
  title: string;
}

export interface IL3PaperRepository {
  insertQuestion(input: NewL3Question): Promise<L3QuestionRow>;
  findQuestionById(userId: string, questionId: string): Promise<L3QuestionRow | null>;
  /**
   * 改题面（2026-09-26）。条件 UPDATE 带**可改状态集合**谓词：0 行 → null，
   * 由 service 二次判别 404/409。**护栏在 service**：已有作答历史或被作文任务
   * 引用时不得改（见 l3-paper.service.updateQuestion）。
   *
   * ⚠️ ADR-0037：谓词不再写死 `status='active'`，而是 `editable_statuses`
   * （service 按角色给出：owner={active,pending}、agent={pending}）。闸门必须在
   * **UPDATE 谓词**里，不能是「先读状态再判断」的应用层检查（后者有 TOCTOU 窗口）。
   */
  updateQuestion(input: UpdateL3Question): Promise<L3QuestionRow | null>;
  /** 题面已有作答数（改题面护栏用；owner 作用域）。 */
  countQuestionAttempts(userId: string, questionId: string): Promise<number>;
  /**
   * 批量作答计数（`questionId → count`；无作答的题不在返回里 = 缺键即 0）。
   * 2026-09-27：改题入口的「能不能改」判定要按卷取，逐题 count 是 N+1。
   */
  countAttemptsForQuestions(userId: string, questionIds: readonly string[]): Promise<Map<string, number>>;
  /**
   * 题面已有评卷结果数（ADR-0038 决策 5/6）：改题面防历史脏行、删题防销毁判定。
   * owner 作用域。
   */
  countQuestionGradings(userId: string, questionId: string): Promise<number>;
  /**
   * 待录题（status='pending'）分页列表 —— owner 的核对面（ADR-0037 决策 6）。
   * 全库唯一显式取 pending 的读面；所有做题/错题读面仍只认 active。
   */
  listPendingQuestions(input: { user_id: string; limit: number; offset: number }): Promise<{ items: L3QuestionRow[]; total: number }>;
  /** 批量采纳 pending→active，返回真正被改到的 id（谓词含 pending ⇒ 重复调用幂等）。 */
  acceptPendingQuestions(userId: string, questionIds: readonly string[]): Promise<string[]>;
  /** 驳回单条 pending→rejected；false = 非 pending / 非属主 / 不存在。 */
  rejectPendingQuestion(userId: string, questionId: string): Promise<boolean>;
  /** 按 id 批量取 active 题（保持传入顺序由调用方处理）；只返回属于该 user 的行。 */
  findActiveQuestionsByIds(userId: string, questionIds: readonly string[]): Promise<L3QuestionRow[]>;
  /** 文件题组：(source_id, question_type) 或 (file_key, question_type)，按 ordinal/创建序。 */
  listActiveQuestionsForFile(
    userId: string,
    identity: { sourceId?: string | null; fileKey?: string | null; questionType: string },
  ): Promise<L3QuestionRow[]>;
  listPracticeFiles(input: L3PracticeFileLookup): Promise<L3PracticeFilePage>;
  /**
   * 删题护栏（作文子空间 V1，W2）：引用该 question 的全部当前 owner 写作任务
   * （id + 标题）。owner 作用域，不泄露他人信息。空数组 = 未被写作任务引用。
   */
  listWritingTaskRefs(userId: string, questionId: string): Promise<Array<{ id: string; title: string }>>;
  deleteQuestion(userId: string, questionId: string): Promise<boolean>;
  /** 拉全部 active 卷的轻量引用（单 owner 数据量小；引用匹配在 service 纯算）。 */
  listActivePaperRefsWithPayload(userId: string): Promise<Array<L3PaperRef & { payload: unknown }>>;
  insertPaper(input: NewL3Paper): Promise<L3PaperRow>;
  findPaperById(userId: string, paperId: string): Promise<L3PaperRow | null>;

  /**
   * 按 source_ids 反查这些题目所属试卷的 `metadata.answerTrust.status`。
   *
   * 为什么需要：`file` 作用域的题纸只有 source_id，拿不到 paper_id（见
   * `resolveSheetScopedQuestions`），而 2025 那份恰好只标在 paper 的 metadata 上。
   * 没有这个方法，判卷守卫就只对 `paper` 作用域的题纸生效 —— 而 2025 若做成题纸，
   * 最可能走的是 6 篇文章各自成 file。
   *
   * 一次查询，不产生 N+1。返回 Map<source_id, status>：
   *   - 缺键 = 该 source 没有任何带 answerTrust 的试卷 = 视为可信（正常题目）
   *   - 值为 undefined = 标注了 answerTrust 但没写 status = 判卷侧 fail-closed
   */
  findAnswerTrustBySourceIds(
    userId: string,
    sourceIds: readonly string[],
  ): Promise<Map<string, unknown>>;
  /** 改卷（2026-09-26）：标题/方向/元信息/payload；条件 UPDATE 带 `status='active'`。 */
  updatePaper(input: UpdateL3Paper): Promise<L3PaperRow | null>;
  listPapers(input: L3PaperLookup): Promise<L3PaperListPage>;

}

/** 改题面入参（每个字段都是最终值；null = 清空）。 */
export interface UpdateL3Question {
  question_id: string;
  user_id: string;
  stem: string;
  options: unknown;
  answer: unknown;
  explanation: string | null;
  evidence: unknown;
  ordinal: number;
  input_hash: string | null;
  /** ADR-0037：本次写入允许触碰的状态集合（UPDATE 谓词，非应用层判断）。 */
  editable_statuses: readonly string[];
}

/** 改卷入参（payload 已在 service 过 validatePaperPayloadShape + 归属校验）。 */
export interface UpdateL3Paper {
  paper_id: string;
  user_id: string;
  title: string;
  direction: string | null;
  metadata: unknown;
  payload: { version: number; sections: unknown[] };
  input_hash: string | null;
}

// ── 批次一（0033）：做题注记（原文分析条目）与规律标签字典 ─────────────────
export interface NewL3QuestionAnnotation {
  user_id: string;
  question_id: string;
  /** 缺省由库内题内 max(ordinal)+1 分配。 */
  ordinal?: number | null;
  anchor_start: number | null;
  anchor_end: number | null;
  excerpt: string | null;
  note: string;
  entry_tags: string[];
  option_tags: Partial<Record<L3AnnotationOptionKey, string[]>>;
  /** 批次二：挂题纸的草稿注记（缺省 = 正式注记 confirmed）。 */
  stage?: "draft" | "confirmed";
  sheet_id?: string | null;
}

/** PATCH 的库列形状（snake_case；只含可改列，question_id 永不可改）。 */
export interface L3QuestionAnnotationPatchDb {
  anchor_start?: number | null;
  anchor_end?: number | null;
  excerpt?: string | null;
  note?: string;
  entry_tags?: string[];
  option_tags?: Partial<Record<L3AnnotationOptionKey, string[]>>;
}

/** 批次二：「只留总结」档的无锚点总结条（stage='submitted'，挂作用域代表题）。 */
export interface NewL3SummaryAnnotation {
  user_id: string;
  question_id: string;
  sheet_id: string;
  note: string;
}

export interface IL3AnnotationRepository {
  /** 批量取多题的 active 条目（题内按 ordinal/created_at 排序）。 */
  listForQuestions(userId: string, questionIds: readonly string[]): Promise<L3QuestionAnnotationRow[]>;
  /** 锚点幂等查询：同题同锚点 active 行。 */
  findByAnchor(
    userId: string,
    questionId: string,
    anchorStart: number,
    anchorEnd: number,
  ): Promise<L3QuestionAnnotationRow | null>;
  insertAnnotation(input: NewL3QuestionAnnotation): Promise<L3QuestionAnnotationRow>;
  /** 动态 SET 仅改提交列（显式 null 落库，用于去除锚点）；未命中返回 null。 */
  updateAnnotation(
    userId: string,
    id: string,
    patch: L3QuestionAnnotationPatchDb,
  ): Promise<L3QuestionAnnotationRow | null>;
  /** 软删（status→deleted），非 active/非属主零行。 */
  softDeleteAnnotation(userId: string, id: string): Promise<boolean>;
  /** 整取 active 标签行（调用方按 kind 分组）。 */
  listTags(userId: string): Promise<L3AnnotationTagRow[]>;
  /** 整存：事务内软删全部旧行再插新行，返回新行。 */
  replaceTags(
    userId: string,
    dict: { entry: readonly string[]; option: readonly string[] },
  ): Promise<L3AnnotationTagRow[]>;
  /** 批次二：题纸草稿注记（定格升格候选；stage='draft' AND sheet）。 */
  listDraftBySheet(userId: string, sheetId: string): Promise<L3QuestionAnnotationRow[]>;
  /** 批次二：题纸全部注记（含定格升格后的 submitted/confirmed；导出冻结档案用）。 */
  listAnnotationsBySheet(userId: string, sheetId: string): Promise<L3QuestionAnnotationRow[]>;
  /** v2 §4.7：单条 active 注记（stage 守卫判定与撤回前置读取；不存在/非属主 null）。 */
  getAnnotation(userId: string, id: string): Promise<L3QuestionAnnotationRow | null>;
  /** v2 §4.7：撤回（submitted→draft + 重挂题纸），条件 UPDATE 空转返回 null。 */
  withdrawAnnotation(userId: string, id: string, sheetId: string): Promise<L3QuestionAnnotationRow | null>;
  /** 批次二：定格升格（draft→submitted）批量条件 UPDATE，返回升格行。 */
  promoteBySheet(userId: string, sheetId: string): Promise<L3QuestionAnnotationRow[]>;
  /** 批次二：「只留总结」档总结条（无锚点，stage='submitted'）。 */
  insertSummaryAnnotation(input: NewL3SummaryAnnotation): Promise<L3QuestionAnnotationRow>;
  /**
   * 批次三①（ADR-0035 §3.2）：评卷 review 白名单专用写入——只触 review /
   * review_sheet_id 列 + stage 流转（+ updated_at 审计列），note/锚点/标签等
   * 原始事实列永不触碰；不复用公开 PATCH（「agent 永不写注记内容」的代码级保证）。
   * review_sheet_id = 来源题纸（F-1：随覆写刷新，前端据此标注本轮/历史评卷）。
   * 条件：active 且非 draft（draft 未提交不授权）；空转返回 null。
   */
  applyAnnotationReview(
    userId: string,
    id: string,
    review: unknown,
    stage: string,
    reviewSheetId: string,
  ): Promise<L3QuestionAnnotationRow | null>;
  /** 批次三①（D18）：owner 处置——submitted→confirmed 条件流转；非 submitted 空转 null。 */
  confirmAnnotation(userId: string, id: string): Promise<L3QuestionAnnotationRow | null>;
}

// ── 批次二增补（0035）：评析区（ADR-0034 v2 条 10/11）──────────────────────
export interface NewL3QuestionAssessment {
  user_id: string;
  question_id: string;
  content_md: string;
  last_editor: "owner" | "agent";
}

export interface IL3AssessmentRepository {
  /** 一题一条（无则 null——GET 空态数据源）。 */
  findByQuestion(userId: string, questionId: string): Promise<L3QuestionAssessmentRow | null>;
  /** 批量取多题评析（导出评析段数据源；空数组输入 → 空结果）。 */
  listByQuestions(userId: string, questionIds: readonly string[]): Promise<L3QuestionAssessmentRow[]>;
  /** upsert（ON CONFLICT (user_id, question_id) DO UPDATE，latest-wins）；last_editor 按 actor。 */
  upsert(input: NewL3QuestionAssessment): Promise<L3QuestionAssessmentRow>;
}

// ── 批次二（0034）：题纸与作答历史（ADR-0034 §1/§2/§5）─────────────────────
export interface NewL3Submission {
  user_id: string;
  scope: SheetScope;
  scope_key: string;
  source_id: string | null;
  question_type: string | null;
  paper_id: string | null;
  /**
   * 题单快照（开纸定格，2026-09-26）。有序 uuid[]；`null` = 不写快照，
   * 读侧按作用域现拉（历史行回退路径）。幂等重开不覆盖既有快照。
   */
  question_ids: string[] | null;
}

/** 定格状态推进（service 事务内调用）：status 由 sheetStatusAfterSeal(mode) 决定。 */
export interface L3SheetSealUpdate {
  status: "sealed" | "discarded";
  seal_mode: SealMode;
  summary: string | null;
}

export interface NewL3QuestionAttempt {
  question_id: string;
  sheet_id: string | null;
  venue: SheetScope;
  answer: unknown;
  self_assessment: unknown | null;
}

export interface L3SheetOpenResult {
  row: L3SubmissionRow;
  created: boolean;
}

export interface IL3SheetRepository {
  /** 幂等开纸查询：该作用域的在写（draft）题纸。 */
  findDraftByScopeKey(userId: string, scopeKey: string): Promise<L3SubmissionRow | null>;
  /** 开纸：部分唯一索引 ON CONFLICT 冲突复用既有行（created=false）。 */
  openSheet(input: NewL3Submission): Promise<L3SheetOpenResult>;
  /** 条件 UPDATE（WHERE status='draft'）：非 draft/不存在返回 null（service 分派 404/409）。
   *  每次 merge 推进 draft_version（定格 CAS 护栏）。
   *  V（2026-09-19）：expectedDraftVersion 为客户端确认版本的 CAS 条件——旧版本
   *  的合并落空返回 null，由 service 区分 404/409（不泄露服务器当前版本）。 */
  patchAnswers(
    userId: string,
    sheetId: string,
    answers: Record<string, unknown>,
    expectedDraftVersion: number,
  ): Promise<L3SubmissionRow | null>;
  /** 定格（requireTx）：状态流转 + 定格元数据 + answers 清空（attempts 为唯一作答真源）。
   *  expectedDraftVersion 为 CAS 护栏——仅当当前 draft_version 匹配才抢占成功。 */
  sealSheet(userId: string, sheetId: string, seal: L3SheetSealUpdate, expectedDraftVersion: number): Promise<L3SubmissionRow | null>;
  /** 题纸详情读（非锁，仅供定格读取基线 / 结果页派生）。 */
  getSheet(userId: string, sheetId: string): Promise<L3SubmissionRow | null>;
  /** 批量物化（seal 事务内）：一批 attempts 单语句插入。 */
  insertAttempts(userId: string, attempts: readonly NewL3QuestionAttempt[]): Promise<L3QuestionAttemptRow[]>;
  /** 题历史链（过滤 deleted；批量列名恒为 question_id —— 6665a77 列名 bug 教训）。 */
  listForQuestions(userId: string, questionIds: readonly string[]): Promise<L3QuestionAttemptRow[]>;
  /** 软删：非 active/非属主返回 false（再删 → 404）。 */
  softDeleteAttempt(userId: string, attemptId: string): Promise<boolean>;
  /** 结果页派生源：含 deleted（结果页占位分流；题历史分流在 listForQuestions）。 */
  listBySheet(userId: string, sheetId: string): Promise<L3QuestionAttemptRow[]>;
  /** 该题纸 answers 已答键数（未答 = 作用域题数 - 本值）。 */
  countAnsweredBySheet(userId: string, sheetId: string): Promise<number>;
  /** F-1：题纸档案列表（回看闭环入口；draft/sealed 新→旧，含已评计数与展示标题；仅 file/paper 域）。 */
  listArchive(userId: string, limit: number): Promise<L3SheetArchiveRow[]>;
  /**
   * 补写题单快照（ADR-0038 决策 7）：legacy `question_ids IS NULL` 行在定格时
   * 把当时的作用域题集写回。谓词含 `IS NULL` ⇒ 幂等且并发安全。
   */
  freezeQuestionIds(userId: string, sheetId: string, questionIds: readonly string[]): Promise<boolean>;
  /**
   * 就地校正 draft 题纸的**题序**（2026-10-02，P0 保序存量自愈）：
   * 修前冻结进快照的是 SQL 的物理返回序，已开的 draft 纸不会自愈（开纸幂等不覆盖快照）。
   *
   * 谓词是**集合相等**（`@>` 且 `<@`）+ `status='draft'`：任何加题/减题/定格/
   * 并发变更都让 UPDATE 命中 0 行 ⇒ 幂等且 fail-closed —— 本方法只能换顺序，
   * 不能换题集。返回 null 表示无需/不允许校正。
   */
  realignQuestionIdsOrder(
    userId: string,
    sheetId: string,
    questionIds: readonly string[],
  ): Promise<L3SubmissionRow | null>;
  /**
   * 待评卷清单（ADR-0038 决策 2）：agent 可读发现面，**只给计数与身份，不给题面**。
   * `gradable_count` = 已物化 active attempt 的题数（可评数，决策 4/8）；未作答的题
   * 不参与评卷，故不计入分母。
   */
  listPendingGradingSheets(userId: string, limit: number): Promise<Array<{
    id: string;
    scope: string;
    sealed_at: string;
    graded_count: number;
    gradable_count: number;
    question_count: number;
    venue_title: string | null;
  }>>;
  /** W3：写作任务 → question_id 只读查询（作用域解析器 writing 分支用；不触发创建）。 */
  findWritingTaskQuestionId(userId: string, taskId: string): Promise<string | null>;
}

// ── 批次三①（0036）：评卷结果（ADR-0035 §1/§3）───────────────────────────
/** 评卷结果 upsert 输入（graded_by 由 service 从服务端认定的 actor 注入，非调用方自述）。 */
export interface NewL3GradingResult {
  user_id: string;
  sheet_id: string;
  question_id: string;
  verdict: GradingVerdict;
  analysis_md: string | null;
  graded_by: string;
}

export interface IL3GradingRepository {
  /** 题纸全部评卷结果（解析模式读面数据源；无行 → 空数组）。 */
  listBySheet(userId: string, sheetId: string): Promise<L3GradingResultRow[]>;
  /**
   * 同键覆写 upsert（requireTx 由 service 保证事务内调用）：
   * UNIQUE(sheet_id, question_id) ON CONFLICT DO UPDATE + graded_at 刷新（latest-wins）。
   */
  upsertResults(inputs: readonly NewL3GradingResult[]): Promise<L3GradingResultRow[]>;
}

// ── Aggregate ───────────────────────────────────────────────────────────
export interface IRepositories {
  words: IWordRepository;
  reviews: IReviewRepository;
  noteEntries: INoteEntryRepository;
  wordbooks: IWordbookRepository;
  highlights: IHighlightRepository;
  annotations: IAnnotationRepository;
  sessions: ISessionRepository;
  stats: IStatsRepository;
  l2Progress: IL2ProgressRepository;
  l2Content: IL2ContentRepository;
  upgradeWorkOrders: IUpgradeWorkOrderRepository;
  l3Context: IL3ContextRepository;
  l3Proposal: IL3ProposalRepository;
  l3Recommendation: IL3RecommendationRepository;
  l3Practice: IL3PracticeRepository;
  /** 错题库统一投影（只读；合并句级 + 题级两腿，见仓储文件头纪律）。 */
  l3ErrorBook: IL3ErrorBookRepository;
  l3Sessions: IL3SessionRepository;
  // 葫芦冲刺（ADR-0041 注册）：计划容器（hulu_plans / hulu_rounds），零 FSRS。
  hulu: IHuluRepository;
  l3Paper: IL3PaperRepository;
  l3Annotations: IL3AnnotationRepository;
  l3Sheets: IL3SheetRepository;
  l3Assessments: IL3AssessmentRepository;
  l3Grading: IL3GradingRepository;
  // 作文子空间 v1（W6 注册）：写作任务/稿次 + 作文反馈（自包含接口定义于各自 repo 文件）。
  l3Writing: IL3WritingRepository;
  l3Feedback: IL3WritingFeedbackRepository;
  // 学习笔记（N1 注册）：笔记 / 平面专题 / 引用快照（自包含接口定义于各自 repo 文件）。
  studyNotes: IL3StudyNoteRepository;
  studyTopics: IL3StudyTopicRepository;
  studyReferences: IL3StudyReferenceRepository;
  llmUsage: ILlmUsageRepository;
  outbox: IOutboxRepository;
}
