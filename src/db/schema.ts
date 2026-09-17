import { pgTable, foreignKey, unique, pgPolicy, check, uuid, text, jsonb, timestamp, index, boolean, numeric, integer, uniqueIndex, primaryKey, date, pgEnum, customType } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

// L3 坐标空间约定（2026-09-07 计划）：content_text 导入后只读（修订=新版本）；
// 偏移一律 UTF-16 码元、producer/consumer 均为 JS 单运行时（计划文档「坐标空间约定」）。

// Drizzle doesn't natively support tsvector; define a custom type so the
// generated column can be typed correctly instead of falling back to `unknown`.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * Authoritative full-text search expression for the words table.
 * Single source of truth for the generated `search_vector` column — both the
 * Drizzle column and the schema-drift gate (scripts/verify-schema-drift.ts)
 * derive from this expression, so editing it here updates the contract.
 */
export const SEARCH_VECTOR_EXPRESSION = sql`to_tsvector('english'::regconfig, ((((((((((COALESCE(lemma, ''::text) || ' '::text) || COALESCE(title, ''::text)) || ' '::text) || COALESCE(short_definition, ''::text)) || ' '::text) || COALESCE(definition_md, ''::text)) || ' '::text) || COALESCE((metadata ->> 'semantic_field'::text), ''::text)) || ' '::text) || COALESCE((metadata ->> 'word_freq'::text), ''::text))))`;

export const reviewRating = pgEnum("review_rating", ['again', 'hard', 'good', 'easy'])

// auth.users — local auth shim (schema: auth). Drizzle pull only introspects
// the public schema, so we define a minimal placeholder for FK references.
export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: text(),
	emailConfirmedAt: timestamp("email_confirmed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("users_email_key").on(table.email),
]);


export const profiles = pgTable("profiles", {
	id: uuid().primaryKey().notNull(),
	email: text(),
	displayName: text("display_name"),
	avatarUrl: text("avatar_url"),
	role: text().default('user').notNull(),
	settings: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.id],
			foreignColumns: [users.id],
			name: "profiles_id_fkey"
		}).onDelete("cascade"),
	unique("profiles_email_key").on(table.email),
	pgPolicy("profiles_update_own", { as: "permissive", for: "update", to: ["public"], using: sql`(auth.uid() = id)`, withCheck: sql`(auth.uid() = id)`  }),
	pgPolicy("profiles_select_own", { as: "permissive", for: "select", to: ["public"], using: sql`(auth.uid() = id)` }),
	check("profiles_role_check", sql`role = ANY (ARRAY['user'::text, 'editor'::text, 'admin'::text])`),
]);

export const authSessions = pgTable("auth_sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	role: text().notNull(),
	tokenHash: text("token_hash").notNull(),
	csrfHash: text("csrf_hash").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("auth_sessions_token_hash_key").on(table.tokenHash),
	index("idx_auth_sessions_active").using("btree", table.tokenHash, table.expiresAt).where(sql`revoked_at IS NULL`),
	index("idx_auth_sessions_user").using("btree", table.userId, table.expiresAt.desc()),
	index("idx_auth_sessions_expiry_cleanup").using("btree", table.expiresAt, table.id),
	index("idx_auth_sessions_revoked_cleanup").using("btree", table.revokedAt, table.id).where(sql`revoked_at IS NOT NULL`),
	foreignKey({
		columns: [table.userId],
		foreignColumns: [profiles.id],
		name: "auth_sessions_user_id_fkey"
	}).onDelete("cascade"),
	check("auth_sessions_role_check", sql`role = ANY (ARRAY['owner'::text, 'agent'::text])`),
]);

export const loginRateLimits = pgTable("login_rate_limits", {
	keyHash: text("key_hash").primaryKey().notNull(),
	windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: 'string' }).notNull(),
	windowExpiresAt: timestamp("window_expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	attempts: integer().notNull(),
}, (table) => [
	index("idx_login_rate_limits_expiry").on(table.windowExpiresAt),
	check("login_rate_limits_key_hash_check", sql`key_hash ~ '^[0-9a-f]{64}$'::text`),
	check("login_rate_limits_attempts_check", sql`attempts > 0`),
	check("login_rate_limits_window_check", sql`window_expires_at > window_started_at`),
]);

export const outboxEvents = pgTable("outbox_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	aggregateType: text("aggregate_type").notNull(),
	aggregateId: uuid("aggregate_id").notNull(),
	eventType: text("event_type").notNull(),
	payload: jsonb().notNull(),
	dedupeKey: text("dedupe_key").notNull(),
	status: text().default('pending').notNull(),
	attempts: integer().default(0).notNull(),
	maxAttempts: integer("max_attempts").default(8).notNull(),
	availableAt: timestamp("available_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lockedAt: timestamp("locked_at", { withTimezone: true, mode: 'string' }),
	lockedUntil: timestamp("locked_until", { withTimezone: true, mode: 'string' }),
	lockedBy: text("locked_by"),
	lastError: text("last_error"),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("outbox_events_dedupe_key_key").on(table.dedupeKey),
	index("idx_outbox_events_claim").using("btree", table.availableAt, table.createdAt).where(sql`status IN ('pending', 'retry')`),
	index("idx_outbox_events_lease").using("btree", table.lockedUntil).where(sql`status = 'processing'`),
	index("idx_outbox_events_dead_letter").using("btree", table.updatedAt).where(sql`status = 'dead_letter'`),
	index("idx_outbox_events_processed_cleanup").using("btree", table.processedAt, table.id).where(sql`status = 'processed' AND processed_at IS NOT NULL`),
	check("outbox_events_status_check", sql`status = ANY (ARRAY['pending'::text, 'retry'::text, 'processing'::text, 'processed'::text, 'dead_letter'::text])`),
	check("outbox_events_attempts_check", sql`attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts`),
]);

export const outboxEffectReceipts = pgTable("outbox_effect_receipts", {
	eventId: uuid("event_id").notNull(),
	effectName: text("effect_name").notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.eventId, table.effectName], name: "outbox_effect_receipts_pkey" }),
	foreignKey({
		columns: [table.eventId],
		foreignColumns: [outboxEvents.id],
		name: "outbox_effect_receipts_event_id_fkey"
	}).onDelete("cascade"),
]);

export const tags = pgTable("tags", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: text().notNull(),
	label: text().notNull(),
	description: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("tags_slug_key").on(table.slug),
	unique("tags_label_key").on(table.label),
	pgPolicy("tags_public_read", { as: "permissive", for: "select", to: ["public"], using: sql`true` }),
]);

export const words = pgTable("words", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: text().notNull(),
	contentHash: text("content_hash").notNull(),
	l1ContentHash: text("l1_content_hash"),
	l2ContentHash: text("l2_content_hash"),
	sourcePath: text("source_path").notNull(),
	title: text().notNull(),
	lemma: text().notNull(),
	langCode: text("lang_code").default('en').notNull(),
	pos: text(),
	cefr: text(),
	ipa: text(),
	aliases: text().array().default([""]).notNull(),
	shortDefinition: text("short_definition"),
	definitionMd: text("definition_md").notNull(),
	bodyMd: text("body_md").notNull(),
	examples: jsonb().default([]).notNull(),
	metadata: jsonb().default({}).notNull(),
	sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true, mode: 'string' }),
	syncedAt: timestamp("synced_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	isPublished: boolean("is_published").default(true).notNull(),
	isDeleted: boolean("is_deleted").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	coreDefinitions: jsonb("core_definitions").default([]).notNull(),
	prototypeText: text("prototype_text"),
	collocations: jsonb().default([]).notNull(),
	corpusItems: jsonb("corpus_items").default([]).notNull(),
	synonymItems: jsonb("synonym_items").default([]).notNull(),
	antonymItems: jsonb("antonym_items").default([]).notNull(),
	bodyHtml: text("body_html"),
	definitionHtml: text("definition_html"),
	synonymHtml: text("synonym_html"),
	antonymHtml: text("antonym_html"),
	qualityStatus: text("quality_status").default('ok').notNull(),
	qualityIssues: jsonb("quality_issues").default([]).notNull(),
	// Full-text search vector — authoritative expression in SEARCH_VECTOR_EXPRESSION.
	searchVector: tsvector("search_vector").generatedAlwaysAs(SEARCH_VECTOR_EXPRESSION),
	// 中文释义拼音检索列（P2）：导入时由 short_definition / definition_md 的汉字生成。
	// 全拼（无空格小写）与首字母（小写）各一列，配 trigram GIN 索引支持拼音子串检索。
	pinyin: text("pinyin"),
	pinyinInitial: text("pinyin_initial"),
}, (table) => [
	index("idx_words_aliases_gin").using("gin", table.aliases.asc().nullsLast().op("array_ops")),
	index("idx_words_lemma_trgm").using("gin", table.lemma.asc().nullsLast().op("gin_trgm_ops")),
	// P1-4：中文释义子串检索（P1）的 ILIKE '%…%' 走全表扫描，补 gin_trgm 索引加速。
	index("idx_words_short_definition_trgm").using("gin", table.shortDefinition.asc().nullsLast().op("gin_trgm_ops")),
	index("idx_words_definition_md_trgm").using("gin", table.definitionMd.asc().nullsLast().op("gin_trgm_ops")),
	index("idx_words_metadata_gin").using("gin", table.metadata.asc().nullsLast().op("jsonb_ops")),
	index("idx_words_pinyin_trgm").using("gin", table.pinyin.asc().nullsLast().op("gin_trgm_ops")),
	index("idx_words_pinyin_initial_trgm").using("gin", table.pinyinInitial.asc().nullsLast().op("gin_trgm_ops")),
	index("idx_words_public_lemma_sort").using("btree", table.lemma.asc().nullsLast()).where(sql`((is_published = true) AND (is_deleted = false))`),
	index("idx_words_public_metadata_filter").using("gin", table.metadata.asc().nullsLast().op("jsonb_path_ops")).where(sql`((is_published = true) AND (is_deleted = false))`),
	index("idx_words_published").using("btree", table.isPublished.asc().nullsLast(), table.isDeleted.asc().nullsLast()),
	index("idx_words_quality_status").using("btree", table.qualityStatus.asc().nullsLast()).where(sql`(quality_status <> 'ok'::text)`),
	index("idx_words_search").using("gin", table.searchVector.asc().nullsLast().op("tsvector_ops")),
	index("idx_words_source_path").using("btree", table.sourcePath.asc().nullsLast()),
	index("idx_words_title_trgm").using("gin", table.title.asc().nullsLast().op("gin_trgm_ops")),
	unique("words_slug_key").on(table.slug),
	unique("words_content_hash_key").on(table.contentHash),
	pgPolicy("words_public_read", { as: "permissive", for: "select", to: ["public"], using: sql`((is_published = true) AND (is_deleted = false))` }),
	check("words_content_hash_check", sql`content_hash ~ '^[0-9a-f]{64}$'::text`),
	check("words_quality_status_check", sql`quality_status = ANY (ARRAY['ok'::text, 'needs_supplement'::text, 'rejected'::text])`),
]);

