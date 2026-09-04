import { describe, it, expect } from "vitest";
import {
  AUTHORITATIVE_SEARCH_VECTOR,
  AUTHORITATIVE_SEARCH_INDEX,
  AUTHORITATIVE_L2_PROGRESS_RLS,
  AUTHORITATIVE_L2_PROGRESS_POLICY,
  AUTHORITATIVE_PROFILES_SELECT_POLICY,
  AUTHORITATIVE_HIGHLIGHTS_POLICY,
  AUTHORITATIVE_ANNOTATIONS_POLICY,
  normalizeSql,
  extractSearchVectorColumnSql,
  extractSearchIndexSql,
  compareL2ProgressRlsContract,
  compareOwnerRlsContract,
  compareSecurityDefinerContract,
  compareSearchVectorContract,
} from "../../scripts/verify-schema-drift";

const SAMPLE_SQL = `
CREATE TABLE "words" (
  "id" uuid PRIMARY KEY,
  "lemma" text NOT NULL,
  "title" text NOT NULL,
  "short_definition" text,
  "definition_md" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((((((((((COALESCE(lemma, ''::text) || ' '::text) || COALESCE(title, ''::text)) || ' '::text) || COALESCE(short_definition, ''::text)) || ' '::text) || COALESCE(definition_md, ''::text)) || ' '::text) || COALESCE((metadata ->> 'semantic_field'::text), ''::text)) || ' '::text) || COALESCE((metadata ->> 'word_freq'::text), ''::text))))) STORED,
  CONSTRAINT "words_content_hash_check" CHECK (...)
);

CREATE INDEX "idx_words_search" ON "words" USING gin ("search_vector" tsvector_ops);--> statement-breakpoint
CREATE INDEX "idx_words_lemma_trgm" ON "words" USING gin (lemma gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "user_word_l2_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_word_l2_progress_own_all" ON "user_word_l2_progress" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "profiles_select_own" ON "profiles" AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = id));
ALTER TABLE "word_highlights" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "word_highlights_own_all" ON "word_highlights" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
ALTER TABLE "word_annotations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "word_annotations_own_all" ON "word_annotations" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
`;

