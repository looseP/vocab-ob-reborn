-- 0028: ADR-0018 / ADR-0019 —— 升级工单 + L3 慢学习会话 + L3 练习记录（T02）。
--
-- 三张新表全部 owner-scoped（user_id FK → profiles，RLS own_all）。L3 边界
-- （ADR-0004 §6 / ADR-0005）：**零 FSRS 列**（无 stability / difficulty /
-- retrievability / due），L3 不参与调度。
--
--   * l3_sessions：慢学习容器 = 服务端计划（实体引用 + version）+ 状态；
--     不存冻结渲染产物，每次现拉现渲染（ADR-0019 §2）。started_at 随创建落库
--     （对齐 sessions.started_at 的 notNull + defaultNow 语义），ended_at 由
--     结束动作写入。type 枚举含 l2_upgrade（升级工作台）/ l3_practice /
--     cram_pack（时间盒攻坚，有反复无 FSRS）/ knowledge。
--   * upgrade_work_orders：升级标记工单（ADR-0018）。部分唯一索引限定同一
--     (user_id, word_id, wordbook_id) 的进行中（标记中/升级中）工单至多一张；
--     已完成/已取消不阻塞重新标记。direction 由工单指定（ADR-0017），
--     suggestion_snapshot 存标记时刻的建议快照（纯提示、零 FSRS 写入）。
--   * l3_practice_attempts：有记录、无调度（ADR-0019 §1）。target = context
--     （句子）而非裸词；occurrence/session 为可选指针，父行删除时 set null
--     保留记录本身；context 走 (context_id, user_id) 复合 FK + cascade。
--     错题库 = outcome='wrong' 的派生视图，不建第二真相源。
--
-- 幂等与回滚：CREATE TABLE / INDEX / POLICY 全部 IF [NOT] EXISTS；POLICY 先
-- DROP IF EXISTS 再建；FK 用 DROP CONSTRAINT IF EXISTS + ADD。重复执行不报错。
-- 本项目迁移策略为 forward-compatible、无自动 down（见
-- scripts/verify-rollback-compatibility.ts）；人工回滚清单见文件末尾注释。