export const userWordProgress = pgTable("user_word_progress", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	wordId: uuid("word_id").notNull(),
	scheduleAlgo: text("schedule_algo").default('fsrs').notNull(),
	state: text().default('new').notNull(),
	desiredRetention: numeric("desired_retention", { precision: 4, scale:  3 }).default('0.900').notNull(),
	stability: numeric({ precision: 10, scale:  4 }),
	difficulty: numeric({ precision: 10, scale:  4 }),
	retrievability: numeric({ precision: 8, scale:  6 }),
	intervalDays: integer("interval_days"),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }),
	lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true, mode: 'string' }),
	lastRating: reviewRating("last_rating"),
	reviewCount: integer("review_count").default(0).notNull(),
	lapseCount: integer("lapse_count").default(0).notNull(),
	againCount: integer("again_count").default(0).notNull(),
	hardCount: integer("hard_count").default(0).notNull(),
	goodCount: integer("good_count").default(0).notNull(),
	easyCount: integer("easy_count").default(0).notNull(),
	contentHashSnapshot: text("content_hash_snapshot"),
	l1ContentHashSnapshot: text("l1_content_hash_snapshot"),
	recentRatings: jsonb("recent_ratings").default([]).notNull(),
	l1WeakSignal: boolean("l1_weak_signal").default(false).notNull(),
	schedulerPayload: jsonb("scheduler_payload").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	skipCount: integer("skip_count").default(0).notNull(),
	wordbookId: uuid("wordbook_id").notNull(),
	needsRecheck: boolean("needs_recheck").default(false).notNull(),
}, (table) => [
	index("idx_progress_due").using("btree", table.userId.asc().nullsLast(), table.dueAt.asc().nullsLast()),
	index("idx_progress_recheck").using("btree", table.userId.asc().nullsLast(), table.wordbookId.asc().nullsLast()).where(sql`(needs_recheck = true)`),
	index("idx_progress_word").using("btree", table.wordId.asc().nullsLast()),
	index("idx_user_word_progress_due").using("btree", table.userId.asc().nullsLast(), table.wordbookId.asc().nullsLast(), table.state.asc().nullsLast(), table.dueAt.asc().nullsLast()),
	index("idx_uwp_has_hash_snapshot").using("btree", table.wordId.asc().nullsLast()).where(sql`(content_hash_snapshot IS NOT NULL)`),
	index("idx_uwp_wordbook_due").using("btree", table.wordbookId.asc().nullsLast(), table.dueAt.asc().nullsLast()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "user_word_progress_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordId],
			foreignColumns: [words.id],
			name: "user_word_progress_word_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordbookId],
			foreignColumns: [wordbooks.id],
			name: "fk_uwp_wordbook"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordbookId, table.userId],
			foreignColumns: [wordbooks.id, wordbooks.userId],
			name: "user_word_progress_wordbook_owner_fkey"
		}).onDelete("cascade"),
	unique("user_word_progress_id_user_wordbook_unique").on(table.id, table.userId, table.wordbookId),
	unique("user_word_progress_user_wordbook_word_key").on(table.userId, table.wordId, table.wordbookId),
	pgPolicy("progress_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)`  }),
	check("user_word_progress_schedule_algo_check", sql`schedule_algo = ANY (ARRAY['leitner'::text, 'sm2'::text, 'fsrs'::text])`),
	check("user_word_progress_state_check", sql`state = ANY (ARRAY['new'::text, 'learning'::text, 'review'::text, 'relearning'::text, 'suspended'::text])`),
	check("user_word_progress_desired_retention_check", sql`(desired_retention >= 0.700) AND (desired_retention <= 0.990)`),
]);

export const notes = pgTable("notes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	wordId: uuid("word_id").notNull(),
	contentMd: text("content_md").default('').notNull(),
	version: integer().default(1).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	wordbookId: uuid("wordbook_id").notNull(),
}, (table) => [
	index("idx_notes_wordbook").using("btree", table.wordbookId.asc().nullsLast(), table.updatedAt.desc().nullsFirst()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "notes_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordId],
			foreignColumns: [words.id],
			name: "notes_word_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordbookId],
			foreignColumns: [wordbooks.id],
			name: "fk_notes_wordbook"
		}).onDelete("cascade"),
	unique("notes_user_wordbook_word_key").on(table.userId, table.wordId, table.wordbookId),
	pgPolicy("notes_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)`  }),
]);

export const sessions = pgTable("sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	mode: text().default('review').notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	cardsSeen: integer("cards_seen").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	wordbookId: uuid("wordbook_id").notNull(),
}, (table) => [
	index("idx_sessions_user_mode_active").using("btree", table.userId.asc().nullsLast(), table.mode.asc().nullsLast(), table.endedAt.asc().nullsLast(), table.startedAt.desc().nullsFirst()),
	uniqueIndex("idx_sessions_one_active").using("btree", table.userId, table.wordbookId, table.mode).where(sql`ended_at IS NULL`),
	index("idx_sessions_wordbook").using("btree", table.wordbookId.asc().nullsLast(), table.startedAt.desc().nullsFirst()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "sessions_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordbookId],
			foreignColumns: [wordbooks.id],
			name: "fk_sessions_wordbook"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordbookId, table.userId],
			foreignColumns: [wordbooks.id, wordbooks.userId],
			name: "sessions_wordbook_owner_fkey"
		}).onDelete("cascade"),
	unique("sessions_id_user_wordbook_unique").on(table.id, table.userId, table.wordbookId),
	pgPolicy("sessions_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)`  }),
	check("sessions_mode_check", sql`mode = ANY (ARRAY['review'::text, 'cram'::text, 'preview'::text, 'l2_drill'::text])`),
]);

export const noteRevisions = pgTable("note_revisions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	noteId: uuid("note_id").notNull(),
	userId: uuid("user_id").notNull(),
	wordId: uuid("word_id").notNull(),
	version: integer().notNull(),
	contentMd: text("content_md").default('').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	wordbookId: uuid("wordbook_id").notNull(),
}, (table) => [
	uniqueIndex("idx_note_revisions_note_version").using("btree", table.noteId.asc().nullsLast(), table.version.asc().nullsLast()),
	index("idx_note_revisions_note_id").using("btree", table.noteId.asc().nullsLast(), table.version.desc().nullsFirst()),
	index("idx_note_revisions_user_word").using("btree", table.userId.asc().nullsLast(), table.wordId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	foreignKey({
			columns: [table.noteId],
			foreignColumns: [notes.id],
			name: "note_revisions_note_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "note_revisions_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordId],
			foreignColumns: [words.id],
			name: "note_revisions_word_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordbookId],
			foreignColumns: [wordbooks.id],
			name: "fk_note_revisions_wordbook"
		}).onDelete("cascade"),
	pgPolicy("note_revisions_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)`  }),
]);

