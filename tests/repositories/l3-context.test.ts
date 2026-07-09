import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "../helpers/mock-db";

const mock = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  checkPoolHealth: vi.fn(),
  resetPool: vi.fn(),
}));

import { createRepositories } from "@/index";

const BASE_CONTEXT_ROW = {
  context_id: "00000000-0000-4000-8000-000000000201",
  source_id: "00000000-0000-4000-8000-000000000202",
  user_id: "00000000-0000-4000-8000-000000000203",
  context_type: "sentence",
  text: "A vivid context.",
  normalized_text: null,
  context_language: "en",
  position: {},
  context_metadata: {},
  context_created_at: "2026-07-08T00:00:00Z",
  context_updated_at: "2026-07-08T00:00:00Z",
  source_user_id: "00000000-0000-4000-8000-000000000203",
  wordbook_id: "00000000-0000-4000-8000-000000000204",
  source_type: "article",
  title: "Essay",
  author: null,
  url: null,
  source_language: "en",
  source_metadata: {},
  source_created_at: "2026-07-08T00:00:00Z",
  source_updated_at: "2026-07-08T00:00:00Z",
};

const BASE_WORD_ROW = {
  id: "00000000-0000-4000-8000-000000000205",
  slug: "vivid",
  title: "vivid",
  lemma: "vivid",
  pos: null,
  cefr: null,
  ipa: null,
  aliases: [],
  short_definition: null,
  definition_md: "",
  body_md: "",
  examples: [],
  metadata: {},
  source_path: "words/vivid.md",
  source_updated_at: null,
  content_hash: "a".repeat(64),
  is_published: true,
  is_deleted: false,
  created_at: "2026-07-08T00:00:00Z",
  updated_at: "2026-07-08T00:00:00Z",
  word_id: "00000000-0000-4000-8000-000000000205",
  word_slug: "vivid",
  word_title: "vivid",
  word_lemma: "vivid",
  word_pos: null,
  word_cefr: null,
  word_ipa: null,
  word_aliases: [],
  word_short_definition: null,
  word_definition_md: "",
  word_body_md: "",
  word_examples: [],
  word_metadata: {},
  word_source_path: "words/vivid.md",
  word_source_updated_at: null,
  word_content_hash: "a".repeat(64),
  word_is_published: true,
  word_is_deleted: false,
  word_created_at: "2026-07-08T00:00:00Z",
  word_updated_at: "2026-07-08T00:00:00Z",
};

beforeEach(() => mock.reset());

