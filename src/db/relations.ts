import { relations } from "drizzle-orm/relations";
import { users, profiles, userWordProgress, words, wordbooks, notes, sessions, noteRevisions, importRuns, importErrors, reviewLogsArchive, reviewLogs, wordHighlights, wordAnnotations, wordTags, tags, wordbookItems, dailyForecastSnapshots } from "./schema";

export const profilesRelations = relations(profiles, ({one, many}) => ({
	users: one(users, {
		fields: [profiles.id],
		references: [users.id]
	}),
	userWordProgresses: many(userWordProgress),
	notes: many(notes),
	sessions: many(sessions),
	noteRevisions: many(noteRevisions),
	wordbooks: many(wordbooks),
	reviewLogs: many(reviewLogs),
	wordHighlights: many(wordHighlights),
	wordAnnotations: many(wordAnnotations),
}));

export const usersRelations = relations(users, ({many}) => ({
	profiles: many(profiles),
	dailyForecastSnapshots: many(dailyForecastSnapshots),
}));

export const userWordProgressRelations = relations(userWordProgress, ({one, many}) => ({
	profile: one(profiles, {
		fields: [userWordProgress.userId],
		references: [profiles.id]
	}),
	word: one(words, {
		fields: [userWordProgress.wordId],
		references: [words.id]
	}),
	wordbook: one(wordbooks, {
		fields: [userWordProgress.wordbookId],
		references: [wordbooks.id]
	}),
	reviewLogs: many(reviewLogs),
}));

export const wordsRelations = relations(words, ({many}) => ({
	userWordProgresses: many(userWordProgress),
	notes: many(notes),
	noteRevisions: many(noteRevisions),
	reviewLogs: many(reviewLogs),
	wordHighlights: many(wordHighlights),
	wordAnnotations: many(wordAnnotations),
	wordTags: many(wordTags),
	wordbookItems: many(wordbookItems),
}));

export const wordbooksRelations = relations(wordbooks, ({one, many}) => ({
	userWordProgresses: many(userWordProgress),
	notes: many(notes),
	sessions: many(sessions),
	noteRevisions: many(noteRevisions),
	profile: one(profiles, {
		fields: [wordbooks.userId],
		references: [profiles.id]
	}),
	reviewLogsArchives: many(reviewLogsArchive),
	reviewLogs: many(reviewLogs),
	wordHighlights: many(wordHighlights),
	wordAnnotations: many(wordAnnotations),
	wordbookItems: many(wordbookItems),
}));

export const notesRelations = relations(notes, ({one, many}) => ({
	profile: one(profiles, {
		fields: [notes.userId],
		references: [profiles.id]
	}),
	word: one(words, {
		fields: [notes.wordId],
		references: [words.id]
	}),
	wordbook: one(wordbooks, {
		fields: [notes.wordbookId],
		references: [wordbooks.id]
	}),
	noteRevisions: many(noteRevisions),
}));

export const sessionsRelations = relations(sessions, ({one, many}) => ({
	profile: one(profiles, {
		fields: [sessions.userId],
		references: [profiles.id]
	}),
	wordbook: one(wordbooks, {
		fields: [sessions.wordbookId],
		references: [wordbooks.id]
	}),
	reviewLogs: many(reviewLogs),
}));

export const noteRevisionsRelations = relations(noteRevisions, ({one}) => ({
	note: one(notes, {
		fields: [noteRevisions.noteId],
		references: [notes.id]
	}),
	profile: one(profiles, {
		fields: [noteRevisions.userId],
		references: [profiles.id]
	}),
	word: one(words, {
		fields: [noteRevisions.wordId],
		references: [words.id]
	}),
	wordbook: one(wordbooks, {
		fields: [noteRevisions.wordbookId],
		references: [wordbooks.id]
	}),
}));

export const importErrorsRelations = relations(importErrors, ({one}) => ({
	importRun: one(importRuns, {
		fields: [importErrors.runId],
		references: [importRuns.id]
	}),
}));

export const importRunsRelations = relations(importRuns, ({many}) => ({
	importErrors: many(importErrors),
}));

export const reviewLogsArchiveRelations = relations(reviewLogsArchive, ({one}) => ({
	wordbook: one(wordbooks, {
		fields: [reviewLogsArchive.wordbookId],
		references: [wordbooks.id]
	}),
}));

export const reviewLogsRelations = relations(reviewLogs, ({one}) => ({
	profile: one(profiles, {
		fields: [reviewLogs.userId],
		references: [profiles.id]
	}),
	word: one(words, {
		fields: [reviewLogs.wordId],
		references: [words.id]
	}),
	session: one(sessions, {
		fields: [reviewLogs.sessionId],
		references: [sessions.id]
	}),
	userWordProgress: one(userWordProgress, {
		fields: [reviewLogs.progressId],
		references: [userWordProgress.id]
	}),
	wordbook: one(wordbooks, {
		fields: [reviewLogs.wordbookId],
		references: [wordbooks.id]
	}),
}));

export const wordHighlightsRelations = relations(wordHighlights, ({one}) => ({
	profile: one(profiles, {
		fields: [wordHighlights.userId],
		references: [profiles.id]
	}),
	word: one(words, {
		fields: [wordHighlights.wordId],
		references: [words.id]
	}),
	wordbook: one(wordbooks, {
		fields: [wordHighlights.wordbookId],
		references: [wordbooks.id]
	}),
}));

export const wordAnnotationsRelations = relations(wordAnnotations, ({one}) => ({
	profile: one(profiles, {
		fields: [wordAnnotations.userId],
		references: [profiles.id]
	}),
	word: one(words, {
		fields: [wordAnnotations.wordId],
		references: [words.id]
	}),
	wordbook: one(wordbooks, {
		fields: [wordAnnotations.wordbookId],
		references: [wordbooks.id]
	}),
}));

export const wordTagsRelations = relations(wordTags, ({one}) => ({
	word: one(words, {
		fields: [wordTags.wordId],
		references: [words.id]
	}),
	tag: one(tags, {
		fields: [wordTags.tagId],
		references: [tags.id]
	}),
}));

export const tagsRelations = relations(tags, ({many}) => ({
	wordTags: many(wordTags),
}));

export const wordbookItemsRelations = relations(wordbookItems, ({one}) => ({
	wordbook: one(wordbooks, {
		fields: [wordbookItems.wordbookId],
		references: [wordbooks.id]
	}),
	word: one(words, {
		fields: [wordbookItems.wordId],
		references: [words.id]
	}),
}));

export const dailyForecastSnapshotsRelations = relations(dailyForecastSnapshots, ({one}) => ({
	users: one(users, {
		fields: [dailyForecastSnapshots.userId],
		references: [users.id]
	}),
}));