-- 0054：每日捕获（Daily Capture，2026-10-10 M1 捕获侧）—— 两张新表。
--
-- 轻阻力流水：学到用到先记录 → 回顾复盘 → agent 提案吸收（proposal-only）。
-- 两张新表、**不改任何已有表**；条目是唯一真相（追加式 + hidden_at 软删），
-- 「一天一文件」是 (entry_date, seq) 确定性投影。零 FSRS 写入是结构性的：
-- 两表无 stability/difficulty/due 列；流水期不写 L3 —— 吸收（用户采纳，M3）
-- 才把例句/词组单向晋升进 l3_* 表。
--
--   * daily_capture_types：类型注册表（可配置），PK (user_id, type_key)，
--     seed 六类由服务层首条追加时幂等落库（ON CONFLICT DO NOTHING）；
--   * daily_capture_entries：流水条目，(user_id, entry_date, seq) 唯一，
--     seq 由 INSERT..SELECT coalesce(max,0)+1 单语句原子分配；
--     entry_type 是对注册表的**软引用**（无 FK，追加零阻力，服务层校验存在性）；
--     meta jsonb 存类型轻字段（meaning/translation/sourceUrl/obsidianRef/wordSlugs，
--     词为软引用 ⤳ [[slug]]，吸收时才解析）。
--
-- 权限模型同 hulu/note_entries（owner 私人数据）：RLS own_all（USING/WITH CHECK
-- = auth.uid() = user_id）；GRANT 由 bootstrap-database-roles.ts converge 提供
-- （0025/0050 先例——新表授权由 converge 收敛，本文件不写 GRANT）。
--
-- 幂等（ADR-0042 D4：idx 51 起手写 + DDL 幂等）：CREATE TABLE IF NOT EXISTS；
-- INDEX IF NOT EXISTS；CONSTRAINT/POLICY 先 DROP IF EXISTS 再建（PG17 无
-- CREATE POLICY IF NOT EXISTS，0025/0052 同款可移植形式）。重复执行不报错。
-- 本项目迁移策略为 forward-compatible、无自动 down；人工回滚清单见文件末尾。

CREATE TABLE IF NOT EXISTS "daily_capture_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"seq" integer NOT NULL,
	"entry_type" text NOT NULL,
	"content" text NOT NULL,
	"meta" jsonb,
	"status" text DEFAULT 'raw' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_at" timestamp with time zone,
	CONSTRAINT "daily_capture_entries_day_seq_unique" UNIQUE("user_id","entry_date","seq"),
	CONSTRAINT "daily_capture_entries_status_check" CHECK (status = ANY (ARRAY['raw'::text, 'reviewed'::text, 'absorbed'::text, 'archived'::text])),
	CONSTRAINT "daily_capture_entries_seq_check" CHECK (seq >= 1)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_capture_types" (
	"user_id" uuid NOT NULL,
	"type_key" text NOT NULL,
	"label" text NOT NULL,
	"absorption_hint" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_capture_types_user_id_type_key_pk" PRIMARY KEY("user_id","type_key"),
	CONSTRAINT "daily_capture_types_sort_check" CHECK (sort >= 0)
);--> statement-breakpoint
ALTER TABLE "daily_capture_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "daily_capture_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "daily_capture_entries" DROP CONSTRAINT IF EXISTS "daily_capture_entries_user_id_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "daily_capture_entries" ADD CONSTRAINT "daily_capture_entries_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_capture_types" DROP CONSTRAINT IF EXISTS "daily_capture_types_user_id_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "daily_capture_types" ADD CONSTRAINT "daily_capture_types_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_daily_capture_entries_user_date" ON "daily_capture_entries" USING btree ("user_id","entry_date" DESC NULLS FIRST,"seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_daily_capture_types_user" ON "daily_capture_types" USING btree ("user_id","sort");--> statement-breakpoint

DROP POLICY IF EXISTS "daily_capture_entries_own_all" ON "daily_capture_entries";--> statement-breakpoint
CREATE POLICY "daily_capture_entries_own_all" ON "daily_capture_entries" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
DROP POLICY IF EXISTS "daily_capture_types_own_all" ON "daily_capture_types";--> statement-breakpoint
CREATE POLICY "daily_capture_types_own_all" ON "daily_capture_types" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

-- ROLLBACK（人工执行；无自动 down）：
--   DROP TABLE IF EXISTS "daily_capture_entries";
--   DROP TABLE IF EXISTS "daily_capture_types";
-- 注意：新表授权由 scripts/bootstrap-database-roles.ts converge 收敛；回滚 schema
-- 后需重跑 converge（或手工 REVOKE）。
