-- 0052（P1-C 词根词缀深化）：词根词典 root_lexicon —— 核心义 + 变体族。
--
-- 广场的**自生长聚合**仍从 words.metadata->>'morphology_root' 实时推导（不改），
-- 本表只为展示增强补两类信息（未命中时展示降级为现样）：
--   * meaning_zh：词根核心义（家族页语义锚，如 par = 相等；使相等）；
--   * variants：同族变体 token（port/porti、spect/spic —— 词源音变合并，
--     家族页可跨族跳转；变体计数合并视图留后续波次，本轮不动 slug/缓存键语义）。
--
-- 权限模型同 tags（全局共享只读数据）：RLS public read（USING true）；
-- vocab_app 仅 SELECT（GRANT 由本文件与 scripts/bootstrap-database-roles.ts
-- converge 双处提供，照 0050 先例）。写入路径仅 seed 脚本
-- （scripts/seed-root-lexicon.ts，以 migration 角色执行，ON CONFLICT upsert）。
--
-- 幂等（ADR-0042 D4：idx 51 起手写 + DDL 幂等）：CREATE TABLE IF NOT EXISTS；
-- POLICY 先 DROP IF EXISTS 再建（PG17 无 CREATE POLICY IF NOT EXISTS，0025
-- 同款可移植形式）。重复执行不报错。本项目迁移策略为 forward-compatible、
-- 无自动 down（见 scripts/verify-rollback-compatibility.ts）；人工回滚清单见
-- 文件末尾注释。

CREATE TABLE IF NOT EXISTS "root_lexicon" (
	"token" text PRIMARY KEY NOT NULL,
	"meaning_zh" text NOT NULL,
	"variants" text[] DEFAULT '{}' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "root_lexicon" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "root_lexicon_public_read" ON "root_lexicon";--> statement-breakpoint
CREATE POLICY "root_lexicon_public_read" ON "root_lexicon" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint

-- 全局词典数据只读（vocab_app 无写路径；写入走 migration 角色的 seed 脚本）。
GRANT SELECT ON TABLE "root_lexicon" TO "vocab_app";

-- ROLLBACK（人工执行；无自动 down）：
--   DROP TABLE IF EXISTS "root_lexicon";
-- 注意：GRANT 由本文件与 scripts/bootstrap-database-roles.ts converge 双处提供；
-- 回滚 schema 后需重跑 converge 收敛（或手工 REVOKE 该表授权）。
