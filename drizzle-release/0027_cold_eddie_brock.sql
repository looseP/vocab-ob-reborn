-- 0027: ADR-0017 L2 内容方向变体键 —— direction 三处落地（T01）。
--
-- 范围与语义：
--   * word_l2_content：word-scoped 全局内容表（无 user_id / 无 RLS）。新增
--     direction（not null default '通用' + CHECK 枚举）；新增
--     (word_id, field, direction) 唯一索引，partial `WHERE is_active = true`
--     —— 只约束生效行，候选行（is_active=false AND approved_at IS NULL）与
--     退役行（is_active=false AND approved_at IS NOT NULL）不参与，避免
--     "候选/退役行互堵"（proposeCandidates 在已有生效行的词上插入候选行、
--     acceptCandidate(replace)/deactivate 保留退役行，均是既有合法路径）。
--     整表唯一会直接把候选池与退役留档判死，故不采用。
--   * l3_sources：新增 direction + 同样 CHECK（正交于子空间轴）。
--   * refresh_l2_cache：聚合时为每个缓存条目保留 direction 键（jsonb item
--     增加 "direction"），条目其余字段结构不变；非 object 条目无法挂键、
--     原样保留。方向过滤发生在读取/展示层，不进聚合选择逻辑（ADR-0017 §3）。
--
-- 幂等与回滚：
--   * 全部语句幂等（IF NOT EXISTS / DROP IF EXISTS + ADD / CREATE OR REPLACE），
--     重复执行不报错；既有行由 NOT NULL DEFAULT '通用' 自动 backfill。
--   * 本项目迁移策略为 forward-compatible、无自动 down（见
--     scripts/verify-rollback-compatibility.ts）；人工回滚清单见文件末尾注释。

ALTER TABLE "word_l2_content" ADD COLUMN IF NOT EXISTS "direction" text DEFAULT '通用' NOT NULL;--> statement-breakpoint
-- 防御性 backfill：正常路径由 DEFAULT 覆盖；仅处理列已存在但存在 NULL 的中间态。
UPDATE "word_l2_content" SET "direction" = '通用' WHERE "direction" IS NULL;--> statement-breakpoint
ALTER TABLE "word_l2_content" DROP CONSTRAINT IF EXISTS "word_l2_content_direction_check";--> statement-breakpoint
ALTER TABLE "word_l2_content" ADD CONSTRAINT "word_l2_content_direction_check" CHECK (direction = ANY (ARRAY['通用'::text, '考研'::text, '雅思'::text]));--> statement-breakpoint
-- ⚠️ 存量升级前置守卫（fail-closed，不自动 dedup，避免静默丢内容）：
-- 0027 之前 confirmDraft 为追加式写入、acceptCandidate 默认 mode='append'，
-- 同一 (word, field) 允许多条 active 行；这些行 backfill 后全部落在 '通用'，
-- 若存在重复键，唯一索引会失败。此守卫给出可诊断的错误信息（迁移在事务内，
-- 失败自动回滚，修数据后可重跑）。人工处置：把较早的重复行退休
-- （is_active=false，approved_at 留档）或合并内容；排查 SQL：
--   SELECT word_id, field, direction, count(*) FROM word_l2_content
--   WHERE is_active = true GROUP BY 1, 2, 3 HAVING count(*) > 1;
DO $$
DECLARE
  v_duplicate_keys integer;
BEGIN
  SELECT count(*) INTO v_duplicate_keys
  FROM (
    SELECT 1
    FROM public.word_l2_content
    WHERE is_active = true
    GROUP BY word_id, field, direction
    HAVING count(*) > 1
  ) AS duplicate_keys;

  IF v_duplicate_keys > 0 THEN
    RAISE EXCEPTION '0027 preflight: % (word_id, field, direction) 键存在多条 active 行；请先退休旧行或合并内容再重跑（不自动 dedup，避免静默丢内容）', v_duplicate_keys;
  END IF;
END $$;--> statement-breakpoint
-- 生效行去重：每个 (word, field, direction) 至多一条 active 行。
CREATE UNIQUE INDEX IF NOT EXISTS "word_l2_content_word_field_direction_active_unique" ON "word_l2_content" USING btree ("word_id","field","direction") WHERE is_active = true;--> statement-breakpoint

