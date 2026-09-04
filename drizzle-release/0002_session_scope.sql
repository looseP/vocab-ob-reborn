DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.sessions s
    JOIN public.wordbooks w ON w.id = s.wordbook_id
    WHERE s.user_id <> w.user_id
  ) THEN
    RAISE EXCEPTION 'Cannot enforce Session scope: sessions contain owner/wordbook mismatches';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.review_logs rl
    JOIN public.sessions s ON s.id = rl.session_id
    WHERE rl.session_id IS NOT NULL
      AND (rl.user_id <> s.user_id OR rl.wordbook_id <> s.wordbook_id)
  ) THEN
    RAISE EXCEPTION 'Cannot enforce Session scope: review_logs contain cross-scope session references';
  END IF;
END;
$$;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.wordbooks'::regclass
      AND conname = 'wordbooks_id_user_id_unique'
  ) THEN
    ALTER TABLE public.wordbooks
      ADD CONSTRAINT wordbooks_id_user_id_unique
      UNIQUE (id, user_id);
  END IF;
END;
$$;--> statement-breakpoint

ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_id_user_wordbook_unique
  UNIQUE (id, user_id, wordbook_id);--> statement-breakpoint

ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_wordbook_owner_fkey
  FOREIGN KEY (wordbook_id, user_id)
  REFERENCES public.wordbooks (id, user_id)
  ON DELETE CASCADE
  NOT VALID;--> statement-breakpoint

ALTER TABLE public.sessions
  VALIDATE CONSTRAINT sessions_wordbook_owner_fkey;--> statement-breakpoint

ALTER TABLE public.review_logs
  ADD CONSTRAINT review_logs_session_scope_fkey
  FOREIGN KEY (session_id, user_id, wordbook_id)
  REFERENCES public.sessions (id, user_id, wordbook_id)
  NOT VALID;--> statement-breakpoint

ALTER TABLE public.review_logs
  VALIDATE CONSTRAINT review_logs_session_scope_fkey;--> statement-breakpoint

DROP FUNCTION IF EXISTS public.increment_session_cards_seen(uuid);--> statement-breakpoint
CREATE FUNCTION public.increment_session_cards_seen(
  p_session_id uuid,
  p_user_id uuid,
  p_wordbook_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.sessions AS s
  SET cards_seen = s.cards_seen + 1,
      updated_at = now()
  WHERE s.id = p_session_id
    AND s.user_id = p_user_id
    AND s.wordbook_id = p_wordbook_id
    AND s.ended_at IS NULL;

  RETURN FOUND;
END;
$$;--> statement-breakpoint

DROP FUNCTION IF EXISTS public.undo_review_log(uuid, uuid, uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.undo_review_log(
  p_review_log_id uuid,
  p_user_id uuid,
  p_wordbook_id uuid,
  p_session_id uuid
)
RETURNS TABLE (
  out_success boolean,
  out_progress_id uuid,
  out_word_id uuid,
  out_error_message text
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_log public.review_logs%ROWTYPE;
  v_latest_log_id uuid;
  v_snapshot jsonb;
  v_last_rating_text text;
BEGIN
  PERFORM 1
  FROM public.sessions
  WHERE id = p_session_id
    AND user_id = p_user_id
    AND wordbook_id = p_wordbook_id
    AND ended_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'Session not found'::text;
    RETURN;
  END IF;

  SELECT * INTO v_log
  FROM public.review_logs
  WHERE id = p_review_log_id
    AND user_id = p_user_id
    AND wordbook_id = p_wordbook_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'Review log not found'::text;
    RETURN;
  END IF;

  IF v_log.undone THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'Review is already undone'::text;
    RETURN;
  END IF;

  IF v_log.rating IS NULL OR v_log.previous_progress_snapshot IS NULL OR v_log.progress_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'Review log is not undoable'::text;
    RETURN;
  END IF;

  IF v_log.session_id IS DISTINCT FROM p_session_id THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'Session does not match review log'::text;
    RETURN;
  END IF;

  PERFORM 1
  FROM public.user_word_progress
  WHERE id = v_log.progress_id
    AND user_id = p_user_id
    AND wordbook_id = p_wordbook_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'Progress not found'::text;
    RETURN;
  END IF;

  SELECT id INTO v_latest_log_id
  FROM public.review_logs
  WHERE progress_id = v_log.progress_id
    AND user_id = p_user_id
    AND wordbook_id = p_wordbook_id
    AND undone = false
    AND rating IS NOT NULL
    AND previous_progress_snapshot IS NOT NULL
    AND track = 'l1'
  ORDER BY reviewed_at DESC, id DESC
  LIMIT 1
  FOR UPDATE;

  IF v_latest_log_id IS DISTINCT FROM p_review_log_id THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'Only the latest review can be undone'::text;
    RETURN;
  END IF;

  v_snapshot := v_log.previous_progress_snapshot;
  v_last_rating_text := v_snapshot->>'last_rating';

  UPDATE public.user_word_progress
  SET scheduler_payload = COALESCE(v_snapshot->'scheduler_payload', '{}'::jsonb),
      difficulty = (v_snapshot->>'difficulty')::numeric,
      due_at = (v_snapshot->>'due_at')::timestamptz,
      interval_days = (v_snapshot->>'interval_days')::integer,
      lapse_count = COALESCE((v_snapshot->>'lapse_count')::integer, 0),
      last_rating = CASE
        WHEN v_last_rating_text IS NULL THEN NULL
        ELSE v_last_rating_text::public.review_rating
      END,
      last_reviewed_at = (v_snapshot->>'last_reviewed_at')::timestamptz,
      retrievability = (v_snapshot->>'retrievability')::numeric,
      review_count = COALESCE((v_snapshot->>'review_count')::integer, 0),
      stability = (v_snapshot->>'stability')::numeric,
      state = v_snapshot->>'state',
      again_count = COALESCE((v_snapshot->>'again_count')::integer, 0),
      hard_count = COALESCE((v_snapshot->>'hard_count')::integer, 0),
      good_count = COALESCE((v_snapshot->>'good_count')::integer, 0),
      easy_count = COALESCE((v_snapshot->>'easy_count')::integer, 0),
      content_hash_snapshot = v_snapshot->>'content_hash_snapshot',
      l1_content_hash_snapshot = v_snapshot->>'l1_content_hash_snapshot',
      recent_ratings = COALESCE(v_snapshot->'recent_ratings', '[]'::jsonb),
      l1_weak_signal = COALESCE((v_snapshot->>'l1_weak_signal')::boolean, false),
      updated_at = now()
  WHERE id = v_log.progress_id
    AND user_id = p_user_id
    AND wordbook_id = p_wordbook_id;

  UPDATE public.review_logs
  SET undone = true, undone_at = now()
  WHERE id = p_review_log_id
    AND user_id = p_user_id
    AND wordbook_id = p_wordbook_id
    AND undone = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Concurrent undo detected';
  END IF;

  RETURN QUERY SELECT true, v_log.progress_id, v_log.word_id, NULL::text;
END;
$$;