// 笔记条目(2026-09-06 条目化):1 行/条,追加式写入;hidden_at 非空 = 已隐藏(非破坏)。
// notes/note_revisions 为文档模型遗留,只读保留至 P4 清理,不再有代码写入路径。
export const noteEntries = pgTable("note_entries", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	wordId: uuid("word_id").notNull(),
	wordbookId: uuid("wordbook_id").notNull(),
	contentMd: text("content_md").notNull(),
	hiddenAt: timestamp("hidden_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_note_entries_wordbook").using("btree", table.wordbookId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	index("idx_note_entries_user_word").using("btree", table.userId.asc().nullsLast(), table.wordId.asc().nullsLast(), table.hiddenAt.asc().nullsFirst()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "note_entries_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordId],
			foreignColumns: [words.id],
			name: "note_entries_word_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordbookId],
			foreignColumns: [wordbooks.id],
			name: "fk_note_entries_wordbook"
		}).onDelete("cascade"),
	pgPolicy("note_entries_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)`  }),
]);

export const importRuns = pgTable("import_runs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	source: text().notNull(),
	triggerType: text("trigger_type").notNull(),
	repoOwner: text("repo_owner"),
	repoName: text("repo_name"),
	repoBranch: text("repo_branch"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	status: text().notNull(),
	importedCount: integer("imported_count").default(0).notNull(),
	createdCount: integer("created_count").default(0).notNull(),
	updatedCount: integer("updated_count").default(0).notNull(),
	unchangedCount: integer("unchanged_count").default(0).notNull(),
	softDeletedCount: integer("soft_deleted_count").default(0).notNull(),
	tagsCount: integer("tags_count").default(0).notNull(),
	errorCount: integer("error_count").default(0).notNull(),
	summary: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_import_runs_started_at").using("btree", table.startedAt.desc().nullsFirst()),
	index("idx_import_runs_status").using("btree", table.status.asc().nullsLast(), table.startedAt.desc().nullsFirst()),
	pgPolicy("import_runs_no_public_access", { as: "permissive", for: "all", to: ["public"], using: sql`false`, withCheck: sql`false`  }),
	check("import_runs_status_check", sql`status = ANY (ARRAY['running'::text, 'completed'::text, 'completed_with_errors'::text, 'failed'::text])`),
]);

export const importErrors = pgTable("import_errors", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	runId: uuid("run_id"),
	sourcePath: text("source_path"),
	errorStage: text("error_stage").notNull(),
	errorMessage: text("error_message").notNull(),
	rawExcerpt: text("raw_excerpt"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_import_errors_run_id").using("btree", table.runId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [importRuns.id],
			name: "import_errors_run_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("import_errors_no_public_access", { as: "permissive", for: "all", to: ["public"], using: sql`false`, withCheck: sql`false`  }),
]);

export const collectionNotes = pgTable("collection_notes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: text().notNull(),
	contentHash: text("content_hash").notNull(),
	sourcePath: text("source_path").notNull(),
	kind: text().notNull(),
	title: text().notNull(),
	summary: text(),
	bodyMd: text("body_md").notNull(),
	metadata: jsonb().default({}).notNull(),
	tags: text().array().default([""]).notNull(),
	relatedWordSlugs: text("related_word_slugs").array().default([""]).notNull(),
	sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true, mode: 'string' }),
	syncedAt: timestamp("synced_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	isPublished: boolean("is_published").default(true).notNull(),
	isDeleted: boolean("is_deleted").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_collection_notes_kind_published").using("btree", table.kind.asc().nullsLast(), table.isPublished.asc().nullsLast(), table.isDeleted.asc().nullsLast()),
	index("idx_collection_notes_source_path").using("btree", table.sourcePath.asc().nullsLast()),
	unique("collection_notes_slug_key").on(table.slug),
	unique("collection_notes_content_hash_key").on(table.contentHash),
	unique("collection_notes_source_path_key").on(table.sourcePath),
	pgPolicy("collection_notes_public_read", { as: "permissive", for: "select", to: ["public"], using: sql`((is_published = true) AND (is_deleted = false))` }),
	check("collection_notes_content_hash_check", sql`content_hash ~ '^[0-9a-f]{64}$'::text`),
	check("collection_notes_kind_check", sql`kind = ANY (ARRAY['root_affix'::text, 'semantic_field'::text])`),
]);

export const wordbooks = pgTable("wordbooks", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	name: text().notNull(),
	description: text(),
	isDefault: boolean("is_default").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	settings: jsonb(),
}, (table) => [
	uniqueIndex("idx_wordbooks_user_default").using("btree", table.userId.asc().nullsLast(), table.isDefault.asc().nullsLast()).where(sql`(is_default = true)`),
	index("idx_wordbooks_user_id").using("btree", table.userId.asc().nullsLast()),
	unique("wordbooks_id_user_id_unique").on(table.id, table.userId),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "wordbooks_user_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("wordbooks_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)`  }),
]);

export const reviewLogsArchive = pgTable("review_logs_archive", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	wordId: uuid("word_id"),
	progressId: uuid("progress_id"),
	sessionId: uuid("session_id"),
	rating: text(),
	state: text(),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }).notNull(),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }),
	elapsedDays: integer("elapsed_days"),
	scheduledDays: integer("scheduled_days"),
	stability: numeric(),
	difficulty: numeric(),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	wordbookId: uuid("wordbook_id").notNull(),
	previousProgressSnapshot: jsonb("previous_progress_snapshot"),
	undone: boolean().default(false).notNull(),
	undoneAt: timestamp("undone_at", { withTimezone: true, mode: 'string' }),
	idempotencyKey: text("idempotency_key"),
	track: text().default('l1').notNull(),
}, (table) => [
	index("idx_review_logs_archive_user_reviewed").using("btree", table.userId.asc().nullsLast(), table.reviewedAt.desc().nullsFirst()),
	index("idx_review_logs_archive_wordbook").using("btree", table.wordbookId.asc().nullsLast(), table.reviewedAt.desc().nullsFirst()),
	index("idx_review_logs_archive_cleanup").using("btree", table.reviewedAt, table.id),
	foreignKey({
			columns: [table.wordbookId],
			foreignColumns: [wordbooks.id],
			name: "fk_review_logs_archive_wordbook"
		}).onDelete("cascade"),
]);

export const reviewLogs = pgTable("review_logs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	wordId: uuid("word_id").notNull(),
	sessionId: uuid("session_id"),
	rating: reviewRating(),
	state: text().notNull(),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }),
	elapsedDays: integer("elapsed_days"),
	scheduledDays: integer("scheduled_days"),
	stability: numeric({ precision: 10, scale:  4 }),
	difficulty: numeric({ precision: 10, scale:  4 }),
	metadata: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	previousProgressSnapshot: jsonb("previous_progress_snapshot"),
	undone: boolean().default(false).notNull(),
	undoneAt: timestamp("undone_at", { withTimezone: true, mode: 'string' }),
	progressId: uuid("progress_id"),
	wordbookId: uuid("wordbook_id").notNull(),
	idempotencyKey: text("idempotency_key"),
	track: text("track").default('l1').notNull(),
}, (table) => [
	uniqueIndex("idx_review_logs_idempotency").using("btree", table.userId.asc().nullsLast(), table.idempotencyKey.asc().nullsLast()).where(sql`(idempotency_key IS NOT NULL)`),
	index("idx_review_logs_progress_undone").using("btree", table.progressId.asc().nullsLast(), table.reviewedAt.desc().nullsFirst()).where(sql`(undone = false)`),
	index("idx_review_logs_progress_undone_count").using("btree", table.progressId.asc().nullsLast()).where(sql`((undone = false) AND (progress_id IS NOT NULL))`),
	index("idx_review_logs_user_reviewed").using("btree", table.userId.asc().nullsLast(), table.reviewedAt.desc().nullsFirst()),
	index("idx_review_logs_user_track_reviewed").using("btree", table.userId.asc().nullsLast(), table.track.asc().nullsLast(), table.reviewedAt.desc().nullsFirst()),
	index("idx_review_logs_user_undone_reviewed").using("btree", table.userId.asc().nullsLast(), table.undone.asc().nullsLast(), table.reviewedAt.desc().nullsFirst()),
	index("idx_review_logs_word").using("btree", table.wordId.asc().nullsLast()),
	index("idx_review_logs_wordbook").using("btree", table.wordbookId.asc().nullsLast(), table.reviewedAt.desc().nullsFirst()),
	index("idx_review_logs_cleanup").using("btree", table.reviewedAt, table.id),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "review_logs_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordId],
			foreignColumns: [words.id],
			name: "review_logs_word_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sessionId],
			foreignColumns: [sessions.id],
			name: "review_logs_session_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.sessionId, table.userId, table.wordbookId],
			foreignColumns: [sessions.id, sessions.userId, sessions.wordbookId],
			name: "review_logs_session_scope_fkey"
		}),
	// progress_id 是裸列（2026-08-24 l2-drill spec §三）：track='l2' 的日志指向
	// user_word_l2_progress.id，指向 L1 行的复合 FK 已随 0013 迁移解除，
	// 引用完整性由应用层校验 + track CHECK 保证（双轨 spec 决策）。
	foreignKey({
			columns: [table.wordbookId, table.userId],
			foreignColumns: [wordbooks.id, wordbooks.userId],
			name: "review_logs_wordbook_owner_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordbookId],
			foreignColumns: [wordbooks.id],
			name: "fk_review_logs_wordbook"
		}).onDelete("cascade"),
	check("review_logs_track_check", sql`track = ANY (ARRAY['l1'::text, 'l2'::text])`),
	pgPolicy("review_logs_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)`  }),
]);

