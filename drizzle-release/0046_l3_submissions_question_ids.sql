ALTER TABLE "l3_submissions" ADD COLUMN "question_ids" uuid[];--> statement-breakpoint
ALTER TABLE "l3_submissions" ADD CONSTRAINT "l3_submissions_question_ids_check" CHECK (question_ids IS NULL OR array_length(question_ids, 1) > 0);--> statement-breakpoint
-- 题单快照存量幂等回填（2026-09-26）：已定格题纸的题单 = 该纸实际物化过的题目
-- （l3_question_attempts 是唯一作答真源——题单只能由它派生，不得由作用域现拉
--  反推：现拉会把"开纸后加的题"算进历史卷）。含 deleted 行——软删只是抹掉成绩
--  记录，不代表该题不在卷内。WHERE 只认 question_ids IS NULL，二次执行零行变化。
-- 无 attempts 的历史 draft 题纸保持 NULL（读侧回退现拉，与现状一致）。
UPDATE "l3_submissions" AS s
SET "question_ids" = agg.ids
FROM (
	SELECT a.sheet_id, array_agg(a.question_id ORDER BY a.created_at, a.id) AS ids
	FROM "l3_question_attempts" AS a
	WHERE a.sheet_id IS NOT NULL
	GROUP BY a.sheet_id
	HAVING count(*) > 0
) AS agg
WHERE s.id = agg.sheet_id
	AND s.question_ids IS NULL
	AND array_length(agg.ids, 1) > 0;