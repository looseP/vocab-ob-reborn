-- 0031: ADR-0029 §7①/② —— l3_proposals 幂等收口 + source_type 枚举收敛（两件事一次清账）。
--
-- 范围与语义：
--   * partial unique index (user_id, input_hash) WHERE input_hash IS NOT NULL：
--     proposal 幂等的 DB 层兜底。应用层查重已落 l3-proposal.service.ts（复刻
--     l3-import 的「入口查重 → 建 → 竞态 23505 回读」范式），本索引保证并发
--     双写时后者撞 23505 → 回读既有行，不再产生重复 pending 提案。
--     对齐 0006 的 l3_import_jobs 同名范式（idx_l3_import_jobs_user_input_hash）。
--   * 重建 l3_proposals_source_type_check：去掉 'mcp_future'。该枚举值属
--     ADR-0029 §4 文档级弃用（MCP 边界未开，DB 先收敛）；HTTP 契约层枚举
--     保持原样（请求仍可送入，由 service requireEnum 拒 400），留待未来
--     契约窗口再收。
--   * 存量风险：若历史数据已有同 (user_id, input_hash) 重复行，建唯一索引会
--     响亮失败（unique violation）。排查（迁移不自动删数据）：
--       SELECT user_id, input_hash, count(*) FROM l3_proposals
--       WHERE input_hash IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
--     单机单 owner、L3 未投产，本地 dev 已验证 0 重复。
--
-- 幂等与回滚：CREATE INDEX IF NOT EXISTS / DROP CONSTRAINT IF EXISTS +
-- ADD CONSTRAINT，重复执行不报错。本项目迁移策略为 forward-compatible、
-- 无自动 down（见 scripts/verify-rollback-compatibility.ts）。

CREATE UNIQUE INDEX IF NOT EXISTS "idx_l3_proposals_user_input_hash" ON "l3_proposals" USING btree ("user_id","input_hash") WHERE input_hash IS NOT NULL;--> statement-breakpoint

ALTER TABLE "l3_proposals" DROP CONSTRAINT IF EXISTS "l3_proposals_source_type_check";--> statement-breakpoint
ALTER TABLE "l3_proposals" ADD CONSTRAINT "l3_proposals_source_type_check" CHECK (source_type = ANY (ARRAY['agent'::text, 'import'::text, 'external_tool'::text, 'manual_draft'::text, 'other'::text]));

-- ROLLBACK（人工执行；无自动 down）：
--   DROP INDEX IF EXISTS "idx_l3_proposals_user_input_hash";
--   ALTER TABLE "l3_proposals" DROP CONSTRAINT "l3_proposals_source_type_check";
--   ALTER TABLE "l3_proposals" ADD CONSTRAINT "l3_proposals_source_type_check" CHECK (source_type = ANY (ARRAY['agent'::text, 'import'::text, 'external_tool'::text, 'manual_draft'::text, 'mcp_future'::text, 'other'::text]));
-- 注意：回滚 CHECK 前需确认无 source_type='mcp_future' 以外的新值语义依赖；
-- 已按新 CHECK 写入的行回滚后仍满足旧 CHECK（子集关系），无需数据修复。