export const wordHighlights = pgTable("word_highlights", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	wordId: uuid("word_id").notNull(),
	wordbookId: uuid("wordbook_id").notNull(),
	sourceField: text("source_field").default('definition_md').notNull(),
	textSnippet: text("text_snippet").notNull(),
	color: text().default('#eab308').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_word_highlights_lookup").using("btree", table.userId.asc().nullsLast(), table.wordbookId.asc().nullsLast(), table.wordId.asc().nullsLast()),
	uniqueIndex("idx_word_highlights_unique_snippet").using("btree", table.userId.asc().nullsLast(), table.wordbookId.asc().nullsLast(), table.wordId.asc().nullsLast(), table.sourceField.asc().nullsLast(), table.textSnippet.asc().nullsLast()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "word_highlights_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordId],
			foreignColumns: [words.id],
			name: "word_highlights_word_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordbookId],
			foreignColumns: [wordbooks.id],
			name: "word_highlights_wordbook_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("word_highlights_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
]);

export const wordAnnotations = pgTable("word_annotations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	wordId: uuid("word_id").notNull(),
	wordbookId: uuid("wordbook_id").notNull(),
	content: text().default('').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_word_annotations_lookup").using("btree", table.userId.asc().nullsLast(), table.wordbookId.asc().nullsLast(), table.wordId.asc().nullsLast()),
	uniqueIndex("idx_word_annotations_unique").using("btree", table.userId.asc().nullsLast(), table.wordbookId.asc().nullsLast(), table.wordId.asc().nullsLast()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "word_annotations_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordId],
			foreignColumns: [words.id],
			name: "word_annotations_word_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordbookId],
			foreignColumns: [wordbooks.id],
			name: "word_annotations_wordbook_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("word_annotations_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
]);

export const wordTags = pgTable("word_tags", {
	wordId: uuid("word_id").notNull(),
	tagId: uuid("tag_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.wordId],
			foreignColumns: [words.id],
			name: "word_tags_word_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.tagId],
			foreignColumns: [tags.id],
			name: "word_tags_tag_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.wordId, table.tagId], name: "word_tags_pkey"}),
	pgPolicy("word_tags_public_read", { as: "permissive", for: "select", to: ["public"], using: sql`true` }),
]);

export const wordbookItems = pgTable("wordbook_items", {
	wordbookId: uuid("wordbook_id").notNull(),
	wordId: uuid("word_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_wordbook_items_word_id").using("btree", table.wordId.asc().nullsLast()),
	foreignKey({
			columns: [table.wordbookId],
			foreignColumns: [wordbooks.id],
			name: "wordbook_items_wordbook_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordId],
			foreignColumns: [words.id],
			name: "wordbook_items_word_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.wordbookId, table.wordId], name: "wordbook_items_pkey"}),
	pgPolicy("wordbook_items_via_wordbook", { as: "permissive", for: "all", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM wordbooks w
  WHERE ((w.id = wordbook_items.wordbook_id) AND (w.user_id = auth.uid()))))`, withCheck: sql`(EXISTS ( SELECT 1
   FROM wordbooks w
  WHERE ((w.id = wordbook_items.wordbook_id) AND (w.user_id = auth.uid()))))`  }),
]);

export const wordFilterFacets = pgTable("word_filter_facets", {
	dimension: text().notNull(),
	value: text().notNull(),
	count: integer().default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.dimension, table.value], name: "word_filter_facets_pkey"}),
	pgPolicy("word_filter_facets_public_read", { as: "permissive", for: "select", to: ["public"], using: sql`(count > 0)` }),
	check("word_filter_facets_dimension_check", sql`dimension = ANY (ARRAY['semantic_field'::text, 'word_freq'::text])`),
	check("word_filter_facets_count_check", sql`count >= 0`),
]);

export const dailyForecastSnapshots = pgTable("daily_forecast_snapshots", {
	userId: uuid("user_id").notNull(),
	date: date().notNull(),
	forecastCount: integer("forecast_count").notNull(),
	desiredRetention: numeric("desired_retention").notNull(),
	capturedAt: timestamp("captured_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_daily_forecast_snapshots_user_date").using("btree", table.userId.asc().nullsLast(), table.date.desc().nullsFirst()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "daily_forecast_snapshots_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.userId, table.date], name: "daily_forecast_snapshots_pkey"}),
	pgPolicy("daily_forecast_snapshots_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)`  }),
	check("daily_forecast_snapshots_forecast_count_check", sql`forecast_count >= 0`),
]);

export const userWordL2Progress = pgTable("user_word_l2_progress", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	wordId: uuid("word_id").notNull().references(() => words.id, { onDelete: "cascade" }),
	// L2 progress is wordbook-scoped: a user reviewing the same word in two
	// different wordbooks must get independent L2 progress rows, matching the
	// (user_id, wordbook_id, word_id) scoping used across the rest of the V2
	// review track. Without this column, L2 progress was incorrectly shared
	// across wordbooks for the same user+word.
	wordbookId: uuid("wordbook_id").notNull().references(() => wordbooks.id, { onDelete: "cascade" }),
	l2Stability: numeric("l2_stability", { precision: 10, scale: 4 }),
	l2Difficulty: numeric("l2_difficulty", { precision: 10, scale: 4 }),
	l2Retrievability: numeric("l2_retrievability", { precision: 8, scale: 6 }),
	l2State: text("l2_state").default('review').notNull(),
	l2DesiredRetention: numeric("l2_desired_retention", { precision: 4, scale: 3 }).default('0.900').notNull(),
	l2DueAt: timestamp("l2_due_at", { withTimezone: true, mode: 'string' }),
	l2LastReviewedAt: timestamp("l2_last_reviewed_at", { withTimezone: true, mode: 'string' }),
	l2LastRating: text("l2_last_rating"),
	l2ReviewCount: integer("l2_review_count").default(0).notNull(),
	l2LapseCount: integer("l2_lapse_count").default(0).notNull(),
	l2IntervalDays: integer("l2_interval_days"),
	l2SchedulerPayload: jsonb("l2_scheduler_payload").default({}).notNull(),
	l2AgainCount: integer("l2_again_count").default(0).notNull(),
	l2HardCount: integer("l2_hard_count").default(0).notNull(),
	l2GoodCount: integer("l2_good_count").default(0).notNull(),
	l2EasyCount: integer("l2_easy_count").default(0).notNull(),
	l2ContentHashSnapshot: text("l2_content_hash_snapshot"),
	recentRatings: jsonb("recent_ratings").default([]).notNull(),
	l2Paused: boolean("l2_paused").default(false).notNull(),
	l2PausedAt: timestamp("l2_paused_at", { withTimezone: true, mode: 'string' }),
	l2PausedReason: text("l2_paused_reason"),
	l2InheritedFromL1: boolean("l2_inherited_from_l1").default(false),
	l2WeightsSource: text("l2_weights_source").default('inherited'),
	l2PredictedRetrievability: numeric("l2_predicted_retrievability", { precision: 8, scale: 6 }),
	// 2026-08-24 l2-drill spec：产出步自评结果（passed/weak）。非 FSRS 字段，
	// 仅作能力阶段标记；NULL = 尚未做过产出任务。
	l2ProductionStatus: text("l2_production_status"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("idx_l2_progress_user_wordbook_word").on(table.userId, table.wordbookId, table.wordId),
	index("idx_l2_progress_wordbook_due").on(table.wordbookId, table.userId, table.l2DueAt).where(sql`(l2_paused = false)`),
	index("idx_l2_progress_word").on(table.wordId),
	pgPolicy("user_word_l2_progress_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l2_state_check", sql`l2_state = ANY (ARRAY['new'::text, 'learning'::text, 'review'::text, 'relearning'::text, 'suspended'::text])`),
	check("l2_retention_check", sql`l2_desired_retention >= 0.900 AND l2_desired_retention <= 0.990`),
	check("l2_paused_reason_check", sql`l2_paused_reason IS NULL OR l2_paused_reason = ANY (ARRAY['l1_cascade_failure'::text, 'wordbook_focus'::text, 'manual'::text])`),
	check("l2_production_status_check", sql`l2_production_status IS NULL OR l2_production_status = ANY (ARRAY['passed'::text, 'weak'::text])`),
]);

// 辨析训练会话的步骤明细表（2026-08-24 l2-drill spec §三）。
// 事实记录而非调度器：FSRS 真相在 user_word_l2_progress；删步不影响调度。
export const l2DrillSessionSteps = pgTable("l2_drill_session_steps", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	sessionId: uuid("session_id").notNull(),
	userId: uuid("user_id").notNull(),
	wordbookId: uuid("wordbook_id").notNull(),
	wordId: uuid("word_id").notNull(),
	// L2 进度行 id。裸 uuid + 应用层校验：词书空间策略未来引入 master 行时可平滑切换。
	progressId: uuid("progress_id").notNull(),
	stepIndex: integer("step_index").notNull(),
	stepType: text("step_type").notNull(),
	status: text("status").default('pending').notNull(),
	taskId: text("task_id"),
	taskType: text("task_type"),
	taskPayload: jsonb("task_payload"),
	outcome: text("outcome"),
	mappedRating: reviewRating("mapped_rating"),
	reviewLogId: uuid("review_log_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("idx_l2_drill_steps_session_word_step").on(table.sessionId, table.wordId, table.stepIndex),
	index("idx_l2_drill_steps_session").using("btree", table.sessionId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	index("idx_l2_drill_steps_user_word").using("btree", table.userId.asc().nullsLast(), table.wordId.asc().nullsLast()),
	foreignKey({
			columns: [table.sessionId],
			foreignColumns: [sessions.id],
			name: "l2_drill_steps_session_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "l2_drill_steps_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordId],
			foreignColumns: [words.id],
			name: "l2_drill_steps_word_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordbookId],
			foreignColumns: [wordbooks.id],
			name: "fk_l2_drill_steps_wordbook"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sessionId, table.userId, table.wordbookId],
			foreignColumns: [sessions.id, sessions.userId, sessions.wordbookId],
			name: "l2_drill_steps_session_scope_fkey"
		}),
	foreignKey({
			columns: [table.wordbookId, table.userId],
			foreignColumns: [wordbooks.id, wordbooks.userId],
			name: "l2_drill_steps_wordbook_owner_fkey"
		}).onDelete("cascade"),
	unique("l2_drill_steps_id_user_wordbook_unique").on(table.id, table.userId, table.wordbookId),
	pgPolicy("l2_drill_steps_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l2_drill_steps_step_type_check", sql`step_type = ANY (ARRAY['l2_discrimination'::text, 'l2_production'::text])`),
	check("l2_drill_steps_status_check", sql`status = ANY (ARRAY['pending'::text, 'completed'::text, 'skipped'::text])`),
	check("l2_drill_steps_task_type_check", sql`task_type IS NULL OR task_type = ANY (ARRAY['cloze_mcq'::text, 'synonym_discrimination'::text, 'production'::text])`),
	check("l2_drill_steps_outcome_check", sql`outcome IS NULL OR outcome = ANY (ARRAY['correct'::text, 'incorrect'::text, 'self_passed'::text, 'self_weak'::text])`),
]);