CREATE TABLE IF NOT EXISTS "l3_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"plan" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_sessions_type_check" CHECK (type = ANY (ARRAY['l2_upgrade'::text, 'l3_practice'::text, 'cram_pack'::text, 'knowledge'::text])),
	CONSTRAINT "l3_sessions_status_check" CHECK (status = ANY (ARRAY['active'::text, 'completed'::text, 'abandoned'::text]))
);--> statement-breakpoint
ALTER TABLE "l3_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "upgrade_work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"word_id" uuid NOT NULL,
	"wordbook_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"status" text DEFAULT '标记中' NOT NULL,
	"suggestion_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "upgrade_work_orders_direction_check" CHECK (direction = ANY (ARRAY['通用'::text, '考研'::text, '雅思'::text])),
	CONSTRAINT "upgrade_work_orders_status_check" CHECK (status = ANY (ARRAY['标记中'::text, '升级中'::text, '已完成'::text, '已取消'::text]))
);--> statement-breakpoint
ALTER TABLE "upgrade_work_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "l3_practice_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"occurrence_id" uuid,
	"session_id" uuid,
	"practice_type" text NOT NULL,
	"outcome" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l3_practice_attempts_practice_type_check" CHECK (practice_type = ANY (ARRAY['essay_dictation'::text, 'context_quiz'::text])),
	CONSTRAINT "l3_practice_attempts_outcome_check" CHECK (outcome = ANY (ARRAY['correct'::text, 'wrong'::text, 'skip'::text]))
);--> statement-breakpoint
ALTER TABLE "l3_practice_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "l3_sessions" DROP CONSTRAINT IF EXISTS "l3_sessions_user_id_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "l3_sessions" ADD CONSTRAINT "l3_sessions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upgrade_work_orders" DROP CONSTRAINT IF EXISTS "upgrade_work_orders_user_id_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "upgrade_work_orders" ADD CONSTRAINT "upgrade_work_orders_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upgrade_work_orders" DROP CONSTRAINT IF EXISTS "upgrade_work_orders_word_id_words_id_fk";--> statement-breakpoint
ALTER TABLE "upgrade_work_orders" ADD CONSTRAINT "upgrade_work_orders_word_id_words_id_fk" FOREIGN KEY ("word_id") REFERENCES "public"."words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 复合 owner FK：wordbook_id 必须属于同一 user（防越权挂书）。
ALTER TABLE "upgrade_work_orders" DROP CONSTRAINT IF EXISTS "upgrade_work_orders_wordbook_owner_fk";--> statement-breakpoint
ALTER TABLE "upgrade_work_orders" ADD CONSTRAINT "upgrade_work_orders_wordbook_owner_fk" FOREIGN KEY ("wordbook_id","user_id") REFERENCES "public"."wordbooks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_practice_attempts" DROP CONSTRAINT IF EXISTS "l3_practice_attempts_user_id_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "l3_practice_attempts" ADD CONSTRAINT "l3_practice_attempts_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_practice_attempts" DROP CONSTRAINT IF EXISTS "l3_practice_attempts_context_id_l3_contexts_id_fk";--> statement-breakpoint
ALTER TABLE "l3_practice_attempts" ADD CONSTRAINT "l3_practice_attempts_context_id_l3_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."l3_contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 复合 owner FK：context_id 必须属于同一 user（L3 owner 隔离，同 l3_occurrences 先例）。
ALTER TABLE "l3_practice_attempts" DROP CONSTRAINT IF EXISTS "l3_practice_attempts_context_owner_fk";--> statement-breakpoint
ALTER TABLE "l3_practice_attempts" ADD CONSTRAINT "l3_practice_attempts_context_owner_fk" FOREIGN KEY ("context_id","user_id") REFERENCES "public"."l3_contexts"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_practice_attempts" DROP CONSTRAINT IF EXISTS "l3_practice_attempts_occurrence_id_l3_occurrences_id_fk";--> statement-breakpoint
ALTER TABLE "l3_practice_attempts" ADD CONSTRAINT "l3_practice_attempts_occurrence_id_l3_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."l3_occurrences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_practice_attempts" DROP CONSTRAINT IF EXISTS "l3_practice_attempts_session_id_l3_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "l3_practice_attempts" ADD CONSTRAINT "l3_practice_attempts_session_id_l3_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."l3_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- 错题库派生查询主索引：(user_id, outcome='wrong', created_at)。
CREATE INDEX IF NOT EXISTS "idx_l3_practice_attempts_user_outcome_created" ON "l3_practice_attempts" USING btree ("user_id","outcome","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_upgrade_work_orders_one_active" ON "upgrade_work_orders" USING btree ("user_id","word_id","wordbook_id") WHERE status IN ('标记中', '升级中');--> statement-breakpoint

DROP POLICY IF EXISTS "l3_sessions_own_all" ON "l3_sessions";--> statement-breakpoint
CREATE POLICY "l3_sessions_own_all" ON "l3_sessions" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
DROP POLICY IF EXISTS "upgrade_work_orders_own_all" ON "upgrade_work_orders";--> statement-breakpoint
CREATE POLICY "upgrade_work_orders_own_all" ON "upgrade_work_orders" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
DROP POLICY IF EXISTS "l3_practice_attempts_own_all" ON "l3_practice_attempts";--> statement-breakpoint
CREATE POLICY "l3_practice_attempts_own_all" ON "l3_practice_attempts" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

-- ROLLBACK（人工执行；无自动 down）：
--   DROP TABLE IF EXISTS "l3_practice_attempts";
--   DROP TABLE IF EXISTS "upgrade_work_orders";
--   DROP TABLE IF EXISTS "l3_sessions";
-- 注意：0021/0023/0024 类 GRANT 由 scripts/bootstrap-database-roles.ts converge
-- 提供；回滚 schema 后需重跑 converge 收敛（或手工 REVOKE 三表授权）。