ALTER TABLE "l3_sources" ADD COLUMN IF NOT EXISTS "direction" text DEFAULT '通用' NOT NULL;--> statement-breakpoint
UPDATE "l3_sources" SET "direction" = '通用' WHERE "direction" IS NULL;--> statement-breakpoint
ALTER TABLE "l3_sources" DROP CONSTRAINT IF EXISTS "l3_sources_direction_check";--> statement-breakpoint
ALTER TABLE "l3_sources" ADD CONSTRAINT "l3_sources_direction_check" CHECK (direction = ANY (ARRAY['通用'::text, '考研'::text, '雅思'::text]));--> statement-breakpoint

-- refresh_l2_cache（重放 0018 的放宽守卫形态 + ADR-0017 条目 direction）：
-- 调用的仍是已认证 actor 检查（SECURITY DEFINER 边界不变），聚合选择逻辑
-- 不变（is_active = true 全量聚合），只为每个 object 条目补 direction 键。
CREATE OR REPLACE FUNCTION public.refresh_l2_cache(p_word_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'actor cannot refresh L2 cache for word'
      USING ERRCODE = '42501';
  END IF;

  WITH expanded AS (
    SELECT
      content.field,
      CASE
        WHEN pg_catalog.jsonb_typeof(item.value) = 'object'
          THEN item.value || pg_catalog.jsonb_build_object('direction', content.direction)
        ELSE item.value
      END AS value,
      content.created_at,
      item.ordinality
    FROM public.word_l2_content AS content
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      CASE
        WHEN pg_catalog.jsonb_typeof(content.content) = 'array' THEN content.content
        WHEN pg_catalog.jsonb_typeof(content.content) = 'object'
          AND content.content->>'schemaVersion' = 'l2-content-v1'
          AND pg_catalog.jsonb_typeof(content.content->'items') = 'array'
          THEN content.content->'items'
        WHEN pg_catalog.jsonb_typeof(content.content) = 'object'
          THEN pg_catalog.jsonb_build_array(content.content)
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS item(value, ordinality)
    WHERE content.word_id = p_word_id
      AND content.is_active = true
  ), aggregated AS (
    SELECT
      COALESCE(pg_catalog.jsonb_agg(value ORDER BY created_at, ordinality)
        FILTER (WHERE field = 'collocation'), '[]'::jsonb) AS collocations,
      COALESCE(pg_catalog.jsonb_agg(value ORDER BY created_at, ordinality)
        FILTER (WHERE field = 'corpus'), '[]'::jsonb) AS corpus_items,
      COALESCE(pg_catalog.jsonb_agg(value ORDER BY created_at, ordinality)
        FILTER (WHERE field = 'synonym'), '[]'::jsonb) AS synonym_items,
      COALESCE(pg_catalog.jsonb_agg(value ORDER BY created_at, ordinality)
        FILTER (WHERE field = 'antonym'), '[]'::jsonb) AS antonym_items
    FROM expanded
  )
  UPDATE public.words AS word
  SET collocations = aggregated.collocations,
      corpus_items = aggregated.corpus_items,
      synonym_items = aggregated.synonym_items,
      antonym_items = aggregated.antonym_items
  FROM aggregated
  WHERE word.id = p_word_id;
END;
$$;--> statement-breakpoint
ALTER FUNCTION public.refresh_l2_cache(uuid) OWNER TO vocab_migration;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.refresh_l2_cache(uuid) FROM PUBLIC;

-- ROLLBACK（人工执行；本项目无自动 down，回滚须保持 forward-compatible 语义）：
--   CREATE OR REPLACE FUNCTION public.refresh_l2_cache(uuid) ...  -- 重放 0018_witty_longhorn.sql 的函数体
--   DROP INDEX IF EXISTS "word_l2_content_word_field_direction_active_unique";
--   ALTER TABLE "word_l2_content" DROP CONSTRAINT IF EXISTS "word_l2_content_direction_check";
--   ALTER TABLE "word_l2_content" DROP COLUMN IF EXISTS "direction";
--   ALTER TABLE "l3_sources" DROP CONSTRAINT IF EXISTS "l3_sources_direction_check";
--   ALTER TABLE "l3_sources" DROP COLUMN IF EXISTS "direction";
-- 注意：DROP COLUMN 会丢失 direction 信息（考研/雅思变体回退为 '通用' 语义）；
-- 若在回滚期间产生过同 (word, field) 的多条 active 行，重新前滚前需先按
-- 上面的守卫排查/处置，否则唯一索引重建会失败关闭（与存量升级同一路径）。
