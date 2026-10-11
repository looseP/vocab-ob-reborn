-- 0056：daily_capture_entries.absorption（每日捕获 M3 吸收回执，2026-10-10 §9）。
--
-- M1 建表（0054）只落捕获面；M3 的采纳动作需要留痕字段，否则响应契约与
-- appendAbsorption 都指向一个不存在的列（真环境复测抓到：POST /entries 在
-- 响应序列化处炸「absorption expected array, received undefined」）。
--
-- absorption 是 jsonb 数组，元素 = {action, target, id, at, word_slug, deduped?}
-- （domain/daily-capture.ts 的 DailyCaptureAbsorptionReceipt）。仓储层用
-- `COALESCE(absorption, '[]'::jsonb) || $n::jsonb` 追加，既有回执不丢；
-- NULL = 尚未吸收（响应契约 `.nullable()`，`.strict()` 要求键恒存在）。
--
-- 为什么不改 0054：迁移链线性追加（ADR-0042 D1），已应用的 0054 不会被重放
-- ——增量库只看到 idx > 已应用上限的迁移；补列必须新开一条。
--
-- 幂等（ADR-0042 D4：idx 51 起手写 + DDL 幂等）：ADD COLUMN IF NOT EXISTS。
-- 本项目迁移策略为 forward-compatible、无自动 down；人工回滚清单见文件末尾。

ALTER TABLE "daily_capture_entries" ADD COLUMN IF NOT EXISTS "absorption" jsonb;

-- ROLLBACK（人工执行；无自动 down）：
--   ALTER TABLE "daily_capture_entries" DROP COLUMN IF EXISTS "absorption";