export const llmUsage = pgTable("llm_usage", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	provider: text("provider").notNull(),
	model: text("model").notNull(),
	promptTokens: integer("prompt_tokens").notNull(),
	completionTokens: integer("completion_tokens").notNull(),
	status: text("status").default("settled").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	finalizedAt: timestamp("finalized_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_llm_usage_created").on(table.createdAt),
	index("idx_llm_usage_pending_expiry").on(table.expiresAt, table.id).where(sql`status = 'pending'`),
	index("idx_llm_usage_terminal_finalized_cleanup").on(table.finalizedAt, table.id).where(sql`status IN ('released', 'expired') AND finalized_at IS NOT NULL`),
	index("idx_llm_usage_settled_created_cleanup").on(table.createdAt, table.id).where(sql`status = 'settled'`),
	check("llm_usage_status_check", sql`status = ANY (ARRAY['pending'::text, 'settled'::text, 'released'::text, 'expired'::text])`),
	check("llm_usage_reservation_lifecycle_check", sql`(status = 'settled' AND provider <> '__reservation__' AND expires_at IS NULL) OR (status = 'pending' AND provider = '__reservation__' AND expires_at IS NOT NULL AND finalized_at IS NULL) OR (status = ANY (ARRAY['released'::text, 'expired'::text]) AND provider = '__reservation__' AND expires_at IS NOT NULL AND finalized_at IS NOT NULL)`),
]);

export const wordL2Content = pgTable("word_l2_content", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	wordId: uuid("word_id").notNull().references(() => words.id, { onDelete: "cascade" }),
	field: text("field").notNull(),
	// ADR-0017 方向变体：默认 '通用'（方向无关桶）。候选行（is_active=false）
	// 天然携带 direction，无需单独改候选池表结构。
	direction: text("direction").default('通用').notNull(),
	content: jsonb("content").notNull(),
	source: text("source").notNull(),
	sourceRef: text("source_ref"),
	approvedBy: text("approved_by").default("user"),
	approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	isActive: boolean("is_active").default(true).notNull(),
}, (table) => [
	index("idx_l2_content_word_field").on(table.wordId, table.field),
	index("idx_l2_content_source").on(table.source),
	// ADR-0017 修正（2026-09-11）：direction 只作维度，不设唯一约束——同一
	// (word, field, direction) 的 active 行可 0..n 条（confirmDraft 追加式写入、
	// acceptCandidate(append) 共存是既有语义），缓存按 created_at 聚合。
	check("word_l2_content_direction_check", sql`direction = ANY (ARRAY['通用'::text, '考研'::text, '雅思'::text])`),
]);

export const l3Sources = pgTable("l3_sources", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	wordbookId: uuid("wordbook_id"),
	sourceType: text("source_type").notNull(),
	// ADR-0017 方向轴（正交于子空间）：默认 '通用'。
	direction: text("direction").default('通用').notNull(),
	title: text("title").notNull(),
	author: text("author"),
	url: text("url"),
	language: text("language"),
	metadata: jsonb("metadata").default({}).notNull(),
	contentText: text("content_text"),
	contentHash: text("content_hash"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
        index("idx_l3_sources_user_created").on(table.userId, table.createdAt),
        // 0026：书架搜索 pg_trgm GIN 索引（ILIKE %q% 全表扫描 → Bitmap Index Scan；
        // 同 words 表 idx_words_*_trgm 先例，扩展由 0000 baseline 创建）
        index("idx_l3_sources_title_trgm").using("gin", table.title.asc().nullsLast().op("gin_trgm_ops")),
        index("idx_l3_sources_content_trgm").using("gin", table.contentText.asc().nullsLast().op("gin_trgm_ops")),
        unique("l3_sources_id_user_id_unique").on(table.id, table.userId),
	uniqueIndex("l3_sources_user_content_hash_unique").on(table.userId, table.contentHash).where(sql`content_hash IS NOT NULL`),
	foreignKey({
			columns: [table.wordbookId, table.userId],
			foreignColumns: [wordbooks.id, wordbooks.userId],
			name: "l3_sources_wordbook_owner_fk"
		}).onDelete("cascade"),
	pgPolicy("l3_sources_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_sources_source_type_check", sql`source_type = ANY (ARRAY['article'::text, 'book'::text, 'video'::text, 'audio'::text, 'chat'::text, 'manual'::text, 'web'::text, 'other'::text])`),
	check("l3_sources_direction_check", sql`direction = ANY (ARRAY['通用'::text, '考研'::text, '雅思'::text])`),
]);

// ADR-0019 §4 / CONTEXT.md「Sub-space (子空间)」：L3 能力域轴（语法/阅读/作文/
// 翻译/通用），与 direction（考试轴，ADR-0017）正交。一个 source 可同时属于多个
// 子空间 → 多对多 junction（对齐 word_tags 先例），非 array 列：过滤走普通
// btree 索引、多值唯一性由 (source_id, space) 约束保证（见迁移 0030 说明）。
// 供 T06 错题库过滤与 T07 攻坚包按子空间取源。
export const l3SourceSpaces = pgTable("l3_source_spaces", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	sourceId: uuid("source_id").notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	space: text("space").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	// 支撑"按子空间筛选"：给定 (user, space) → 该域下全部 source。
	index("idx_l3_source_spaces_user_space").on(table.userId, table.space),
	// 同一 source 对同一子空间至多一条（多值唯一性；source_id 已由复合 FK 绑定单一 owner）。
	unique("l3_source_spaces_source_space_unique").on(table.sourceId, table.space),
	// 复合 owner FK：source_id 必须属于同一 user（防越权把子空间挂到他人 source），
	// 与 l3_occurrences/l3_contexts 的 L3 owner 隔离先例一致。
	foreignKey({
			columns: [table.sourceId, table.userId],
			foreignColumns: [l3Sources.id, l3Sources.userId],
			name: "l3_source_spaces_source_owner_fk"
		}).onDelete("cascade"),
	pgPolicy("l3_source_spaces_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_source_spaces_space_check", sql`space = ANY (ARRAY['语法'::text, '阅读'::text, '作文'::text, '翻译'::text, '通用'::text])`),
]);

