-- 0030: ADR-0019 §4 —— L3 子空间（能力域轴）落地（W2-0，T06/T07 依赖）。
--
-- 范围与语义：
--   * l3_source_spaces：source ↔ 子空间的多对多 junction。子空间为固定枚举
--     （语法 / 阅读 / 作文 / 翻译 / 通用），与 direction（考试轴，0027）正交：
--     一个 source 同时携带两轴，且可属多个子空间（CONTEXT.md「Sub-space (子空间)」）。
--   * 选型（junction 表 vs l3_sources.spaces text[]）——按仓库惯例取 junction
--     （先例 word_tags / l3_occurrences），理由：
--       1. "按子空间过滤" = (user_id, space) btree 点查，走普通 Index Scan；
--          数组列则需 GIN 且 @> 包含查询，成本模型与既有 l3_* 查询不一致。
--       2. 多值唯一性由 UNIQUE(source_id, space) 在 DB 层保证；数组列要靠应用层
--          去重或表达式索引，易形成第二真相源。
--       3. source_id 可参与复合 FK (source_id, user_id) → l3_sources(id, user_id)，
--          与 l3_occurrences/l3_contexts 一样在 DB 层防越权挂源；数组列内的
--          字符串无法参与 FK，越权挂源只能靠服务层把关。
--   * 约束/索引：
--       - UNIQUE (source_id, space)：同一 source 对同一子空间至多一条。
--         source_id 只属于一个 user（由下面复合 FK 保证），故 user_id 不入唯一键。
--       - FOREIGN KEY (source_id, user_id) → l3_sources(id, user_id) ON DELETE cascade。
--       - INDEX (user_id, space)：支撑"按子空间筛选"（T06 错题库 / T07 攻坚包取源）。
--       - RLS own_all：using/withCheck (auth.uid() = user_id)。
--
-- 幂等与回滚：CREATE TABLE/INDEX/POLICY 全部 IF [NOT] EXISTS；约束用
-- DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT；POLICY 先 DROP IF EXISTS 再建。
-- 重复执行不报错。本项目迁移策略为 forward-compatible、无自动 down
-- （见 scripts/verify-rollback-compatibility.ts）；人工回滚清单见文件末尾注释。

CREATE TABLE IF NOT EXISTS "l3_source_spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"space" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "l3_source_spaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- 多值唯一性 + 子空间枚举 CHECK（幂等重建）。
ALTER TABLE "l3_source_spaces" DROP CONSTRAINT IF EXISTS "l3_source_spaces_source_space_unique";--> statement-breakpoint
ALTER TABLE "l3_source_spaces" ADD CONSTRAINT "l3_source_spaces_source_space_unique" UNIQUE ("source_id","space");--> statement-breakpoint
ALTER TABLE "l3_source_spaces" DROP CONSTRAINT IF EXISTS "l3_source_spaces_space_check";--> statement-breakpoint
ALTER TABLE "l3_source_spaces" ADD CONSTRAINT "l3_source_spaces_space_check" CHECK (space = ANY (ARRAY['语法'::text, '阅读'::text, '作文'::text, '翻译'::text, '通用'::text]));--> statement-breakpoint

-- owner FK（profiles）+ 复合 owner FK（防越权把子空间挂到他人 source）。
ALTER TABLE "l3_source_spaces" DROP CONSTRAINT IF EXISTS "l3_source_spaces_user_id_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "l3_source_spaces" ADD CONSTRAINT "l3_source_spaces_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l3_source_spaces" DROP CONSTRAINT IF EXISTS "l3_source_spaces_source_owner_fk";--> statement-breakpoint
ALTER TABLE "l3_source_spaces" ADD CONSTRAINT "l3_source_spaces_source_owner_fk" FOREIGN KEY ("source_id","user_id") REFERENCES "public"."l3_sources"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_l3_source_spaces_user_space" ON "l3_source_spaces" USING btree ("user_id","space");--> statement-breakpoint

DROP POLICY IF EXISTS "l3_source_spaces_own_all" ON "l3_source_spaces";--> statement-breakpoint
CREATE POLICY "l3_source_spaces_own_all" ON "l3_source_spaces" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

-- ROLLBACK（人工执行；无自动 down）：
--   DROP TABLE IF EXISTS "l3_source_spaces";
-- 注意：GRANT 由 scripts/bootstrap-database-roles.ts converge 提供；回滚 schema
-- 后需重跑 converge 收敛（或手工 REVOKE 该表授权）。
