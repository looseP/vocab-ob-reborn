DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_word_progress p
    JOIN public.wordbooks w ON w.id = p.wordbook_id
    WHERE p.user_id <> w.user_id
  ) THEN
    RAISE EXCEPTION 'Cannot enforce progress scope: progress rows contain owner/wordbook mismatches';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.review_logs rl
    JOIN public.user_word_progress p ON p.id = rl.progress_id
    WHERE rl.progress_id IS NOT NULL
      AND (rl.user_id <> p.user_id OR rl.wordbook_id <> p.wordbook_id)
  ) THEN
    RAISE EXCEPTION 'Cannot enforce progress scope: review logs contain cross-scope progress references';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.review_logs rl
    JOIN public.wordbooks w ON w.id = rl.wordbook_id
    WHERE rl.user_id <> w.user_id
  ) THEN
    RAISE EXCEPTION 'Cannot enforce review-log scope: logs contain owner/wordbook mismatches';
  END IF;
END;
$$;--> statement-breakpoint

ALTER TABLE public.user_word_progress
  ADD CONSTRAINT user_word_progress_id_user_wordbook_unique
  UNIQUE (id, user_id, wordbook_id);--> statement-breakpoint

ALTER TABLE public.user_word_progress
  ADD CONSTRAINT user_word_progress_wordbook_owner_fkey
  FOREIGN KEY (wordbook_id, user_id)
  REFERENCES public.wordbooks (id, user_id)
  ON DELETE CASCADE
  NOT VALID;--> statement-breakpoint

ALTER TABLE public.user_word_progress
  VALIDATE CONSTRAINT user_word_progress_wordbook_owner_fkey;--> statement-breakpoint

ALTER TABLE public.review_logs
  ADD CONSTRAINT review_logs_progress_scope_fkey
  FOREIGN KEY (progress_id, user_id, wordbook_id)
  REFERENCES public.user_word_progress (id, user_id, wordbook_id)
  NOT VALID;--> statement-breakpoint

ALTER TABLE public.review_logs
  VALIDATE CONSTRAINT review_logs_progress_scope_fkey;--> statement-breakpoint

ALTER TABLE public.review_logs
  ADD CONSTRAINT review_logs_wordbook_owner_fkey
  FOREIGN KEY (wordbook_id, user_id)
  REFERENCES public.wordbooks (id, user_id)
  ON DELETE CASCADE
  NOT VALID;--> statement-breakpoint

ALTER TABLE public.review_logs
  VALIDATE CONSTRAINT review_logs_wordbook_owner_fkey;