// L3 owner isolation: composite foreign keys below ensure scoped rows cannot
// point at parent rows owned by a different user, even outside service code.
export const l3Contexts = pgTable("l3_contexts", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	sourceId: uuid("source_id").notNull().references(() => l3Sources.id, { onDelete: "cascade" }),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	contextType: text("context_type").notNull(),
	text: text("text").notNull(),
	normalizedText: text("normalized_text"),
	language: text("language"),
	position: jsonb("position").default({}).notNull(),
	metadata: jsonb("metadata").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	index("idx_l3_contexts_source_created").on(table.sourceId, table.createdAt),
	unique("l3_contexts_id_user_id_unique").on(table.id, table.userId),
	foreignKey({
			columns: [table.sourceId, table.userId],
			foreignColumns: [l3Sources.id, l3Sources.userId],
			name: "l3_contexts_source_owner_fk"
		}).onDelete("cascade"),
	pgPolicy("l3_contexts_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_contexts_context_type_check", sql`context_type = ANY (ARRAY['sentence'::text, 'paragraph'::text, 'excerpt'::text, 'dialogue'::text, 'note'::text])`),
]);

export const l3Occurrences = pgTable("l3_occurrences", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	contextId: uuid("context_id").notNull().references(() => l3Contexts.id, { onDelete: "cascade" }),
	wordId: uuid("word_id").notNull().references(() => words.id, { onDelete: "cascade" }),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	surface: text("surface").notNull(),
	lemma: text("lemma"),
	startOffset: integer("start_offset"),
	endOffset: integer("end_offset"),
	confidence: numeric("confidence", { precision: 5, scale: 4 }),
    evidence: jsonb("evidence").default({}).notNull(),
    // 语境义快照（2026-09-08）：圈记时绑定的释义/搭配文本，不引用 L1 义项下标（快照语义，
    // L1 词义重审不回写 L3——三轨隔离）。
    boundSense: text("bound_sense"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
    index("idx_l3_occurrences_word_created").on(table.wordId, table.createdAt),
	index("idx_l3_occurrences_context").on(table.contextId),
	foreignKey({
			columns: [table.contextId, table.userId],
			foreignColumns: [l3Contexts.id, l3Contexts.userId],
			name: "l3_occurrences_context_owner_fk"
		}).onDelete("cascade"),
	pgPolicy("l3_occurrences_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_occurrences_offset_check", sql`(start_offset IS NULL AND end_offset IS NULL) OR (start_offset IS NOT NULL AND end_offset IS NOT NULL AND start_offset >= 0 AND end_offset >= start_offset)`),
	check("l3_occurrences_confidence_check", sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 1)`),
]);

export const l3ContextLinks = pgTable("l3_context_links", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	contextId: uuid("context_id").references(() => l3Contexts.id, { onDelete: "cascade" }),
	wordId: uuid("word_id").references(() => words.id, { onDelete: "cascade" }),
	linkType: text("link_type").notNull(),
	targetType: text("target_type").notNull(),
	targetId: text("target_id"),
	targetRef: jsonb("target_ref").default({}).notNull(),
	confidence: numeric("confidence", { precision: 5, scale: 4 }),
	provenance: jsonb("provenance").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	index("idx_l3_context_links_word_type").on(table.wordId, table.linkType),
	index("idx_l3_context_links_context_type").on(table.contextId, table.linkType),
	foreignKey({
			columns: [table.contextId, table.userId],
			foreignColumns: [l3Contexts.id, l3Contexts.userId],
			name: "l3_context_links_context_owner_fk"
		}).onDelete("cascade"),
	pgPolicy("l3_context_links_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_context_links_link_type_check", sql`link_type = ANY (ARRAY['supports'::text, 'illustrates'::text, 'contrasts'::text, 'collocates_with'::text, 'synonym_of'::text, 'antonym_of'::text, 'derived_from'::text, 'topic_related'::text, 'manual_link'::text])`),
	check("l3_context_links_target_type_check", sql`target_type = ANY (ARRAY['word'::text, 'l2_item'::text, 'context'::text, 'source'::text, 'topic'::text, 'external'::text])`),
	check("l3_context_links_confidence_check", sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 1)`),
]);

export const l3ImportJobs = pgTable("l3_import_jobs", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	sourceId: uuid("source_id").references(() => l3Sources.id, { onDelete: "set null" }),
	status: text("status").notNull(),
	inputHash: text("input_hash").notNull(),
	inputSummary: text("input_summary"),
	stats: jsonb("stats").default({}).notNull(),
	error: text("error"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	index("idx_l3_import_jobs_user_status").on(table.userId, table.status),
	uniqueIndex("idx_l3_import_jobs_user_input_hash").on(table.userId, table.inputHash).where(sql`input_hash IS NOT NULL`),
	pgPolicy("l3_import_jobs_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_import_jobs_status_check", sql`status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text])`),
]);

export const l3Proposals = pgTable("l3_proposals", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	wordbookId: uuid("wordbook_id"),
	sourceType: text("source_type").notNull(),
	status: text("status").default("pending").notNull(),
	title: text("title"),
	summary: text("summary"),
	inputHash: text("input_hash"),
	proposedBy: text("proposed_by"),
	provenance: jsonb("provenance").default({}).notNull(),
	reviewNote: text("review_note"),
	confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }),
	rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "string" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	index("idx_l3_proposals_user_status_created").on(table.userId, table.status, table.createdAt),
	uniqueIndex("idx_l3_proposals_user_input_hash").on(table.userId, table.inputHash).where(sql`input_hash IS NOT NULL`),
	unique("l3_proposals_id_user_id_unique").on(table.id, table.userId),
	foreignKey({
			columns: [table.wordbookId, table.userId],
			foreignColumns: [wordbooks.id, wordbooks.userId],
			name: "l3_proposals_wordbook_owner_fk"
		}).onDelete("cascade"),
	pgPolicy("l3_proposals_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_proposals_source_type_check", sql`source_type = ANY (ARRAY['agent'::text, 'import'::text, 'external_tool'::text, 'manual_draft'::text, 'other'::text])`),
	check("l3_proposals_status_check", sql`status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'rejected'::text, 'canceled'::text])`),
]);

export const l3ProposalItems = pgTable("l3_proposal_items", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	proposalId: uuid("proposal_id").notNull().references(() => l3Proposals.id, { onDelete: "cascade" }),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	itemType: text("item_type").notNull(),
	ordinal: integer("ordinal").notNull(),
	payload: jsonb("payload").notNull(),
	status: text("status").default("pending").notNull(),
	validationErrors: jsonb("validation_errors").default([]).notNull(),
	activeEntityType: text("active_entity_type"),
	activeEntityId: uuid("active_entity_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	index("idx_l3_proposal_items_proposal_ordinal").on(table.proposalId, table.ordinal),
	index("idx_l3_proposal_items_user_status").on(table.userId, table.status),
	unique("l3_proposal_items_proposal_ordinal_unique").on(table.proposalId, table.ordinal),
	foreignKey({
			columns: [table.proposalId, table.userId],
			foreignColumns: [l3Proposals.id, l3Proposals.userId],
			name: "l3_proposal_items_proposal_owner_fk"
		}).onDelete("cascade"),
	pgPolicy("l3_proposal_items_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_proposal_items_item_type_check", sql`item_type = ANY (ARRAY['source'::text, 'context'::text, 'occurrence'::text, 'context_link'::text])`),
	check("l3_proposal_items_status_check", sql`status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'rejected'::text])`),
	check("l3_proposal_items_active_entity_type_check", sql`active_entity_type IS NULL OR active_entity_type = ANY (ARRAY['source'::text, 'context'::text, 'occurrence'::text, 'context_link'::text])`),
]);

export const l3RecommendationRuns = pgTable("l3_recommendation_runs", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	wordbookId: uuid("wordbook_id"),
	mode: text("mode").notNull(),
	status: text("status").default("completed").notNull(),
	inputHash: text("input_hash"),
	stats: jsonb("stats").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }).defaultNow(),
}, (table) => [
	index("idx_l3_recommendation_runs_user_created").on(table.userId, table.createdAt),
	unique("l3_recommendation_runs_id_user_id_unique").on(table.id, table.userId),
	foreignKey({
			columns: [table.wordbookId, table.userId],
			foreignColumns: [wordbooks.id, wordbooks.userId],
			name: "l3_recommendation_runs_wordbook_owner_fk"
		}).onDelete("cascade"),
	pgPolicy("l3_recommendation_runs_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_recommendation_runs_mode_check", sql`mode = ANY (ARRAY['review_pack'::text, 'learn_next'::text, 'gap_scan'::text, 'link_suggestions'::text])`),
	check("l3_recommendation_runs_status_check", sql`status = ANY (ARRAY['completed'::text, 'failed'::text])`),
]);

