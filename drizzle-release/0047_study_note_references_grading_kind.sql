-- N2 第四条链：学习笔记引用「评卷」（ADR-0039，2026-09-26）
--
-- 范围：**只放宽 `l3_study_note_references` 的三处 CHECK**。不新增列、不动
-- `l3_grading_results`、不动它的 UNIQUE/latest-wins 写路径（ADR-0035 决策 1/3 原样成立）。
--
-- 为什么「不加版本列」仍要迁移：D3-a 的「不加 grading_version」只覆盖版本维度，
-- 而 `kind` 枚举本身是 DB CHECK —— 新 kind 必须显式进入三处 CHECK 才可能落行：
--   1. kind_check   ：枚举加 'grading'
--   2. target_check ：grading 的目标列 = {submission_id, question_id} 必填、
--                     其余目标列（source/assessment/target_note/attempt/
--                     submission_revision_no）必须为空
--   3. quote_check  ：grading 属非 quote 型 ⇒ offset/quote_snapshot 必须为空
--
-- 身份为何是 {submission_id, question_id}：ADR-0039 决策 2。评卷是 latest-wins
-- 覆写表，「引用某一次具体评卷」不可表达（无 version 列），故身份恒指向**当前**
-- 那一格；改判后引用转 changed、旧快照原样保留（D3-2）。这两列在表里已存在
-- （sheet / question 两条链都在用），故本次**零新增列**。
--
-- 存量数据：既有行的 kind 都不在新增枚举值里，三处 CHECK 的其他分支逐条未变
-- ⇒ 本迁移对存量行**无影响**，不需要数据回填（回填一个不存在的需求才是编造）。
-- 三处 CHECK 用 DROP + ADD 重建：PostgreSQL 的 CHECK 无 ALTER 扩展语法。

ALTER TABLE "l3_study_note_references" DROP CONSTRAINT IF EXISTS "l3_study_note_references_kind_check";--> statement-breakpoint
ALTER TABLE "l3_study_note_references" DROP CONSTRAINT IF EXISTS "l3_study_note_references_target_check";--> statement-breakpoint
ALTER TABLE "l3_study_note_references" DROP CONSTRAINT IF EXISTS "l3_study_note_references_quote_check";--> statement-breakpoint
ALTER TABLE "l3_study_note_references" ADD CONSTRAINT "l3_study_note_references_kind_check" CHECK (kind = ANY (ARRAY['source'::text, 'source_quote'::text, 'question'::text, 'stem_quote'::text, 'option_quote'::text, 'assessment'::text, 'note'::text, 'sheet'::text, 'attempt'::text, 'grading'::text]));--> statement-breakpoint
ALTER TABLE "l3_study_note_references" ADD CONSTRAINT "l3_study_note_references_target_check" CHECK ((kind = ANY (ARRAY['source'::text, 'source_quote'::text]) AND source_id IS NOT NULL AND question_id IS NULL AND assessment_id IS NULL AND target_note_id IS NULL AND submission_id IS NULL AND attempt_id IS NULL) OR (kind = ANY (ARRAY['question'::text, 'stem_quote'::text, 'option_quote'::text]) AND question_id IS NOT NULL AND source_id IS NULL AND assessment_id IS NULL AND target_note_id IS NULL AND submission_id IS NULL AND attempt_id IS NULL) OR (kind = 'assessment'::text AND question_id IS NOT NULL AND assessment_id IS NOT NULL AND source_id IS NULL AND target_note_id IS NULL AND submission_id IS NULL AND attempt_id IS NULL) OR (kind = 'note'::text AND target_note_id IS NOT NULL AND source_id IS NULL AND question_id IS NULL AND assessment_id IS NULL AND submission_id IS NULL AND attempt_id IS NULL) OR (kind = 'sheet'::text AND submission_id IS NOT NULL AND source_id IS NULL AND question_id IS NULL AND assessment_id IS NULL AND target_note_id IS NULL AND attempt_id IS NULL) OR (kind = 'attempt'::text AND attempt_id IS NOT NULL AND source_id IS NULL AND question_id IS NULL AND assessment_id IS NULL AND target_note_id IS NULL AND submission_id IS NULL) OR (kind = 'grading'::text AND submission_id IS NOT NULL AND question_id IS NOT NULL AND source_id IS NULL AND assessment_id IS NULL AND target_note_id IS NULL AND submission_revision_no IS NULL AND attempt_id IS NULL));--> statement-breakpoint
ALTER TABLE "l3_study_note_references" ADD CONSTRAINT "l3_study_note_references_quote_check" CHECK ((kind = ANY (ARRAY['source_quote'::text, 'stem_quote'::text, 'option_quote'::text]) AND start_offset IS NOT NULL AND end_offset IS NOT NULL AND quote_snapshot IS NOT NULL) OR (kind = ANY (ARRAY['source'::text, 'question'::text, 'assessment'::text, 'note'::text, 'sheet'::text, 'attempt'::text, 'grading'::text]) AND start_offset IS NULL AND end_offset IS NULL AND quote_snapshot IS NULL));
