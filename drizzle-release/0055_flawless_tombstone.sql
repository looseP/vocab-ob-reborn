-- 0055：note_entries.kind（笔记系统 UX 修复，2026-10-10 设计《ux-notes-redesign》）
--
-- 卡背/详情页条目分类：内置 6 类（general/story/synonym/mnemonic/usage/issue）
-- + 用户自定义（≤12，服务层校验）。**刻意不加 CHECK 枚举**（设计 §3：扩展不锁死，
-- 与 note_entries「追加式/无状态闸门」的既有纪律同向）；'general' 为默认兜底，
-- 存量行由 DEFAULT 回填。服务端只做保留字与数量校验（schema/service 层）。
--
-- 幂等（ADR-0042 D4：idx 51 起手写 + DDL 幂等）：ADD COLUMN IF NOT EXISTS。
-- 本项目迁移策略为 forward-compatible、无自动 down；人工回滚清单见文件末尾。

ALTER TABLE "note_entries" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'general' NOT NULL;

-- ROLLBACK（人工执行；无自动 down）：
--   ALTER TABLE "note_entries" DROP COLUMN IF EXISTS "kind";