export const l3RecommendationItems = pgTable("l3_recommendation_items", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	runId: uuid("run_id").notNull().references(() => l3RecommendationRuns.id, { onDelete: "cascade" }),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	wordbookId: uuid("wordbook_id"),
	recommendationType: text("recommendation_type").notNull(),
	status: text("status").default("pending").notNull(),
	title: text("title").notNull(),
	summary: text("summary").notNull(),
	priorityScore: numeric("priority_score", { precision: 8, scale: 4 }).notNull(),
	confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
	reasonCodes: jsonb("reason_codes").default([]).notNull(),
	evidence: jsonb("evidence").default([]).notNull(),
	payload: jsonb("payload").default({}).notNull(),
	acceptedProposalId: uuid("accepted_proposal_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
	acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
	rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "string" }),
	dismissedAt: timestamp("dismissed_at", { withTimezone: true, mode: "string" }),
}, (table) => [
	index("idx_l3_recommendation_items_user_status_created").on(table.userId, table.status, table.createdAt),
	index("idx_l3_recommendation_items_run").on(table.runId),
	foreignKey({
			columns: [table.runId, table.userId],
			foreignColumns: [l3RecommendationRuns.id, l3RecommendationRuns.userId],
			name: "l3_recommendation_items_run_owner_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.wordbookId, table.userId],
			foreignColumns: [wordbooks.id, wordbooks.userId],
			name: "l3_recommendation_items_wordbook_owner_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.acceptedProposalId, table.userId],
			foreignColumns: [l3Proposals.id, l3Proposals.userId],
			name: "l3_recommendation_items_proposal_owner_fk"
		}).onDelete("no action"),
	pgPolicy("l3_recommendation_items_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_recommendation_items_type_check", sql`recommendation_type = ANY (ARRAY['review_pack'::text, 'learn_next'::text, 'link_gap'::text, 'context_gap'::text, 'l2_gap'::text, 'weak_word'::text, 'related_word'::text])`),
	check("l3_recommendation_items_status_check", sql`status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'dismissed'::text, 'expired'::text])`),
	check("l3_recommendation_items_priority_check", sql`priority_score >= 0`),
	check("l3_recommendation_items_confidence_check", sql`confidence >= 0 AND confidence <= 1`),
]);

// ── 增量升级 / L3 慢学习（ADR-0018 / ADR-0019，2026-09-11）────────────────
// 边界（ADR-0004 §6 / ADR-0005）：这三张表都不参与 FSRS——无 stability /
// difficulty / retrievability / due 列。L3 练习"有记录、无调度"；错题库 =
// attempts(outcome='wrong') 的派生视图，不建第二真相源。

export const l3Sessions = pgTable("l3_sessions", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	type: text("type").notNull(),
	title: text("title"),
	// 服务端计划 = 实体引用 + version（ADR-0019 §2）。DB 只存 JSONB、不校验
	// 内容；渲染描述现拉现造，不存冻结 HTML 产物。非法 version 由服务层拒绝。
	plan: jsonb("plan").notNull(),
	version: integer("version").default(1).notNull(),
	status: text("status").default('active').notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	pgPolicy("l3_sessions_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_sessions_type_check", sql`type = ANY (ARRAY['l2_upgrade'::text, 'l3_practice'::text, 'cram_pack'::text, 'knowledge'::text])`),
	check("l3_sessions_status_check", sql`status = ANY (ARRAY['active'::text, 'completed'::text, 'abandoned'::text])`),
]);

export const upgradeWorkOrders = pgTable("upgrade_work_orders", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	wordId: uuid("word_id").notNull().references(() => words.id, { onDelete: "cascade" }),
	wordbookId: uuid("wordbook_id").notNull(),
	// 方向由工单指定（ADR-0017/0018）：升级产出进入该方向的变体行。
	direction: text("direction").notNull(),
	status: text("status").default('标记中').notNull(),
	// 升级建议三档快照（ADR-0018 §2）：标记时刻的建议，纯提示、零 FSRS 写入。
	suggestionSnapshot: jsonb("suggestion_snapshot"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
}, (table) => [
	// 同一 (user, word, wordbook) 至多一张进行中工单；已完结/已取消不阻塞重开。
	uniqueIndex("idx_upgrade_work_orders_one_active").on(table.userId, table.wordId, table.wordbookId).where(sql`status IN ('标记中', '升级中')`),
	foreignKey({
			columns: [table.wordbookId, table.userId],
			foreignColumns: [wordbooks.id, wordbooks.userId],
			name: "upgrade_work_orders_wordbook_owner_fk"
		}).onDelete("cascade"),
	pgPolicy("upgrade_work_orders_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("upgrade_work_orders_direction_check", sql`direction = ANY (ARRAY['通用'::text, '考研'::text, '雅思'::text])`),
	check("upgrade_work_orders_status_check", sql`status = ANY (ARRAY['标记中'::text, '升级中'::text, '已完成'::text, '已取消'::text])`),
]);

export const l3PracticeAttempts = pgTable("l3_practice_attempts", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	// target = context（句子），不是裸词（ADR-0019 §Tradeoffs）；复合 FK 保证
	// 不能挂到他人语境上。
	contextId: uuid("context_id").notNull().references(() => l3Contexts.id, { onDelete: "cascade" }),
	// 可选 occurrence 指向：occurrence 被删时保留记录本身（指针置空）。
	occurrenceId: uuid("occurrence_id").references(() => l3Occurrences.id, { onDelete: "set null" }),
	// 可空会话归属（自由练习无会话）；会话删除不销毁错题记录。
	sessionId: uuid("session_id").references(() => l3Sessions.id, { onDelete: "set null" }),
	practiceType: text("practice_type").notNull(),
	outcome: text("outcome").notNull(),
	payload: jsonb("payload").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	index("idx_l3_practice_attempts_user_outcome_created").on(table.userId, table.outcome, table.createdAt),
	foreignKey({
			columns: [table.contextId, table.userId],
			foreignColumns: [l3Contexts.id, l3Contexts.userId],
			name: "l3_practice_attempts_context_owner_fk"
		}).onDelete("cascade"),
	pgPolicy("l3_practice_attempts_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_practice_attempts_practice_type_check", sql`practice_type = ANY (ARRAY['essay_dictation'::text, 'context_quiz'::text])`),
	check("l3_practice_attempts_outcome_check", sql`outcome = ANY (ARRAY['correct'::text, 'wrong'::text, 'skip'::text])`),
]);

// ADR-0030 §1：题目实体，与 l3_contexts（词的用法）严格分离。真题题干/选项/
// 标准答案不进 context，避免污染图、词空间高亮等读模型。做题文件是派生视图：
// 有正文的阅读类文件 = (source_id, question_type) 题组聚合；无正文题组
// （翻译/作文）由 file_key 定界。CHECK 保证二者至少居其一。
export const l3Questions = pgTable("l3_questions", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	sourceId: uuid("source_id"),
	fileKey: text("file_key"),
	// 能力域由题型自动映射（ADR-0030 §3），录入时写入，venue 过滤直接点查。
	space: text("space").notNull(),
	questionType: text("question_type").notNull(),
	ordinal: integer("ordinal").default(0).notNull(),
	stem: text("stem").notNull(),
	options: jsonb("options").default([]).notNull(),
	answer: jsonb("answer").default({}).notNull(),
	explanation: text("explanation"),
	evidence: jsonb("evidence").default([]).notNull(),
	// pending（agent 提案，后续波次启用）/ active（owner/trusted 直写）/ rejected。
	status: text("status").default('active').notNull(),
	// 服务端认定的写入者：'owner' 或 agentId（ADR-0029 信任锚，非调用方自报）。
	createdBy: text("created_by").default('owner').notNull(),
	inputHash: text("input_hash"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	index("idx_l3_questions_source_type_ordinal").on(table.userId, table.sourceId, table.questionType, table.ordinal),
	index("idx_l3_questions_file_key").on(table.userId, table.fileKey),
	index("idx_l3_questions_user_type_status").on(table.userId, table.questionType, table.status),
	unique("l3_questions_id_user_id_unique").on(table.id, table.userId),
	uniqueIndex("l3_questions_user_input_hash_unique").on(table.userId, table.inputHash).where(sql`input_hash IS NOT NULL`),
	foreignKey({
			columns: [table.sourceId, table.userId],
			foreignColumns: [l3Sources.id, l3Sources.userId],
			name: "l3_questions_source_owner_fk"
		}).onDelete("cascade"),
	pgPolicy("l3_questions_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_questions_identity_check", sql`source_id IS NOT NULL OR file_key IS NOT NULL`),
	check("l3_questions_space_check", sql`space = ANY (ARRAY['语法'::text, '阅读'::text, '作文'::text, '翻译'::text, '通用'::text])`),
	check("l3_questions_question_type_check", sql`question_type = ANY (ARRAY['cloze'::text, 'reading_choice'::text, 'new_question'::text, 'sentence_translation'::text, 'short_essay'::text, 'long_essay'::text, 'grammar_blank'::text])`),
	check("l3_questions_status_check", sql`status = ANY (ARRAY['pending'::text, 'active'::text, 'rejected'::text])`),
]);

