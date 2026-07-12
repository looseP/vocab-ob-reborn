import { describe, it, expect } from "vitest";
import {
  AUTHORITATIVE_SEARCH_VECTOR,
  AUTHORITATIVE_SEARCH_INDEX,
  normalizeSql,
  extractSearchVectorColumnSql,
  extractSearchIndexSql,
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
CREATE INDEX "idx_words_lemma_trgm" ON "words" USING gin (lemma gin_trgm_ops);
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

describe("compareSearchVectorContract", () => {
  it("matches the authoritative generated contract", () => {
    const result = compareSearchVectorContract(SAMPLE_SQL);
    expect(result.ok).toBe(true);
    expect(result.columnMatch).toBe(true);
    expect(result.indexMatch).toBe(true);
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
  });
});
