ALTER TABLE "user_word_progress" ADD COLUMN "ladder_rung" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_word_progress" ADD CONSTRAINT "user_word_progress_ladder_rung_check" CHECK (ladder_rung BETWEEN 1 AND 3);--> statement-breakpoint
-- 阶梯起步档存量幂等回填（ADR-0036 决策 1，f(S,rv) 与 deriveLadderRung 逐分支一致）：
-- rv=0 → 1；S≥21 → 3；7≤S<21 → 2；其余 → 1。WHERE 与派生值逐分支对齐，二次执行零行变化。
UPDATE "user_word_progress" SET "ladder_rung" = CASE
	WHEN "review_count" = 0 THEN 1
	WHEN "stability" IS NOT NULL AND "stability" >= 21 THEN 3
	WHEN "stability" IS NOT NULL AND "stability" >= 7 THEN 2
	ELSE 1
END
WHERE ("review_count" = 0 AND "ladder_rung" <> 1)
	OR ("review_count" > 0 AND (
		("stability" IS NOT NULL AND "stability" >= 21 AND "ladder_rung" <> 3)
		OR ("stability" IS NOT NULL AND "stability" >= 7 AND "stability" < 21 AND "ladder_rung" <> 2)
		OR (("stability" IS NULL OR "stability" < 7) AND "ladder_rung" <> 1)
	));
