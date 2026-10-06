-- 0051: ADR-0041 Amendment 2 —— 葫芦协议版本 / 曝光轮 / 词集指纹（R12–R13）。
--
-- 三个语义面（修订补充 §六，逐字落地）：
--   * hulu_plans.protocol_version：'v2' 新计划 / 'legacy' 存量回填。决定入池范围
--     解释、轮次序列形状、曲线基准口径。
--   * hulu_plans.include_new_words：创建时「包含还没复习过的词」的持久化选择
--     （默认 false = R9 先学后刷）；v2 计划是否需要曝光轮由它决定 —— 池创建时已
--     定格，事后无法从词集反推。
--   * hulu_rounds.kind：'exposure' 曝光轮 / 'recall' 复习轮 / 'legacy' 存量回填。
--     legacy 轮参与曲线但永不作为基准轮。
--   * hulu_rounds.word_set_fingerprint：本轮**实际结算词集**的指纹，可比较轮的判据。
--
-- 默认值指向**旧**语义（legacy / false / NULL 指纹）是刻意的 fail-safe：DEFAULT 是
-- 给「未感知新列的旧写入路径」的兜底，滚动升级/回滚窗口内旧代码写出的行仍被正确
-- 解释。新代码写新行时显式给 'v2' / 'exposure'|'recall'，不吃默认值。
-- 存量行不回填指纹 —— 重建不出可信的历史结算词集，老曲线维持现行画法。
--
-- round_no CHECK 下界 1 → 0：曝光轮就是 round_no = 0（唯一索引 UNIQUE(plan_id,
-- round_no) 沿用；v2 计划的第一条复习轮 round_no = 1）。上界 8 不动 —— 复习轮恒为
-- 1..target_rounds，target ≤ 8 不变。
--
-- 幂等（ADR-0042 D4：idx 51 起手写 + DDL 幂等）：ADD COLUMN 全部 IF NOT EXISTS；
-- 约束一律 DROP IF EXISTS + ADD；重复执行不报错。本项目迁移策略为
-- forward-compatible、无自动 down（见 scripts/verify-rollback-compatibility.ts）；
-- 人工回滚清单见文件末尾注释。

ALTER TABLE hulu_plans
  ADD COLUMN IF NOT EXISTS protocol_version text NOT NULL DEFAULT 'legacy';--> statement-breakpoint
ALTER TABLE hulu_plans
  ADD COLUMN IF NOT EXISTS include_new_words boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE hulu_plans DROP CONSTRAINT IF EXISTS hulu_plans_protocol_check;--> statement-breakpoint
ALTER TABLE hulu_plans ADD CONSTRAINT hulu_plans_protocol_check
  CHECK (protocol_version IN ('v2','legacy'));--> statement-breakpoint

ALTER TABLE hulu_rounds
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'legacy';--> statement-breakpoint
ALTER TABLE hulu_rounds
  ADD COLUMN IF NOT EXISTS word_set_fingerprint text;--> statement-breakpoint
ALTER TABLE hulu_rounds DROP CONSTRAINT IF EXISTS hulu_rounds_kind_check;--> statement-breakpoint
ALTER TABLE hulu_rounds ADD CONSTRAINT hulu_rounds_kind_check
  CHECK (kind IN ('exposure','recall','legacy'));--> statement-breakpoint

ALTER TABLE hulu_rounds DROP CONSTRAINT IF EXISTS hulu_rounds_round_no_check;--> statement-breakpoint
ALTER TABLE hulu_rounds ADD CONSTRAINT hulu_rounds_round_no_check
  CHECK (round_no >= 0 AND round_no <= 8);

-- ROLLBACK（人工执行；无自动 down）：
--   ALTER TABLE hulu_rounds DROP CONSTRAINT IF EXISTS hulu_rounds_round_no_check;
--   ALTER TABLE hulu_rounds ADD CONSTRAINT hulu_rounds_round_no_check
--     CHECK (round_no >= 1 AND round_no <= 8);
--   ALTER TABLE hulu_rounds DROP CONSTRAINT IF EXISTS hulu_rounds_kind_check;
--   ALTER TABLE hulu_rounds DROP COLUMN IF EXISTS word_set_fingerprint;
--   ALTER TABLE hulu_rounds DROP COLUMN IF EXISTS kind;
--   ALTER TABLE hulu_plans DROP CONSTRAINT IF EXISTS hulu_plans_protocol_check;
--   ALTER TABLE hulu_plans DROP COLUMN IF EXISTS include_new_words;
--   ALTER TABLE hulu_plans DROP COLUMN IF EXISTS protocol_version;
-- 注意：回滚前须确认没有 round_no = 0 的曝光轮与 kind = 'exposure'|'recall' 的轮
-- （旧 CHECK 只认 1..8，且 kind 列会被整体删除）。
