import { pgTable, foreignKey, unique, pgPolicy, check, uuid, text, jsonb, timestamp, index, boolean, numeric, integer, uniqueIndex, primaryKey, date, pgEnum, customType } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

// Drizzle doesn't natively support tsvector; define a custom type so the
// generated column can be typed correctly instead of falling back to `unknown`.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

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
	pgPolicy("profiles_select_own", { as: "permissive", for: "select", to: ["public"] }),
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
	foreignKey({
		columns: [table.userId],
		foreignColumns: [profiles.id],
		name: "auth_sessions_user_id_fkey"
	}).onDelete("cascade"),
	check("auth_sessions_role_check", sql`role = ANY (ARRAY['owner'::text, 'agent'::text])`),
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
	// TODO: failed to parse database type 'tsvector'
	searchVector: tsvector("search_vector").generatedAlwaysAs(sql`to_tsvector('english'::regconfig, ((((((((((COALESCE(lemma, ''::text) || ' '::text) || COALESCE(title, ''::text)) || ' '::text) || COALESCE(short_definition, ''::text)) || ' '::text) || COALESCE(definition_md, ''::text)) || ' '::text) || COALESCE((metadata ->> 'semantic_field'::text), ''::text)) || ' '::text) || COALESCE((metadata ->> 'word_freq'::text), ''::text)))`),
}, (table) => [
	index("idx_words_aliases_gin").using("gin", table.aliases.asc().nullsLast().op("array_ops")),
	index("idx_words_lemma_trgm").using("gin", table.lemma.asc().nullsLast().op("gin_trgm_ops")),
	index("idx_words_metadata_gin").using("gin", table.metadata.asc().nullsLast().op("jsonb_ops")),
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
	check("sessions_mode_check", sql`mode = ANY (ARRAY['review'::text, 'cram'::text, 'preview'::text])`),
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
}, (table) => [
	index("idx_review_logs_archive_user_reviewed").using("btree", table.userId.asc().nullsLast(), table.reviewedAt.desc().nullsFirst()),
	index("idx_review_logs_archive_wordbook").using("btree", table.wordbookId.asc().nullsLast(), table.reviewedAt.desc().nullsFirst()),
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
	foreignKey({
			columns: [table.progressId],
			foreignColumns: [userWordProgress.id],
			name: "review_logs_progress_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.progressId, table.userId, table.wordbookId],
			foreignColumns: [userWordProgress.id, userWordProgress.userId, userWordProgress.wordbookId],
			name: "review_logs_progress_scope_fkey"
		}),
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
	// ⚠️ L3 BOUNDARY — these columns are NOT the L3 context-space main model.
	// They are lightweight flags carried over from the Phase-0 self-growing draft and are
	// currently UNUSED by any business code (no service/repo/route reads or writes them).
	// The real L3 (agent self-growing knowledge chain) will live in an INDEPENDENT table
	// family (l3_sources / l3_contexts / l3_proposals) built in Phase 3 — see ADR-0005.
	// L3 does NOT participate in FSRS scheduling (ADR-0004 §6.2). Do not treat these
	// fields as the L3 source of truth; do not couple L3 logic to this L2 progress table.
	// Kept (not dropped) only to avoid migration churn; will be reconsidered when L3 lands.
	l3Pending: boolean("l3_pending").default(false),
	l3SelfAssessments: jsonb("l3_self_assessments").default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("idx_l2_progress_user_wordbook_word").on(table.userId, table.wordbookId, table.wordId),
	index("idx_l2_progress_wordbook_due").on(table.wordbookId, table.userId, table.l2DueAt).where(sql`(l2_paused = false)`),
	index("idx_l2_progress_word").on(table.wordId),
	check("l2_state_check", sql`l2_state = ANY (ARRAY['new'::text, 'learning'::text, 'review'::text, 'relearning'::text, 'suspended'::text])`),
	check("l2_retention_check", sql`l2_desired_retention >= 0.900 AND l2_desired_retention <= 0.990`),
	check("l2_paused_reason_check", sql`l2_paused_reason IS NULL OR l2_paused_reason = ANY (ARRAY['l1_cascade_failure'::text, 'wordbook_focus'::text, 'manual'::text])`),
]);

export const llmUsage = pgTable("llm_usage", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	provider: text("provider").notNull(),
	model: text("model").notNull(),
	promptTokens: integer("prompt_tokens").notNull(),
	completionTokens: integer("completion_tokens").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_llm_usage_created").on(table.createdAt),
]);

export const wordL2Content = pgTable("word_l2_content", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	wordId: uuid("word_id").notNull().references(() => words.id, { onDelete: "cascade" }),
	field: text("field").notNull(),
	content: jsonb("content").notNull(),
	source: text("source").notNull(),
	sourceRef: uuid("source_ref"),
	approvedBy: text("approved_by").default("user"),
	approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	isActive: boolean("is_active").default(true).notNull(),
}, (table) => [
	index("idx_l2_content_word_field").on(table.wordId, table.field),
	index("idx_l2_content_source").on(table.source),
]);

export const l3Sources = pgTable("l3_sources", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
	wordbookId: uuid("wordbook_id"),
	sourceType: text("source_type").notNull(),
	title: text("title").notNull(),
	author: text("author"),
	url: text("url"),
	language: text("language"),
	metadata: jsonb("metadata").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, (table) => [
	index("idx_l3_sources_user_created").on(table.userId, table.createdAt),
	unique("l3_sources_id_user_id_unique").on(table.id, table.userId),
	foreignKey({
			columns: [table.wordbookId, table.userId],
			foreignColumns: [wordbooks.id, wordbooks.userId],
			name: "l3_sources_wordbook_owner_fk"
		}).onDelete("cascade"),
	pgPolicy("l3_sources_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_sources_source_type_check", sql`source_type = ANY (ARRAY['article'::text, 'book'::text, 'video'::text, 'audio'::text, 'chat'::text, 'manual'::text, 'web'::text, 'other'::text])`),
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
	unique("l3_proposals_id_user_id_unique").on(table.id, table.userId),
	foreignKey({
			columns: [table.wordbookId, table.userId],
			foreignColumns: [wordbooks.id, wordbooks.userId],
			name: "l3_proposals_wordbook_owner_fk"
		}).onDelete("cascade"),
	pgPolicy("l3_proposals_own_all", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)`, withCheck: sql`(auth.uid() = user_id)` }),
	check("l3_proposals_source_type_check", sql`source_type = ANY (ARRAY['agent'::text, 'import'::text, 'external_tool'::text, 'manual_draft'::text, 'mcp_future'::text, 'other'::text])`),
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
