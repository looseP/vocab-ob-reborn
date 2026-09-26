-- N2 第五条链：学习笔记引用「写作任务」与「评阅」（ADR-0040，2026-09-26）
--
-- 范围：`l3_study_note_references` 加一列 + 放宽三处 CHECK + 一个 FK + 一个索引。
-- writingSheet 不新增 kind（复用 sheet，D1-1/D1-2 已裁决）——所以本迁移只为两个新 kind 服务：
--   1. writing_task   ：任务 id 存**独立列** `writing_task_id`。无既有列可复用：
--      `target_note_id` 背着指向 `l3_study_notes` 的 RESTRICT FK，借来装 task id 会
--      污染删除 blocker 语义（ADR-0040 决策 5）。
--   2. writing_feedback：身份即 sheetId，**复用** `submission_id`（沿 grading 先例：
--      能复用就不新增列；一纸一行，无版本维度）。
--   3. kind_check 加两值；target_check 既有七分支各补 `writing_task_id IS NULL`
--      （「恰一」互斥，新行旧约束都认），另加两分支；quote_check 非 quote 数组加两值。
--   4. FK `writing_task_owner_fk`（RESTRICT 结构兜底；任务只归档不硬删，应用层无
--      task blocker —— sheet 同款纪律）+ 索引 `idx_..._user_writing_task`。
--
-- D1-a 落地（只允许 sealed）：**不在本迁移表达** —— status 过滤在装载 SQL 里
-- （`loadTargets` 的 sealed 谓词），CHECK 只管「形状恰一」，不管「状态合法」。
-- 把状态写进 CHECK 会让「归档任务」整行非法，而已存引用必须可解析（note 先例）。

ALTER TABLE "l3_study_note_references" DROP CONSTRAINT IF EXISTS "l3_study_note_references_kind_check";--> statement-breakpoint
ALTER TABLE "l3_study_note_references" DROP CONSTRAINT IF EXISTS "l3_study_note_references_target_check";--> statement-breakpoint
ALTER TABLE "l3_study_note_references" DROP CONSTRAINT IF EXISTS "l3_study_note_references_quote_check";--> statement-breakpoint
ALTER TABLE "l3_study_note_references" ADD COLUMN "writing_task_id" uuid;--> statement-breakpoint
ALTER TABLE "l3_study_note_references" ADD CONSTRAINT "l3_study_note_references_writing_task_owner_fk" FOREIGN KEY ("writing_task_id","user_id") REFERENCES "public"."l3_writing_tasks"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_l3_study_note_references_user_writing_task" ON "l3_study_note_references" USING btree ("user_id","writing_task_id","note_id");--> statement-breakpoint
ALTER TABLE "l3_study_note_references" ADD CONSTRAINT "l3_study_note_references_kind_check" CHECK (kind = ANY (ARRAY['source'::text, 'source_quote'::text, 'question'::text, 'stem_quote'::text, 'option_quote'::text, 'assessment'::text, 'note'::text, 'sheet'::text, 'attempt'::text, 'grading'::text, 'writing_task'::text, 'writing_feedback'::text]));--> statement-breakpoint
ALTER TABLE "l3_study_note_references" ADD CONSTRAINT "l3_study_note_references_target_check" CHECK ((kind = ANY (ARRAY['source'::text, 'source_quote'::text]) AND source_id IS NOT NULL AND question_id IS NULL AND assessment_id IS NULL AND target_note_id IS NULL AND submission_id IS NULL AND attempt_id IS NULL AND writing_task_id IS NULL) OR (kind = ANY (ARRAY['question'::text, 'stem_quote'::text, 'option_quote'::text]) AND question_id IS NOT NULL AND source_id IS NULL AND assessment_id IS NULL AND target_note_id IS NULL AND submission_id IS NULL AND attempt_id IS NULL AND writing_task_id IS NULL) OR (kind = 'assessment'::text AND question_id IS NOT NULL AND assessment_id IS NOT NULL AND source_id IS NULL AND target_note_id IS NULL AND submission_id IS NULL AND attempt_id IS NULL AND writing_task_id IS NULL) OR (kind = 'note'::text AND target_note_id IS NOT NULL AND source_id IS NULL AND question_id IS NULL AND assessment_id IS NULL AND submission_id IS NULL AND attempt_id IS NULL AND writing_task_id IS NULL) OR (kind = 'sheet'::text AND submission_id IS NOT NULL AND source_id IS NULL AND question_id IS NULL AND assessment_id IS NULL AND target_note_id IS NULL AND attempt_id IS NULL AND writing_task_id IS NULL) OR (kind = 'attempt'::text AND attempt_id IS NOT NULL AND source_id IS NULL AND question_id IS NULL AND assessment_id IS NULL AND target_note_id IS NULL AND submission_id IS NULL AND writing_task_id IS NULL) OR (kind = 'grading'::text AND submission_id IS NOT NULL AND question_id IS NOT NULL AND source_id IS NULL AND assessment_id IS NULL AND target_note_id IS NULL AND submission_revision_no IS NULL AND attempt_id IS NULL AND writing_task_id IS NULL) OR (kind = 'writing_task'::text AND writing_task_id IS NOT NULL AND source_id IS NULL AND question_id IS NULL AND assessment_id IS NULL AND target_note_id IS NULL AND submission_id IS NULL AND attempt_id IS NULL) OR (kind = 'writing_feedback'::text AND submission_id IS NOT NULL AND source_id IS NULL AND question_id IS NULL AND assessment_id IS NULL AND target_note_id IS NULL AND submission_revision_no IS NULL AND attempt_id IS NULL AND writing_task_id IS NULL));--> statement-breakpoint
ALTER TABLE "l3_study_note_references" ADD CONSTRAINT "l3_study_note_references_quote_check" CHECK ((kind = ANY (ARRAY['source_quote'::text, 'stem_quote'::text, 'option_quote'::text]) AND start_offset IS NOT NULL AND end_offset IS NOT NULL AND quote_snapshot IS NOT NULL) OR (kind = ANY (ARRAY['source'::text, 'question'::text, 'assessment'::text, 'note'::text, 'sheet'::text, 'attempt'::text, 'grading'::text, 'writing_task'::text, 'writing_feedback'::text]) AND start_offset IS NULL AND end_offset IS NULL AND quote_snapshot IS NULL));