describe("L3ContextRepository", () => {
  it("creates source, context, occurrence, link, and import job in l3 tables only", async () => {
    mock.setRowMap({
      "INSERT INTO l3_sources": [{ id: "src-1", user_id: "u1", source_type: "article", title: "Essay" }],
      "INSERT INTO l3_contexts": [{ id: "ctx-1", user_id: "u1", source_id: "src-1", text: "A vivid context." }],
      "INSERT INTO l3_occurrences": [{ id: "occ-1", user_id: "u1", context_id: "ctx-1", word_id: "w1", surface: "vivid" }],
      "INSERT INTO l3_context_links": [{ id: "link-1", user_id: "u1", link_type: "illustrates" }],
      "INSERT INTO l3_import_jobs": [{ id: "job-1", user_id: "u1", status: "pending", input_hash: "hash" }],
    });
    const repos = createRepositories();

    await repos.l3Context.createSource({
      user_id: "u1",
      source_type: "article",
      title: "Essay",
      metadata: { source: "manual" },
    });
    await repos.l3Context.createContext({
      user_id: "u1",
      source_id: "src-1",
      context_type: "sentence",
      text: "A vivid context.",
    });
    await repos.l3Context.createOccurrence({
      user_id: "u1",
      context_id: "ctx-1",
      word_id: "w1",
      surface: "vivid",
      start_offset: 2,
      end_offset: 7,
    });
    await repos.l3Context.createContextLink({
      user_id: "u1",
      context_id: "ctx-1",
      word_id: "w1",
      link_type: "illustrates",
      target_type: "word",
      target_id: "w1",
    });
    await repos.l3Context.createImportJob({
      user_id: "u1",
      status: "pending",
      input_hash: "hash",
    });

    expect(mock.calls.map((call) => call.text)).toEqual([
      expect.stringContaining("INSERT INTO l3_sources"),
      expect.stringContaining("INSERT INTO l3_contexts"),
      expect.stringContaining("INSERT INTO l3_occurrences"),
      expect.stringContaining("INSERT INTO l3_context_links"),
      expect.stringContaining("INSERT INTO l3_import_jobs"),
    ]);
    const allSql = mock.calls.map((call) => call.text).join("\n");
    expect(allSql).not.toContain("word_l2_content");
    expect(allSql).not.toContain("user_word_progress");
    expect(allSql).not.toContain("user_word_l2_progress");
    expect(allSql).not.toContain("UPDATE words");
  });

  it("deletes occurrence and context link by explicit owner-scoped id", async () => {
    mock.setRowMap({
      "DELETE FROM l3_occurrences": [{
        id: "occ-1",
        user_id: "u1",
        context_id: "ctx-1",
        word_id: "w1",
        surface: "vivid",
      }],
      "DELETE FROM l3_context_links": [{
        id: "link-1",
        user_id: "u1",
        context_id: "ctx-1",
        link_type: "manual_link",
        target_type: "external",
      }],
    });
    const repos = createRepositories();

    await expect(repos.l3Context.deleteOccurrence("u1", "occ-1")).resolves.toMatchObject({
      id: "occ-1",
      user_id: "u1",
    });
    await expect(repos.l3Context.deleteContextLink("u1", "link-1")).resolves.toMatchObject({
      id: "link-1",
      user_id: "u1",
    });

    const sql = mock.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("DELETE FROM l3_occurrences");
    expect(sql).toContain("WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(sql).toContain("DELETE FROM l3_context_links");
    expect(sql).toContain("RETURNING *");
    expect(mock.calls[0].params).toEqual(["occ-1", "u1"]);
    expect(mock.calls[1].params).toEqual(["link-1", "u1"]);
  });

  it("returns null when deleting a missing or out-of-scope active L3 row", async () => {
    mock.setRows([]);
    const repos = createRepositories();

    await expect(repos.l3Context.deleteOccurrence("u1", "missing-occ")).resolves.toBeNull();
    await expect(repos.l3Context.deleteContextLink("u1", "missing-link")).resolves.toBeNull();
  });

  it("summarizes source and context delete blockers by owner scope", async () => {
    mock.setRowMap({
      "AS context_count": [{
        context_count: "2",
        inbound_context_link_count: "1",
        import_job_count: "3",
      }],
      "AS occurrence_count": [{
        occurrence_count: "4",
        context_link_count: "5",
        inbound_context_link_count: "6",
      }],
    });
    const repos = createRepositories();

    await expect(repos.l3Context.getSourceDeleteBlockers("u1", "src-1")).resolves.toEqual({
      contextCount: 2,
      inboundContextLinkCount: 1,
      importJobCount: 3,
    });
    await expect(repos.l3Context.getContextDeleteBlockers("u1", "ctx-1")).resolves.toEqual({
      occurrenceCount: 4,
      contextLinkCount: 5,
      inboundContextLinkCount: 6,
    });

    expect(mock.calls[0].text).toContain("FROM l3_contexts");
    expect(mock.calls[0].text).toContain("source_id = $1::uuid");
    expect(mock.calls[0].text).toContain("user_id = $2::uuid");
    expect(mock.calls[0].text).toContain("target_type = 'source'");
    expect(mock.calls[0].text).toContain("lower(target_id) = lower($1::text)");
    expect(mock.calls[0].text).toContain("FROM l3_import_jobs");
    expect(mock.calls[0].params).toEqual(["src-1", "u1"]);

    expect(mock.calls[1].text).toContain("FROM l3_occurrences");
    expect(mock.calls[1].text).toContain("context_id = $1::uuid");
    expect(mock.calls[1].text).toContain("user_id = $2::uuid");
    expect(mock.calls[1].text).toContain("target_type = 'context'");
    expect(mock.calls[1].text).toContain("lower(target_id) = lower($1::text)");
    expect(mock.calls[1].params).toEqual(["ctx-1", "u1"]);
  });

  it("deletes source and context by explicit owner-scoped id", async () => {
    mock.setRowMap({
      "DELETE FROM l3_sources": [{
        id: "src-1",
        user_id: "u1",
        source_type: "manual",
        title: "Manual note",
      }],
      "DELETE FROM l3_contexts": [{
        id: "ctx-1",
        source_id: "src-1",
        user_id: "u1",
        context_type: "sentence",
        text: "A vivid context.",
      }],
    });
    const repos = createRepositories();

    await expect(repos.l3Context.deleteSource("u1", "src-1")).resolves.toMatchObject({
      id: "src-1",
      user_id: "u1",
    });
    await expect(repos.l3Context.deleteContext("u1", "ctx-1")).resolves.toMatchObject({
      id: "ctx-1",
      user_id: "u1",
    });

    const sql = mock.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("DELETE FROM l3_sources");
    expect(sql).toContain("DELETE FROM l3_contexts");
    expect(sql).toContain("WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("FROM l3_contexts");
    expect(sql).toContain("FROM l3_occurrences");
    expect(sql).toContain("FROM l3_context_links");
    expect(sql).toContain("FROM l3_import_jobs");
    expect(sql).toContain("target_type = 'source'");
    expect(sql).toContain("target_type = 'context'");
    expect(sql).toContain("lower(l.target_id) = l3_sources.id::text");
    expect(sql).toContain("lower(inbound.target_id) = l3_contexts.id::text");
    expect(sql).toContain("RETURNING *");
    expect(mock.calls[0].params).toEqual(["src-1", "u1"]);
    expect(mock.calls[1].params).toEqual(["ctx-1", "u1"]);
  });

  it("locks source and context parent rows before guarded service deletes", async () => {
    mock.setRowMap({
      "FROM l3_sources": [{
        id: "src-1",
        user_id: "u1",
        source_type: "manual",
        title: "Manual note",
      }],
      "FROM l3_contexts": [{
        id: "ctx-1",
        source_id: "src-1",
        user_id: "u1",
        context_type: "sentence",
        text: "A vivid context.",
      }],
    });
    const repos = createRepositories();
    const txRepos = createRepositories({ query: mock.pool.query } as never);

    await expect(repos.l3Context.lockSourceByIdForUser("u1", "src-1"))
      .rejects.toMatchObject({ code: "BUSINESS_RULE" });
    await expect(repos.l3Context.lockContextByIdForUser("u1", "ctx-1"))
      .rejects.toMatchObject({ code: "BUSINESS_RULE" });

    mock.reset();
    mock.setRowMap({
      "FROM l3_sources": [{
        id: "src-1",
        user_id: "u1",
        source_type: "manual",
        title: "Manual note",
      }],
      "FROM l3_contexts": [{
        id: "ctx-1",
        source_id: "src-1",
        user_id: "u1",
        context_type: "sentence",
        text: "A vivid context.",
      }],
    });

    await expect(txRepos.l3Context.lockSourceByIdForUser("u1", "src-1")).resolves.toMatchObject({
      id: "src-1",
      user_id: "u1",
    });
    await expect(txRepos.l3Context.lockContextByIdForUser("u1", "ctx-1")).resolves.toMatchObject({
      id: "ctx-1",
      user_id: "u1",
    });

    expect(mock.calls[0].text).toContain("SELECT * FROM l3_sources");
    expect(mock.calls[0].text).toContain("WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(mock.calls[0].text).toContain("FOR UPDATE");
    expect(mock.calls[0].params).toEqual(["src-1", "u1"]);
    expect(mock.calls[1].text).toContain("SELECT * FROM l3_contexts");
    expect(mock.calls[1].text).toContain("WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(mock.calls[1].text).toContain("FOR UPDATE");
    expect(mock.calls[1].params).toEqual(["ctx-1", "u1"]);
  });

  it("uses a transaction-scoped advisory lock for active source/context soft references", async () => {
    const repos = createRepositories();
    const txRepos = createRepositories({ query: mock.pool.query } as never);

    await expect(repos.l3Context.lockActiveL3TargetReference("u1", "source", "src-1"))
      .rejects.toMatchObject({ code: "BUSINESS_RULE" });

    await txRepos.l3Context.lockActiveL3TargetReference("u1", "source", "src-1");
    await txRepos.l3Context.lockActiveL3TargetReference("u1", "context", "ctx-1");

    expect(mock.calls[0].text).toContain("SELECT pg_advisory_xact_lock(hashtext($1))");
    expect(mock.calls[0].params).toEqual(["l3:active-target:u1:source:src-1"]);
    expect(mock.calls[1].text).toContain("SELECT pg_advisory_xact_lock(hashtext($1))");
    expect(mock.calls[1].params).toEqual(["l3:active-target:u1:context:ctx-1"]);
  });

  it("returns null when deleting a missing or out-of-scope source or context", async () => {
    mock.setRows([]);
    const repos = createRepositories();

    await expect(repos.l3Context.deleteSource("u1", "missing-src")).resolves.toBeNull();
    await expect(repos.l3Context.deleteContext("u1", "missing-ctx")).resolves.toBeNull();
  });

  it("lists word contexts as source, context, occurrence, and links summary", async () => {
    mock.setRows([
      {
        context_id: "ctx-1",
        source_id: "src-1",
        user_id: "u1",
        context_type: "sentence",
        text: "A vivid context.",
        normalized_text: null,
        context_language: "en",
        position: {},
        context_metadata: {},
        context_created_at: "2026-07-08T00:00:00Z",
        context_updated_at: "2026-07-08T00:00:00Z",
        source_user_id: "u1",
        wordbook_id: null,
        source_type: "article",
        title: "Essay",
        author: null,
        url: null,
        source_language: "en",
        source_metadata: {},
        source_created_at: "2026-07-08T00:00:00Z",
        source_updated_at: "2026-07-08T00:00:00Z",
        occurrence_id: "occ-1",
        occurrence_context_id: "ctx-1",
        word_id: "w1",
        occurrence_user_id: "u1",
        surface: "vivid",
        lemma: "vivid",
        start_offset: 2,
        end_offset: 7,
        confidence: "0.9000",
        evidence: { method: "manual" },
        occurrence_created_at: "2026-07-08T00:00:00Z",
        links: [{ id: "link-1", link_type: "illustrates" }],
      },
    ]);
    const repos = createRepositories();
    const result = await repos.l3Context.listContextsForWord({
      userId: "u1",
      slug: "vivid",
      limit: 10,
    });

    expect(result.items[0].source.title).toBe("Essay");
    expect(result.items[0].context.text).toBe("A vivid context.");
    expect(result.items[0].occurrence?.surface).toBe("vivid");
    expect(result.items[0].links).toHaveLength(1);
    expect(mock.lastQuery?.text).toContain("JOIN words w ON w.id = o.word_id");
    expect(mock.lastQuery?.text).toContain("w.slug = $3");
  });

  it("scopes source reads to the requesting user", async () => {
    mock.setRows([]);
    const repos = createRepositories();
    const source = await repos.l3Context.findSourceById("u2", "src-1");

    expect(source).toBeNull();
    expect(mock.lastQuery?.text).toContain("WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(mock.lastQuery?.params).toEqual(["src-1", "u2"]);
  });

  it("finds wordbooks and words through user and wordbook scoped lookups", async () => {
    mock.setRows([{ id: "wb-1", user_id: "u1" }]);
    const repos = createRepositories();

    await repos.l3Context.findWordbookByIdForUser("u1", "wb-1");
    expect(mock.lastQuery?.text).toContain("FROM wordbooks WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(mock.lastQuery?.params).toEqual(["wb-1", "u1"]);

    await repos.l3Context.findWordInWordbookById("wb-1", "w1");
    expect(mock.lastQuery?.text).toContain("JOIN wordbook_items wi ON wi.word_id = w.id");
    expect(mock.lastQuery?.text).toContain("wi.wordbook_id = $1::uuid");
    expect(mock.lastQuery?.params).toEqual(["wb-1", "w1"]);
  });

  it("lists source contexts as one context item with aggregated occurrences", async () => {
    mock.setRows([
      {
        context_id: "ctx-1",
        source_id: "src-1",
        user_id: "u1",
        context_type: "sentence",
        text: "A vivid context.",
        normalized_text: null,
        context_language: "en",
        position: {},
        context_metadata: {},
        context_created_at: "2026-07-08T00:00:00Z",
        context_updated_at: "2026-07-08T00:00:00Z",
        source_user_id: "u1",
        wordbook_id: null,
        source_type: "article",
        title: "Essay",
        author: null,
        url: null,
        source_language: "en",
        source_metadata: {},
        source_created_at: "2026-07-08T00:00:00Z",
        source_updated_at: "2026-07-08T00:00:00Z",
        occurrences: [
          { id: "occ-1", context_id: "ctx-1", word_id: "w1", user_id: "u1", surface: "vivid", lemma: null, start_offset: 2, end_offset: 7, confidence: null, evidence: {}, created_at: "2026-07-08T00:00:00Z" },
          { id: "occ-2", context_id: "ctx-1", word_id: "w2", user_id: "u1", surface: "context", lemma: null, start_offset: 8, end_offset: 15, confidence: null, evidence: {}, created_at: "2026-07-08T00:00:01Z" },
        ],
        links: [],
      },
    ]);
    const repos = createRepositories();
    const result = await repos.l3Context.listContextsForSource({
      userId: "u1",
      sourceId: "src-1",
      limit: 10,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].context.id).toBe("ctx-1");
    expect(result.items[0].occurrences).toHaveLength(2);
    expect(mock.lastQuery?.text).toContain("SELECT jsonb_agg(to_jsonb(o) ORDER BY o.created_at)");
    expect(mock.lastQuery?.text).not.toContain("GROUP BY c.id, s.id, o.id");
  });

  it("rejects malformed cursors instead of returning the first page", async () => {
    const repos = createRepositories();

    await expect(repos.l3Context.listContextsForSource({
      userId: "u1",
      sourceId: "src-1",
      limit: 10,
      cursor: "not-a-valid-cursor",
    })).rejects.toBeInstanceOf(Error);
    expect(mock.calls).toHaveLength(0);
  });

  it("updates import job status scoped to the requesting user", async () => {
    mock.setRows([{
      id: "job-1",
      user_id: "u1",
      source_id: null,
      status: "failed",
      input_hash: "hash",
      input_summary: null,
      stats: { contextCount: 1 },
      error: "proposal insert failed",
      created_at: "2026-07-08T00:00:00Z",
      updated_at: "2026-07-08T00:00:01Z",
    }]);
    const repos = createRepositories();

    const job = await repos.l3Context.updateImportJobStatus(
      "job-1",
      "u1",
      "failed",
      { contextCount: 1 },
      "proposal insert failed",
    );

    expect(job.status).toBe("failed");
    expect(mock.lastQuery?.text).toContain("UPDATE l3_import_jobs");
    expect(mock.lastQuery?.text).toContain("WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(mock.lastQuery?.params).toEqual([
      "job-1",
      "u1",
      "failed",
      JSON.stringify({ contextCount: 1 }),
      "proposal insert failed",
    ]);
  });

  it("gets context detail with aggregated occurrences and links", async () => {
    mock.setRows([{
      ...BASE_CONTEXT_ROW,
      occurrences: [{ id: "occ-1", context_id: BASE_CONTEXT_ROW.context_id, word_id: BASE_WORD_ROW.id, user_id: BASE_CONTEXT_ROW.user_id, surface: "vivid" }],
      links: [{ id: "link-1", context_id: BASE_CONTEXT_ROW.context_id, link_type: "illustrates" }],
    }]);
    const repos = createRepositories();

    const result = await repos.l3Context.getContextDetail(BASE_CONTEXT_ROW.user_id, BASE_CONTEXT_ROW.context_id);

    expect(result?.context.id).toBe(BASE_CONTEXT_ROW.context_id);
    expect(result?.source.id).toBe(BASE_CONTEXT_ROW.source_id);
    expect(result?.occurrences).toHaveLength(1);
    expect(result?.links).toHaveLength(1);
    expect(mock.lastQuery?.text).toContain("WHERE c.id = $1::uuid AND c.user_id = $2::uuid");
  });

  it("gets word space with user and wordbook scope", async () => {
    mock.setRows([{
      ...BASE_CONTEXT_ROW,
      ...BASE_WORD_ROW,
      occurrences: [{ id: "occ-1", context_id: BASE_CONTEXT_ROW.context_id, word_id: BASE_WORD_ROW.id, user_id: BASE_CONTEXT_ROW.user_id, surface: "vivid" }],
      links: [],
    }]);
    const repos = createRepositories();

    const result = await repos.l3Context.getWordSpace({
      userId: BASE_CONTEXT_ROW.user_id,
      slug: "vivid",
      wordbookId: BASE_CONTEXT_ROW.wordbook_id,
      limit: 10,
    });

    expect(result?.word.slug).toBe("vivid");
    expect(result?.contexts).toHaveLength(1);
    expect(mock.lastQuery?.text).toContain("WHERE anchor.user_id = $1::uuid");
    expect(mock.lastQuery?.text).toContain("AND s.wordbook_id = $4::uuid");
    expect(mock.lastQuery?.params).toEqual([BASE_CONTEXT_ROW.user_id, 11, BASE_WORD_ROW.id, BASE_CONTEXT_ROW.wordbook_id]);
  });

  it("gets source space through source-scoped context aggregation", async () => {
    mock.setRowMap({
      "SELECT * FROM l3_sources WHERE id": [{
        id: BASE_CONTEXT_ROW.source_id,
        user_id: BASE_CONTEXT_ROW.user_id,
        wordbook_id: BASE_CONTEXT_ROW.wordbook_id,
        source_type: "article",
        title: "Essay",
        author: null,
        url: null,
        language: "en",
        metadata: {},
        created_at: "2026-07-08T00:00:00Z",
        updated_at: "2026-07-08T00:00:00Z",
      }],
      "FROM l3_contexts c": [{
        ...BASE_CONTEXT_ROW,
        occurrences: [{ id: "occ-1", context_id: BASE_CONTEXT_ROW.context_id, word_id: BASE_WORD_ROW.id, user_id: BASE_CONTEXT_ROW.user_id, surface: "vivid" }],
        links: [],
      }],
    });
    const repos = createRepositories();

    const result = await repos.l3Context.getSourceSpace({
      userId: BASE_CONTEXT_ROW.user_id,
      sourceId: BASE_CONTEXT_ROW.source_id,
      limit: 10,
    });

    expect(result?.source.id).toBe(BASE_CONTEXT_ROW.source_id);
    expect(result?.contexts).toHaveLength(1);
    expect(result?.occurrences).toHaveLength(1);
    expect(mock.calls[0].text).toContain("WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(mock.calls[1].text).toContain("AND c.source_id = $3::uuid");
  });

  it("gets graph with bounded deterministic user-scoped query", async () => {
    mock.setRows([]);
    const repos = createRepositories();

    const result = await repos.l3Context.getGraph({
      userId: BASE_CONTEXT_ROW.user_id,
      wordbookId: BASE_CONTEXT_ROW.wordbook_id,
      slug: "vivid",
      sourceId: BASE_CONTEXT_ROW.source_id,
      depth: 1,
      limit: 3,
    });

    expect(result.limit).toBe(3);
    expect(mock.lastQuery?.text).toContain("WHERE c.user_id = $1::uuid");
    expect(mock.lastQuery?.text).toContain("AND s.user_id = $1::uuid");
    expect(mock.lastQuery?.text).toContain("AND s.id = $3::uuid");
    expect(mock.lastQuery?.text).toContain("AND s.wordbook_id = $4::uuid");
    expect(mock.lastQuery?.text).toContain("JOIN words sw ON sw.id = so.word_id");
    expect(mock.lastQuery?.text).toContain("ORDER BY c.created_at DESC, c.id DESC");
    expect(mock.lastQuery?.text).toContain("LIMIT $2");
    expect(mock.lastQuery?.params).toEqual([BASE_CONTEXT_ROW.user_id, 4, BASE_CONTEXT_ROW.source_id, BASE_CONTEXT_ROW.wordbook_id, "vivid"]);
  });

  it("rejects malformed graph cursors before SQL", async () => {
    const repos = createRepositories();

    await expect(repos.l3Context.getGraph({
      userId: BASE_CONTEXT_ROW.user_id,
      depth: 1,
      limit: 10,
      cursor: "not-a-valid-cursor",
    })).rejects.toBeInstanceOf(Error);
    expect(mock.calls).toHaveLength(0);
  });
});