const SECURITY_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION public.refresh_l2_cache(p_word_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_actor_id uuid := auth.uid();
BEGIN
IF v_actor_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM public.user_word_l2_progress AS progress
  WHERE progress.user_id = v_actor_id AND progress.word_id = p_word_id
) THEN RAISE EXCEPTION 'actor cannot refresh L2 cache for word' USING ERRCODE = '42501'; END IF;
WITH expanded AS (
  SELECT content.field FROM public.word_l2_content AS content
  WHERE content.word_id = p_word_id AND content.is_active = true
), aggregated AS (SELECT 1)
UPDATE public.words AS word
SET collocations = aggregated.collocations, corpus_items = aggregated.corpus_items, synonym_items = aggregated.synonym_items, antonym_items = aggregated.antonym_items
FROM aggregated WHERE word.id = p_word_id;
END;
$$;
ALTER FUNCTION public.refresh_l2_cache(uuid) OWNER TO vocab_migration;
REVOKE ALL ON FUNCTION public.refresh_l2_cache(uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.finalize_l2_content_hash(p_word_id uuid, p_new_l2_hash text, p_new_content_hash text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE v_actor_id uuid := auth.uid(); v_updated_count integer;
BEGIN
IF v_actor_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM public.user_word_l2_progress AS progress
  WHERE progress.user_id = v_actor_id AND progress.word_id = p_word_id
) THEN RAISE EXCEPTION 'actor cannot finalize L2 content hash for word' USING ERRCODE = '42501'; END IF;
IF p_new_l2_hash !~ '^[0-9a-f]{64}$' OR p_new_content_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid content hash'; END IF;
PERFORM 1 FROM public.words AS word
WHERE word.id = p_word_id AND word.is_deleted = false AND word.is_published = true
AND EXISTS (SELECT 1 FROM public.word_l2_content AS content WHERE content.word_id = word.id AND content.is_active = true)
FOR UPDATE;
UPDATE public.words
SET l2_content_hash = p_new_l2_hash, content_hash = p_new_content_hash, updated_at = pg_catalog.now()
WHERE id = p_word_id;
UPDATE public.user_word_l2_progress
SET l2_content_hash_snapshot = p_new_l2_hash, l2_due_at = pg_catalog.now()
WHERE word_id = p_word_id AND l2_content_hash_snapshot IS NOT NULL AND l2_content_hash_snapshot <> p_new_l2_hash AND l2_paused = false;
GET DIAGNOSTICS v_updated_count = ROW_COUNT;
RETURN v_updated_count;
END; $$;
ALTER FUNCTION public.finalize_l2_content_hash(uuid, text, text) OWNER TO vocab_migration;
REVOKE ALL ON FUNCTION public.finalize_l2_content_hash(uuid, text, text) FROM PUBLIC;
`;

describe("normalizeSql", () => {
  it("collapses whitespace and drops trailing punctuation", () => {
    expect(normalizeSql("  a   b ,\n")).toBe("a b");
    expect(normalizeSql("CREATE INDEX x;  ")).toBe("CREATE INDEX x");
  });
});

describe("extractSearchVectorColumnSql", () => {
  it("extracts the search_vector column definition", () => {
    const col = extractSearchVectorColumnSql(SAMPLE_SQL);
    expect(col).not.toBeNull();
    expect(col).toContain('"tsvector"');
    expect(col).toContain("GENERATED ALWAYS AS");
    expect(col).toContain("STORED");
  });

  it("returns null when the column is absent", () => {
    expect(extractSearchVectorColumnSql("CREATE TABLE x (id uuid);")).toBeNull();
  });
});

describe("extractSearchIndexSql", () => {
  it("extracts the idx_words_search index definition", () => {
    const idx = extractSearchIndexSql(SAMPLE_SQL);
    expect(idx).not.toBeNull();
    expect(idx).toContain('USING gin ("search_vector" tsvector_ops)');
  });

  it("returns null when the index is absent", () => {
    expect(extractSearchIndexSql("CREATE INDEX other ON x (id);")).toBeNull();
  });
});

describe("compareL2ProgressRlsContract", () => {
  it("requires RLS enablement and the exact owner policy", () => {
    expect(compareL2ProgressRlsContract(SAMPLE_SQL)).toBe(true);
    expect(compareL2ProgressRlsContract(SAMPLE_SQL.replace(AUTHORITATIVE_L2_PROGRESS_RLS, ""))).toBe(false);
    expect(compareL2ProgressRlsContract(SAMPLE_SQL.replace(AUTHORITATIVE_L2_PROGRESS_POLICY, ""))).toBe(false);
    expect(compareL2ProgressRlsContract(SAMPLE_SQL.replace("auth.uid() = user_id", "true"))).toBe(false);
  });
});

describe("compareOwnerRlsContract", () => {
  it("requires exact owner predicates for profiles, highlights, and annotations", () => {
    expect(compareOwnerRlsContract(SAMPLE_SQL)).toBe(true);
    expect(compareOwnerRlsContract(SAMPLE_SQL.replace(AUTHORITATIVE_PROFILES_SELECT_POLICY, ""))).toBe(false);
    expect(compareOwnerRlsContract(SAMPLE_SQL.replace(AUTHORITATIVE_HIGHLIGHTS_POLICY, ""))).toBe(false);
    expect(compareOwnerRlsContract(SAMPLE_SQL.replace(AUTHORITATIVE_ANNOTATIONS_POLICY, ""))).toBe(false);
    expect(compareOwnerRlsContract(SAMPLE_SQL.replace("auth.uid() = id", "true"))).toBe(false);
  });
});

describe("compareSecurityDefinerContract", () => {
  it("requires fixed owner, search_path, PUBLIC revoke, and bounded business SQL", () => {
    expect(compareSecurityDefinerContract(SECURITY_FUNCTION_SQL)).toBe(true);
    expect(compareSecurityDefinerContract(SECURITY_FUNCTION_SQL.replace("SECURITY DEFINER", "SECURITY INVOKER"))).toBe(false);
    expect(compareSecurityDefinerContract(SECURITY_FUNCTION_SQL.replace("pg_catalog, public", "public"))).toBe(false);
    expect(compareSecurityDefinerContract(SECURITY_FUNCTION_SQL.replace("OWNER TO vocab_migration", "OWNER TO vocab_app"))).toBe(false);
    expect(compareSecurityDefinerContract(SECURITY_FUNCTION_SQL.replace("word.id = p_word_id AND word.is_deleted = false", "true AND word.is_deleted = false"))).toBe(false);
    expect(compareSecurityDefinerContract(SECURITY_FUNCTION_SQL.replace("l2_paused = false", "true"))).toBe(false);
    expect(compareSecurityDefinerContract(SECURITY_FUNCTION_SQL.replace("v_actor_id IS NULL", "false"))).toBe(false);
    expect(compareSecurityDefinerContract(SECURITY_FUNCTION_SQL.replace("progress.user_id = v_actor_id", "true"))).toBe(false);
    expect(compareSecurityDefinerContract(SECURITY_FUNCTION_SQL.replace("USING ERRCODE = '42501'", ""))).toBe(false);
    expect(compareSecurityDefinerContract(SECURITY_FUNCTION_SQL.replace("word.is_deleted = false", "true"))).toBe(false);
    expect(compareSecurityDefinerContract(SECURITY_FUNCTION_SQL.replace("FOR UPDATE", ""))).toBe(false);
    expect(compareSecurityDefinerContract(SECURITY_FUNCTION_SQL.replace("'^[0-9a-f]{64}$'", "'.*'"))).toBe(false);
    expect(compareSecurityDefinerContract(SECURITY_FUNCTION_SQL.replace("FROM PUBLIC", "FROM vocab_worker"))).toBe(false);
  });
});

describe("compareSearchVectorContract", () => {
  it("matches the authoritative generated contract", () => {
    const result = compareSearchVectorContract(SAMPLE_SQL);
    expect(result.ok).toBe(true);
    expect(result.columnMatch).toBe(true);
    expect(result.indexMatch).toBe(true);
    expect(result.l2ProgressRlsMatch).toBe(true);
    expect(result.ownerRlsMatch).toBe(true);
  });

  it("detects drift in the search_vector expression (regconfig change)", () => {
    const drifted = SAMPLE_SQL.replace("'english'::regconfig", "'simple'::regconfig");
    const result = compareSearchVectorContract(drifted);
    expect(result.ok).toBe(false);
    expect(result.columnMatch).toBe(false);
    expect(result.indexMatch).toBe(true);
  });

  it("detects drift in the index opclass", () => {
    const drifted = SAMPLE_SQL.replace("tsvector_ops", "gin_trgm_ops");
    const result = compareSearchVectorContract(drifted);
    expect(result.ok).toBe(false);
    expect(result.indexMatch).toBe(false);
  });

  it("detects a missing column or index", () => {
    expect(compareSearchVectorContract("CREATE TABLE words (id uuid);").ok).toBe(false);
  });
});

describe("authoritative contract constants", () => {
  it("are well-formed and reference tsvector", () => {
    expect(AUTHORITATIVE_SEARCH_VECTOR).toContain('"tsvector"');
    expect(AUTHORITATIVE_SEARCH_VECTOR).toContain("GENERATED ALWAYS AS");
    expect(AUTHORITATIVE_SEARCH_INDEX).toContain('USING gin ("search_vector" tsvector_ops)');
    expect(AUTHORITATIVE_L2_PROGRESS_RLS).toContain("ENABLE ROW LEVEL SECURITY");
    expect(AUTHORITATIVE_L2_PROGRESS_POLICY).toContain("auth.uid() = user_id");
    expect(AUTHORITATIVE_PROFILES_SELECT_POLICY).toContain("auth.uid() = id");
    expect(AUTHORITATIVE_HIGHLIGHTS_POLICY).toContain("auth.uid() = user_id");
    expect(AUTHORITATIVE_ANNOTATIONS_POLICY).toContain("auth.uid() = user_id");
  });
});