// ADR-0030 §2：试卷 = 文件的有序串联。卷面结构存 payload（学 l3_sessions.plan
// 的「计划存引用、现拉现渲染」），不建 sections 表；payload_version + 服务层
// 写入校验 + 渲染降级 + 删题 409 构成引用完整性的三道护栏。
export const l3Papers = pgTable("l3_papers", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	title: text("title").notNull(),
	direction: text("direction"),
	metadata: jsonb("metadata").default({}).notNull(),
	payload: jsonb("payload").notNull(),
	payloadVersion: integer("payload_version").default(1).notNull(),
	status: text("status").default('active').notNull(),
	createdBy: text("created_by").default('owner').notNull(),
	inputHash: text("input_hash"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	index("idx_l3_papers_user_created").on(table.userId, table.createdAt),
	index("idx_l3_papers_user_status").on(table.userId, table.status),
	unique("l3_papers_id_user_id_unique").on(table.id, table.userId),
	uniqueIndex("l3_papers_user_input_hash_unique").on(table.userId, table.inputHash).where(sql`input_hash IS NOT NULL`),
	pgPolicy("l3_papers_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_papers_direction_check", sql`direction = ANY (ARRAY['通用'::text, '考研'::text, '雅思'::text])`),
	check("l3_papers_status_check", sql`status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])`),
]);

// 批次二（ADR-0034 §1）：题纸 = 两个 venue（file/paper）的统一作答容器。
// scope_key 单列非空字符串（'file:<source_id>:<question_type>' / 'paper:<paper_id>'）
// 规避组合列在 NULL 时唯一索引不去重的陷阱；部分唯一索引保证一作用域至多一张
// 在写（draft）题纸。answers 仅 draft 期有效——定格（seal）物化 attempts 后清空，
// attempts 是唯一作答真源，不冻第二份副本（双真相拆解）。
export const l3Submissions = pgTable("l3_submissions", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	scope: text("scope").notNull(),
	scopeKey: text("scope_key").notNull(),
	sourceId: uuid("source_id"),
	questionType: text("question_type"),
	paperId: uuid("paper_id"),
	// draft（防抖自动保存）→ sealed（定格，PATCH 409）| discarded（弃，留墓碑）。
	status: text("status").default('draft').notNull(),
	answers: jsonb("answers").default({}).notNull(),
	sealMode: text("seal_mode"),
	summary: text("summary"),
	sealedAt: timestamp("sealed_at", { withTimezone: true, mode: "string" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	index("idx_l3_submissions_user_created").on(table.userId, table.createdAt),
	index("idx_l3_submissions_user_status").on(table.userId, table.status),
	unique("l3_submissions_id_user_id_unique").on(table.id, table.userId),
	uniqueIndex("l3_submissions_user_scope_key_draft_unique").on(table.userId, table.scopeKey).where(sql`status = 'draft'`),
	foreignKey({
			columns: [table.sourceId, table.userId],
			foreignColumns: [l3Sources.id, l3Sources.userId],
			name: "l3_submissions_source_owner_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.paperId, table.userId],
			foreignColumns: [l3Papers.id, l3Papers.userId],
			name: "l3_submissions_paper_owner_fk"
		}).onDelete("cascade"),
	pgPolicy("l3_submissions_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_submissions_scope_check", sql`scope = ANY (ARRAY['file'::text, 'paper'::text])`),
	check("l3_submissions_scope_shape_check", sql`(scope = 'file' AND source_id IS NOT NULL AND question_type IS NOT NULL AND paper_id IS NULL) OR (scope = 'paper' AND paper_id IS NOT NULL AND source_id IS NULL AND question_type IS NULL)`),
	check("l3_submissions_status_check", sql`status = ANY (ARRAY['draft'::text, 'sealed'::text, 'discarded'::text])`),
	check("l3_submissions_seal_mode_check", sql`seal_mode IS NULL OR seal_mode = ANY (ARRAY['full'::text, 'incremental'::text, 'summary'::text])`),
]);

// 批次二（ADR-0034 §2）：作答历史题中心化——一题一条历史链，管理/删除/重做
// 按题操作。只存作答事实（answer/venue/sheet/自评快照），无判定列——verdict 真源
// 归 l3_grading_results（批次三建），attempt 不写判定避免改判两处同步腐化。
// 软删（status/deleted_at）照注记先例；结果页从 attempts 按 sheet_id 派生渲染，
// attempt 行不可变，串行即天然快照；统计同源现算（软删行仍在库）。
export const l3QuestionAttempts = pgTable("l3_question_attempts", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	questionId: uuid("question_id").notNull().references(() => l3Questions.id, { onDelete: "cascade" }),
	sheetId: uuid("sheet_id").references(() => l3Submissions.id, { onDelete: "set null" }),
	venue: text("venue").notNull(),
	answer: jsonb("answer").notNull(),
	// 当场自评快照（做题时用户当场的自评，非事后判定）。
	selfAssessment: jsonb("self_assessment"),
	status: text("status").default('active').notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	index("idx_l3_question_attempts_user_question_created").on(table.userId, table.questionId, table.createdAt),
	index("idx_l3_question_attempts_sheet").on(table.sheetId),
	pgPolicy("l3_question_attempts_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_question_attempts_venue_check", sql`venue = ANY (ARRAY['file'::text, 'paper'::text])`),
	check("l3_question_attempts_status_check", sql`status = ANY (ARRAY['active'::text, 'deleted'::text])`),
]);

// 批次一（2026-09-16）：做题注记 = 原文分析条目，挂题下、一题多条。
// 锚点三元组（anchor_start/end/excerpt）同空同非空、end > start 由 CHECK 兜底；
// 同 (question_id, anchor_start, anchor_end) 的锚点幂等由服务层去重保证。
// status active/deleted 为软删标记（镜像 l3_questions 的时间戳与 RLS 风格）。
export const l3QuestionAnnotations = pgTable("l3_question_annotations", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	questionId: uuid("question_id").notNull().references(() => l3Questions.id, { onDelete: "cascade" }),
	ordinal: integer("ordinal").default(0).notNull(),
	anchorStart: integer("anchor_start"),
	anchorEnd: integer("anchor_end"),
	excerpt: text("excerpt"),
	note: text("note").default('').notNull(),
	entryTags: jsonb("entry_tags").default([]).notNull(),
	optionTags: jsonb("option_tags").default({}).notNull(),
	// 批次二（ADR-0034 §3）：stage 生命周期（draft→submitted→confirmed，存量回填
	// confirmed）与 status（软删）正交；sheet_id 草稿期挂题纸（定格升格后保留溯源）；
	// review 为 agent 检验产物（批次三写；note/锚点/原判标签不可篡改，订正归 owner）。
	stage: text("stage").default('confirmed').notNull(),
	sheetId: uuid("sheet_id").references(() => l3Submissions.id, { onDelete: "set null" }),
	review: jsonb("review"),
	status: text("status").default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	index("idx_l3_question_annotations_user_question").on(table.userId, table.questionId).where(sql`status = 'active'`),
	pgPolicy("l3_question_annotations_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_question_annotations_anchor_pair_check", sql`(anchor_start IS NULL) = (anchor_end IS NULL)`),
	check("l3_question_annotations_anchor_order_check", sql`anchor_start IS NULL OR anchor_end > anchor_start`),
	check("l3_question_annotations_excerpt_check", sql`(anchor_start IS NULL) = (excerpt IS NULL)`),
	check("l3_question_annotations_status_check", sql`status = ANY (ARRAY['active'::text, 'deleted'::text])`),
]);

// 批次一（2026-09-16）：规律标签字典（预置集 + 用户增删改，按用户隔离）。
// kind=entry 题型标签 / kind=option 错误类型标签；部分唯一索引保证活标签不重名，
// replaceTags 事务内软删旧行（status→deleted）再插新行不触发唯一冲突。
export const l3AnnotationTags = pgTable("l3_annotation_tags", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	kind: text("kind").notNull(),
	label: text("label").notNull(),
	ordinal: integer("ordinal").default(0).notNull(),
	status: text("status").default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	index("idx_l3_annotation_tags_user_kind_ordinal").on(table.userId, table.kind, table.ordinal),
	uniqueIndex("l3_annotation_tags_user_kind_label_unique").on(table.userId, table.kind, table.label).where(sql`status = 'active'`),
	pgPolicy("l3_annotation_tags_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_annotation_tags_kind_check", sql`kind = ANY (ARRAY['entry'::text, 'option'::text])`),
	check("l3_annotation_tags_status_check", sql`status = ANY (ARRAY['active'::text, 'deleted'::text])`),
]);

// 批次二增补（ADR-0034 v2 条 10/11，2026-09-17）：评析区——一题一条的 owner/agent
// 共建沉淀。latest-wins 无历史版本（last_editor + updated_at 留痕兜底）；挂题不挂
// 题纸（跨题纸、跨 venue 永存）；与总结条双轨（总结条管场次、评析区管题目）。
// agent 首个可写持久区（Amends ADR-0029，开口严格限于本区）；content_md 长度
// 由契约层收口（≤20k）。
export const l3QuestionAssessments = pgTable("l3_question_assessments", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	questionId: uuid("question_id").notNull().references(() => l3Questions.id, { onDelete: "cascade" }),
	contentMd: text("content_md").notNull(),
	lastEditor: text("last_editor").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	unique("l3_question_assessments_user_question_unique").on(table.userId, table.questionId),
	pgPolicy("l3_question_assessments_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_question_assessments_last_editor_check", sql`last_editor = ANY (ARRAY['owner'::text, 'agent'::text])`),
]);

