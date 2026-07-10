CREATE OR REPLACE FUNCTION public.get_or_create_today_session(
  p_user_id uuid,
  p_wordbook_id uuid,
  p_mode text,
  p_today_start timestamptz
) RETURNS SETOF public.sessions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_session public.sessions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(p_user_id::text),
    hashtext(p_wordbook_id::text || ':' || p_mode)
  );

  SELECT * INTO v_session
  FROM public.sessions
  WHERE user_id = p_user_id
    AND wordbook_id = p_wordbook_id
    AND mode = p_mode
    AND ended_at IS NULL
  ORDER BY started_at DESC, id DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND v_session.started_at >= p_today_start THEN
    RETURN NEXT v_session;
    RETURN;
  END IF;

  IF FOUND THEN
    UPDATE public.sessions
    SET ended_at = now(), updated_at = now()
    WHERE id = v_session.id;
  END IF;

  INSERT INTO public.sessions (user_id, wordbook_id, mode)
  VALUES (p_user_id, p_wordbook_id, p_mode)
  RETURNING * INTO v_session;

  RETURN NEXT v_session;
END;
$$;--> statement-breakpoint

DROP FUNCTION IF EXISTS public.increment_session_cards_seen(uuid);--> statement-breakpoint
CREATE FUNCTION public.increment_session_cards_seen(p_session_id uuid)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.sessions AS s
  SET cards_seen = s.cards_seen + 1,
      updated_at = now()
  WHERE s.id = p_session_id;
$$;--> statement-breakpoint

DROP FUNCTION IF EXISTS public.undo_review_log(uuid, uuid, uuid);--> statement-breakpoint
CREATE FUNCTION public.undo_review_log(
  p_review_log_id uuid,
  p_user_id uuid,
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
  SELECT * INTO v_log
  FROM public.review_logs
  WHERE id = p_review_log_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'Review log not found'::text;
    RETURN;
  END IF;

  IF v_log.user_id <> p_user_id THEN
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
  WHERE id = v_log.progress_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'Progress not found'::text;
    RETURN;
  END IF;

  SELECT id INTO v_latest_log_id
  FROM public.review_logs
  WHERE progress_id = v_log.progress_id
    AND user_id = p_user_id
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
  WHERE id = v_log.progress_id AND user_id = p_user_id;

  UPDATE public.review_logs
  SET undone = true, undone_at = now()
  WHERE id = p_review_log_id AND user_id = p_user_id AND undone = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Concurrent undo detected';
  END IF;

  -- Session cards_seen is a best-effort derived counter. Reconciliation owns
  -- correction because the corresponding increment can fail after L1 commit.

  RETURN QUERY SELECT true, v_log.progress_id, v_log.word_id, NULL::text;
END;
$$;
