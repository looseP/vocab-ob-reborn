WITH ranked_active_sessions AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, wordbook_id, mode
           ORDER BY started_at DESC, id DESC
         ) AS active_rank
  FROM sessions
  WHERE ended_at IS NULL
)
UPDATE sessions
SET ended_at = now(), updated_at = now()
WHERE id IN (
  SELECT id FROM ranked_active_sessions WHERE active_rank > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_sessions_one_active"
  ON "sessions" USING btree ("user_id", "wordbook_id", "mode")
  WHERE "ended_at" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION get_or_create_today_session(
  p_user_id uuid,
  p_wordbook_id uuid,
  p_mode text,
  p_today_start timestamptz
) RETURNS SETOF sessions
LANGUAGE plpgsql
AS $$
DECLARE
  v_session sessions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext(p_wordbook_id::text || ':' || p_mode));

  SELECT * INTO v_session
  FROM sessions
  WHERE user_id = p_user_id
    AND wordbook_id = p_wordbook_id
    AND mode = p_mode
    AND ended_at IS NULL
  ORDER BY started_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND v_session.started_at >= p_today_start THEN
    RETURN NEXT v_session;
    RETURN;
  END IF;

  IF FOUND THEN
    UPDATE sessions SET ended_at = now() WHERE id = v_session.id;
  END IF;

  INSERT INTO sessions (user_id, wordbook_id, mode)
  VALUES (p_user_id, p_wordbook_id, p_mode)
  RETURNING * INTO v_session;

  RETURN NEXT v_session;
END;
$$;
