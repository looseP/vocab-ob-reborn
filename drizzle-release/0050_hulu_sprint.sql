-- 0050: ADR-0041 —— 葫芦冲刺计划容器（hulu_plans / hulu_rounds）。
--
-- L1 词书上的阶段性多轮冲刺计划：整批词按页推进、页级检索闸门、多轮滚动、只记
-- 轮次耗时。**只新增两张表，不改任何已有表**；不进 sessions（其 mode 枚举只认
-- review/cram/preview/l2_drill，且 idx_sessions_one_active 的「坐次」语义与
-- 「跨周计划」粒度错位）、不进 l3_sessions（它的类型枚举与抽样对象是 context，
-- 不是词）。回退 = DROP TABLE hulu_rounds, hulu_plans;（无数据搬迁）。
--
--   * hulu_plans：计划头。word_ids uuid[] 是创建时定格的**整本词书**词集
--     （direction 仅标签、不过滤词集 —— words / wordbooks 都没有 direction 列）；
--     gate_ratio 存列值，页闸门判定读本列、不写死 0.8；suspend_review 默认 false
--     是有意的（唯一会碰到 user_word_progress 的路径，可选且默认关）；
--     suspend_snapshot 存 {wordId: 挂起前 state}，恢复 = 逐行回写（不统一恢复成
--     'review' —— 那会让 new/learning/relearning 的行伪装成 review 态）。
--     复合 FK (wordbook_id, user_id) → wordbooks(id, user_id) 防越权挂书
--     （照 sessions_wordbook_owner_fkey 先例）；UNIQUE (id, user_id) 供子表复合 FK。
--     部分唯一索引 idx_hulu_plans_one_active：同 (user, wordbook) 至多一个 active
--     计划，并发双创建由它兜底（服务层撞索引后重查返回既有计划 = 幂等语义）。
--   * hulu_rounds：轮次。ended_at IS NULL = 进行中，「全计划至多一个未收尾轮」由
--     服务层在事务内保证（SELECT ... FOR UPDATE 计划行后判断），**不另建部分唯一
--     索引**；pages_passed 即页游标（页结算 = 单条条件 UPDATE ... WHERE
--     pages_passed = $pageIndex，原子且并发安全，不需要页级明细表）；
--     elapsed_seconds 是墙钟 ended_at - started_at（中断不切开），服务端夹取到
--     [0, 604800]（7 天）。
--
-- 零 FSRS 写入是**结构性**的：两表无 stability / difficulty / retrievability /
-- due 列；CHECK elapsed_seconds <= 604800 与 domain 常量
-- HULU_MAX_SINGLE_ROUND_SECONDS 同值。
--
-- 幂等与回滚：CREATE TABLE / INDEX 全部 IF [NOT] EXISTS；POLICY 先 DROP IF EXISTS
-- 再建；FK 用 DROP CONSTRAINT IF EXISTS + ADD。重复执行不报错。本项目迁移策略为
-- forward-compatible、无自动 down（见 scripts/verify-rollback-compatibility.ts）；
-- 人工回滚清单见文件末尾注释。

