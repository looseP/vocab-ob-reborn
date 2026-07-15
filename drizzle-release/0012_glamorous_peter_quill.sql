ALTER TABLE "word_annotations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "word_highlights" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "word_annotations_own_all" ON "word_annotations" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "word_highlights_own_all" ON "word_highlights" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));--> statement-breakpoint
ALTER POLICY "profiles_select_own" ON "profiles" TO public USING ((auth.uid() = id));--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.refresh_l2_cache(p_word_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
BEGIN
  IF v_actor_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.user_word_l2_progress AS progress
    WHERE progress.user_id = v_actor_id
      AND progress.word_id = p_word_id
  ) THEN
    RAISE EXCEPTION 'actor cannot refresh L2 cache for word'
      USING ERRCODE = '42501';
  END IF;

  WITH expanded AS (
    SELECT content.field, item.value, content.created_at, item.ordinality
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
REVOKE ALL ON FUNCTION public.refresh_l2_cache(uuid) FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.finalize_l2_content_hash(p_word_id uuid, p_new_l2_hash text, p_new_content_hash text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_updated_count integer;
BEGIN
  IF v_actor_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.user_word_l2_progress AS progress
    WHERE progress.user_id = v_actor_id
      AND progress.word_id = p_word_id
  ) THEN
    RAISE EXCEPTION 'actor cannot finalize L2 content hash for word'
      USING ERRCODE = '42501';
  END IF;

  IF p_new_l2_hash !~ '^[0-9a-f]{64}$'
     OR p_new_content_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid content hash';
  END IF;

  PERFORM 1
  FROM public.words AS word
  WHERE word.id = p_word_id
    AND word.is_deleted = false
    AND word.is_published = true
    AND EXISTS (
      SELECT 1
      FROM public.word_l2_content AS content
      WHERE content.word_id = word.id
        AND content.is_active = true
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'word is not eligible for L2 finalization';
  END IF;

  UPDATE public.words
  SET l2_content_hash = p_new_l2_hash,
      content_hash = p_new_content_hash,
      updated_at = pg_catalog.now()
  WHERE id = p_word_id;

  UPDATE public.user_word_l2_progress
  SET l2_content_hash_snapshot = p_new_l2_hash,
      l2_due_at = pg_catalog.now()
  WHERE word_id = p_word_id
    AND l2_content_hash_snapshot IS NOT NULL
    AND l2_content_hash_snapshot <> p_new_l2_hash
    AND l2_paused = false;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count;
END;
$$;--> statement-breakpoint
ALTER FUNCTION public.finalize_l2_content_hash(uuid, text, text) OWNER TO vocab_migration;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.finalize_l2_content_hash(uuid, text, text) FROM PUBLIC;