CREATE TABLE IF NOT EXISTS "hulu_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wordbook_id" uuid NOT NULL,
	"direction" text,
	"exam_date" date NOT NULL,
	"target_rounds" smallint DEFAULT 4 NOT NULL,
	"page_size" smallint DEFAULT 20 NOT NULL,
	"gate_ratio" numeric(3, 2) DEFAULT '0.80' NOT NULL,
	"word_ids" uuid[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"suspend_review" boolean DEFAULT false NOT NULL,
	"suspend_snapshot" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hulu_plans_id_user_unique" UNIQUE("id","user_id"),
	CONSTRAINT "hulu_plans_direction_check" CHECK (direction IS NULL OR direction = ANY (ARRAY['通用'::text, '考研'::text, '雅思'::text])),
	CONSTRAINT "hulu_plans_target_rounds_check" CHECK (target_rounds >= 2 AND target_rounds <= 8),
	CONSTRAINT "hulu_plans_page_size_check" CHECK (page_size >= 5 AND page_size <= 50),
	CONSTRAINT "hulu_plans_gate_ratio_check" CHECK (gate_ratio >= 0.50 AND gate_ratio <= 1.00),
	CONSTRAINT "hulu_plans_word_ids_check" CHECK (cardinality(word_ids) >= 1 AND cardinality(word_ids) <= 20000),
	CONSTRAINT "hulu_plans_status_check" CHECK (status = ANY (ARRAY['active'::text, 'completed'::text, 'abandoned'::text]))
);--> statement-breakpoint
ALTER TABLE "hulu_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hulu_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"round_no" smallint NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"elapsed_seconds" integer,
	"pages_passed" smallint DEFAULT 0 NOT NULL,
	"words_passed" integer DEFAULT 0 NOT NULL,
	"words_total" integer NOT NULL,
	CONSTRAINT "hulu_rounds_plan_round_unique" UNIQUE("plan_id","round_no"),
	CONSTRAINT "hulu_rounds_round_no_check" CHECK (round_no >= 1 AND round_no <= 8),
	CONSTRAINT "hulu_rounds_elapsed_seconds_check" CHECK (elapsed_seconds IS NULL OR (elapsed_seconds >= 0 AND elapsed_seconds <= 604800)),
	CONSTRAINT "hulu_rounds_pages_passed_check" CHECK (pages_passed >= 0),
	CONSTRAINT "hulu_rounds_words_passed_check" CHECK (words_passed >= 0),
	CONSTRAINT "hulu_rounds_words_total_check" CHECK (words_total >= 0)
);--> statement-breakpoint
ALTER TABLE "hulu_rounds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "hulu_plans" DROP CONSTRAINT IF EXISTS "hulu_plans_user_id_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "hulu_plans" ADD CONSTRAINT "hulu_plans_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 复合 owner FK：wordbook_id 必须属于同一 user（防越权挂书，照 sessions 先例）。
ALTER TABLE "hulu_plans" DROP CONSTRAINT IF EXISTS "hulu_plans_wordbook_owner_fkey";--> statement-breakpoint
ALTER TABLE "hulu_plans" ADD CONSTRAINT "hulu_plans_wordbook_owner_fkey" FOREIGN KEY ("wordbook_id","user_id") REFERENCES "public"."wordbooks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hulu_rounds" DROP CONSTRAINT IF EXISTS "hulu_rounds_user_id_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "hulu_rounds" ADD CONSTRAINT "hulu_rounds_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 复合 owner FK：轮次必须属于同一 user 的计划（跨用户挂计划在结构上不可能）。
ALTER TABLE "hulu_rounds" DROP CONSTRAINT IF EXISTS "hulu_rounds_plan_owner_fkey";--> statement-breakpoint
ALTER TABLE "hulu_rounds" ADD CONSTRAINT "hulu_rounds_plan_owner_fkey" FOREIGN KEY ("plan_id","user_id") REFERENCES "public"."hulu_plans"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hulu_plans_user" ON "hulu_plans" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_hulu_plans_one_active" ON "hulu_plans" USING btree ("user_id","wordbook_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hulu_rounds_plan" ON "hulu_rounds" USING btree ("plan_id");--> statement-breakpoint

DROP POLICY IF EXISTS "hulu_plans_own_all" ON "hulu_plans";--> statement-breakpoint
CREATE POLICY "hulu_plans_own_all" ON "hulu_plans" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
DROP POLICY IF EXISTS "hulu_rounds_own_all" ON "hulu_rounds";--> statement-breakpoint
CREATE POLICY "hulu_rounds_own_all" ON "hulu_rounds" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint

-- 四权齐备：计划与轮次都在应用内增/改/删（放弃计划、删词书级联）+ 读。
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "hulu_plans" TO "vocab_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "hulu_rounds" TO "vocab_app";

-- ROLLBACK（人工执行；无自动 down）：
--   DROP TABLE IF EXISTS "hulu_rounds";
--   DROP TABLE IF EXISTS "hulu_plans";
-- 注意：GRANT 由本文件与 scripts/bootstrap-database-roles.ts converge 双处提供；
-- 回滚 schema 后需重跑 converge 收敛（或手工 REVOKE 两表授权）。
