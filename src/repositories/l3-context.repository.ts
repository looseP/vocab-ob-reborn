/**
 * L3ContextRepository — isolated context-space persistence.
 *
 * L3 writes only l3_* tables. It links to words through occurrences/links but
 * never writes words JSONB, word_l2_content, or review progress state.
 */

import type {
  L3ContextLinkRow,
  L3ContextRow,
  L3ContextDetail,
  L3GraphReadModel,
  L3ImportJobRow,
  L3OccurrenceRow,
  L3PaginatedList,
  L3SourceContextListItem,
  L3SourceRow,
  L3SourceListPage,
  L3SourceSpace,
  L3WordSpace,
  L3WordContextListItem,
  Json,
  WordbookRow,
  WordRow,
} from "../domain";
import { ValidationError } from "../errors";
import type {
  IL3ContextRepository,
  L3ContextDeleteBlockers,
  L3GraphLookup,
  L3SourceDeleteBlockers,
  L3SourceLookup,
  L3SourceSpaceLookup,
  L3WordLookup,
  L3WordSpaceLookup,
  NewL3Context,
  NewL3ContextLink,
  NewL3ImportJob,
  NewL3Occurrence,
  NewL3Source,
} from "./interfaces";
import { BaseRepository } from "./base";
import { decodeCursor, encodeCursor } from "./l3-cursor";

interface JoinedContextRow {
  context_id: string;
  source_id: string;
  user_id: string;
  context_type: string;
  text: string;
  normalized_text: string | null;
  context_language: string | null;
  position: unknown;
  context_metadata: unknown;
  context_created_at: string;
  context_updated_at: string;
  source_user_id: string;
  wordbook_id: string | null;
  source_type: string;
  title: string;
  author: string | null;
  url: string | null;
  source_language: string | null;
  source_metadata: unknown;
  source_created_at: string;
  source_updated_at: string;
  occurrence_id: string | null;
  occurrence_context_id: string | null;
  word_id: string | null;
  occurrence_user_id: string | null;
  surface: string | null;
  lemma: string | null;
  start_offset: number | null;
  end_offset: number | null;
  confidence: number | string | null;
  evidence: unknown;
  bound_sense: string | null;
  occurrence_created_at: string | null;
  links: L3ContextLinkRow[] | null;
}

interface JoinedContextWithSourceRow {
  context_id: string;
  source_id: string;
  user_id: string;
  context_type: string;
  text: string;
  normalized_text: string | null;
  context_language: string | null;
  position: unknown;
  context_metadata: unknown;
  context_created_at: string;
  context_updated_at: string;
  source_user_id: string;
  wordbook_id: string | null;
  source_type: string;
  title: string;
  author: string | null;
  url: string | null;
  source_language: string | null;
  source_metadata: unknown;
  source_created_at: string;
  source_updated_at: string;
}

// ── 共享 SQL 片段（2026-09-08 去重：6 处读模型查询共用）──────────────────
// 行首缩进与原内联 SQL 逐字一致——最终发送到 PG 的文本保持字节级不变，
// 测试与日志中的 SQL 断言不受影响。新增列时改这里一处即可。
/** context+source 联查列清单（无尾逗号；调用方按需补逗号）。 */
const CONTEXT_SOURCE_COLUMNS = `         c.id AS context_id, c.source_id, c.user_id, c.context_type, c.text,
         c.normalized_text, c.language AS context_language, c.position,
         c.metadata AS context_metadata, c.created_at AS context_created_at,
         c.updated_at AS context_updated_at,
         s.user_id AS source_user_id, s.wordbook_id, s.source_type, s.title,
         s.author, s.url, s.language AS source_language, s.metadata AS source_metadata,
         s.created_at AS source_created_at, s.updated_at AS source_updated_at`;

/** 该语境全部 occurrence 聚合（无尾逗号）。user_id 走 c.user_id（同表 self-join 语义）。 */
const OCCURRENCES_AGG = `         COALESCE(
           (
             SELECT jsonb_agg(to_jsonb(o) ORDER BY o.created_at)
             FROM l3_occurrences o
             WHERE o.context_id = c.id AND o.user_id = c.user_id
           ),
           '[]'::jsonb
         ) AS occurrences`;

/** 该语境全部 context_links 聚合（无尾逗号；含按语境 occurrence 词的 IN 子查询）。 */
const LINKS_AGG = `         COALESCE(
           (
             SELECT jsonb_agg(to_jsonb(l) ORDER BY l.created_at)
             FROM l3_context_links l
             WHERE l.user_id = c.user_id
               AND (
                 l.context_id = c.id
                 OR l.word_id IN (
                   SELECT o.word_id FROM l3_occurrences o
                   WHERE o.context_id = c.id AND o.user_id = c.user_id
                 )
               )
           ),
           '[]'::jsonb
         ) AS links`;

/** 游标谓词（(created_at, id) 双列比较；n = 当前已入参个数）。 */
function cursorPredicate(paramCount: number): string {
  return `AND (c.created_at, c.id) < ($${paramCount - 1}::timestamptz, $${paramCount}::uuid)`;
}

function mapContext(row: JoinedContextWithSourceRow | JoinedContextRow): L3ContextRow {
  return {
      id: row.context_id,
      source_id: row.source_id,
      user_id: row.user_id,
      context_type: row.context_type as never,
      text: row.text,
      normalized_text: row.normalized_text,
      language: row.context_language,
      position: row.position as never,
      metadata: row.context_metadata as never,
      created_at: row.context_created_at,
      updated_at: row.context_updated_at,
  };
}

function mapSource(row: JoinedContextWithSourceRow | JoinedContextRow): L3SourceRow {
  return {
      id: row.source_id,
      user_id: row.source_user_id,
      wordbook_id: row.wordbook_id,
      source_type: row.source_type as never,
      title: row.title,
      author: row.author,
      url: row.url,
      language: row.source_language,
      metadata: row.source_metadata as never,
      content_text: null,
      content_hash: null,
      created_at: row.source_created_at,
      updated_at: row.source_updated_at,
  };
}

function mapOccurrence(row: JoinedContextRow): L3OccurrenceRow | null {
  return row.occurrence_id
    ? {
        id: row.occurrence_id,
        context_id: row.occurrence_context_id ?? row.context_id,
        word_id: row.word_id ?? "",
        user_id: row.occurrence_user_id ?? row.user_id,
        surface: row.surface ?? "",
        lemma: row.lemma,
        start_offset: row.start_offset,
        end_offset: row.end_offset,
        confidence: row.confidence,
        evidence: (row.evidence ?? {}) as never,
        bound_sense: row.bound_sense ?? null,
        created_at: row.occurrence_created_at ?? row.context_created_at,
      }
    : null;
}

function mapJoinedRow(row: JoinedContextRow): L3WordContextListItem {
  return {
    context: mapContext(row),
    source: mapSource(row),
    occurrence: mapOccurrence(row),
    links: row.links ?? [],
  };
}

interface SourceContextRow extends JoinedContextWithSourceRow {
  occurrences: L3OccurrenceRow[] | null;
  links: L3ContextLinkRow[] | null;
}

interface ContextDetailRow extends JoinedContextWithSourceRow {
  occurrences: L3OccurrenceRow[] | null;
  links: L3ContextLinkRow[] | null;
}

interface WordSpaceRow extends JoinedContextWithSourceRow {
  word_id: string;
  word_slug: string;
  word_title: string;
  word_lemma: string;
  word_pos: string | null;
  word_cefr: string | null;
  word_ipa: string | null;
  word_aliases: string[];
  word_short_definition: string | null;
  word_definition_md: string;
  word_body_md: string;
  word_prototype_text: string | null;
  word_examples: Json;
  word_metadata: Json;
  word_source_path: string;
  word_source_updated_at: string | null;
  word_content_hash: string;
  word_is_published: boolean;
  word_is_deleted: boolean;
  word_created_at: string;
  word_updated_at: string;
  occurrences: L3OccurrenceRow[] | null;
  links: L3ContextLinkRow[] | null;
}

interface GraphContextRow extends JoinedContextWithSourceRow {
  occurrences: L3OccurrenceRow[] | null;
  links: L3ContextLinkRow[] | null;
}

interface SourceDeleteBlockerRow {
  context_count: number | string | null;
  inbound_context_link_count: number | string | null;
  import_job_count: number | string | null;
}

interface ContextDeleteBlockerRow {
  occurrence_count: number | string | null;
  context_link_count: number | string | null;
  inbound_context_link_count: number | string | null;
}

function countValue(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function mapSourceContextRow(row: SourceContextRow): L3SourceContextListItem {
  return {
    context: mapContext(row),
    source: mapSource(row),
    occurrences: row.occurrences ?? [],
    links: row.links ?? [],
  };
}

function mapWord(row: WordSpaceRow): WordRow {
  return {
    id: row.word_id,
    slug: row.word_slug,
    title: row.word_title,
    lemma: row.word_lemma,
    pos: row.word_pos,
    cefr: row.word_cefr,
    ipa: row.word_ipa,
    aliases: row.word_aliases,
    short_definition: row.word_short_definition,
    definition_md: row.word_definition_md,
    body_md: row.word_body_md,
    prototype_text: row.word_prototype_text,
    examples: row.word_examples,
    metadata: row.word_metadata,
    source_path: row.word_source_path,
    source_updated_at: row.word_source_updated_at,
    content_hash: row.word_content_hash,
    is_published: row.word_is_published,
    is_deleted: row.word_is_deleted,
    created_at: row.word_created_at,
    updated_at: row.word_updated_at,
  };
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function buildStats(
  sources: L3SourceRow[],
  contexts: L3ContextRow[],
  occurrences: L3OccurrenceRow[],
  links: L3ContextLinkRow[],
) {
  return {
    sourceCount: sources.length,
    contextCount: contexts.length,
    occurrenceCount: occurrences.length,
    linkCount: links.length,
  };
}

function buildWordPage(
  rows: JoinedContextRow[],
  limit: number,
  cursor: string | null | undefined,
): L3PaginatedList<L3WordContextListItem> {
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((row) => mapJoinedRow(row));
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    limit,
    cursor: cursor ?? null,
    nextCursor: rows.length > limit && last
      ? encodeCursor(last.context_created_at, last.context_id)
      : null,
  };
}

function buildSourcePage(
  rows: SourceContextRow[],
  limit: number,
  cursor: string | null | undefined,
): L3PaginatedList<L3SourceContextListItem> {
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((row) => mapSourceContextRow(row));
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    limit,
    cursor: cursor ?? null,
    nextCursor: rows.length > limit && last
      ? encodeCursor(last.context_created_at, last.context_id)
      : null,
  };
}

export class L3ContextRepository extends BaseRepository implements IL3ContextRepository {
  async createSource(input: NewL3Source): Promise<L3SourceRow> {
    const row = await this.queryOne<L3SourceRow>(
      `INSERT INTO l3_sources
         (user_id, wordbook_id, source_type, title, author, url, language, metadata, content_text, content_hash)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       RETURNING *`,
      [
        input.user_id,
        input.wordbook_id ?? null,
        input.source_type,
        input.title,
        input.author ?? null,
        input.url ?? null,
        input.language ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.content_text ?? null,
        input.content_hash ?? null,
      ],
    );
    if (!row) throw new Error("L3 source insert returned no row");
    return row;
  }

  async createContext(input: NewL3Context): Promise<L3ContextRow> {
    const row = await this.queryOne<L3ContextRow>(
      `INSERT INTO l3_contexts
         (source_id, user_id, context_type, text, normalized_text, language, position, metadata)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
       RETURNING *`,
      [
        input.source_id,
        input.user_id,
        input.context_type,
        input.text,
        input.normalized_text ?? null,
        input.language ?? null,
        JSON.stringify(input.position ?? {}),
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    if (!row) throw new Error("L3 context insert returned no row");
    return row;
  }

  async createOccurrence(input: NewL3Occurrence): Promise<L3OccurrenceRow> {
    const row = await this.queryOne<L3OccurrenceRow>(
      `INSERT INTO l3_occurrences
         (context_id, word_id, user_id, surface, lemma, start_offset, end_offset, confidence, evidence, bound_sense)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING *`,
      [
        input.context_id,
        input.word_id,
        input.user_id,
        input.surface,
        input.lemma ?? null,
        input.start_offset ?? null,
        input.end_offset ?? null,
        input.confidence ?? null,
        JSON.stringify(input.evidence ?? {}),
        input.bound_sense ?? null,
      ],
    );
    if (!row) throw new Error("L3 occurrence insert returned no row");
    return row;
  }

  // 圈记幂等复用（2026-09-08）：position JSONB 存 {start,end} 全文锚点，取 int 键比对。
  async findContextByAnchor(
    userId: string,
    sourceId: string,
    anchorStart: number,
    anchorEnd: number,
  ): Promise<L3ContextRow | null> {
    return this.queryOne<L3ContextRow>(
      `SELECT * FROM l3_contexts
       WHERE user_id = $1::uuid AND source_id = $2::uuid
         AND (position->>'start')::int = $3::int
         AND (position->>'end')::int = $4::int
       ORDER BY created_at ASC
       LIMIT 1`,
      [userId, sourceId, anchorStart, anchorEnd],
    );
  }

  async listOccurrencesForContext(userId: string, contextId: string): Promise<L3OccurrenceRow[]> {
    return this.query<L3OccurrenceRow>(
      `SELECT * FROM l3_occurrences
       WHERE user_id = $1::uuid AND context_id = $2::uuid
       ORDER BY created_at ASC`,
      [userId, contextId],
    );
  }

  async createContextLink(input: NewL3ContextLink): Promise<L3ContextLinkRow> {
    const row = await this.queryOne<L3ContextLinkRow>(
      `INSERT INTO l3_context_links
         (user_id, context_id, word_id, link_type, target_type, target_id, target_ref, confidence, provenance)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, $8, $9::jsonb)
       RETURNING *`,
      [
        input.user_id,
        input.context_id ?? null,
        input.word_id ?? null,
        input.link_type,
        input.target_type,
        input.target_id ?? null,
        JSON.stringify(input.target_ref ?? {}),
        input.confidence ?? null,
        JSON.stringify(input.provenance ?? {}),
      ],
    );
    if (!row) throw new Error("L3 context link insert returned no row");
    return row;
  }

  async deleteOccurrence(userId: string, occurrenceId: string): Promise<L3OccurrenceRow | null> {
    return this.queryOne<L3OccurrenceRow>(
      `DELETE FROM l3_occurrences
       WHERE id = $1::uuid AND user_id = $2::uuid
       RETURNING *`,
      [occurrenceId, userId],
    );
  }

  async deleteContextLink(userId: string, contextLinkId: string): Promise<L3ContextLinkRow | null> {
    return this.queryOne<L3ContextLinkRow>(
      `DELETE FROM l3_context_links
       WHERE id = $1::uuid AND user_id = $2::uuid
       RETURNING *`,
      [contextLinkId, userId],
    );
  }

  async getSourceDeleteBlockers(userId: string, sourceId: string): Promise<L3SourceDeleteBlockers> {
    const row = await this.queryOne<SourceDeleteBlockerRow>(
      `SELECT
         (
           SELECT COUNT(*)::int
           FROM l3_contexts
           WHERE source_id = $1::uuid AND user_id = $2::uuid
         ) AS context_count,
         (
           SELECT COUNT(*)::int
           FROM l3_context_links
           WHERE target_type = 'source'
             AND lower(target_id) = lower($1::text)
             AND user_id = $2::uuid
         ) AS inbound_context_link_count,
         (
           SELECT COUNT(*)::int
           FROM l3_import_jobs
           WHERE source_id = $1::uuid AND user_id = $2::uuid
         ) AS import_job_count`,
      [sourceId, userId],
    );
    return {
      contextCount: countValue(row?.context_count),
      inboundContextLinkCount: countValue(row?.inbound_context_link_count),
      importJobCount: countValue(row?.import_job_count),
    };
  }

  async lockSourceByIdForUser(userId: string, sourceId: string): Promise<L3SourceRow | null> {
    this.requireTx();
    return this.queryOne<L3SourceRow>(
      `SELECT * FROM l3_sources
       WHERE id = $1::uuid AND user_id = $2::uuid
       FOR UPDATE`,
      [sourceId, userId],
    );
  }

  async lockContextByIdForUser(userId: string, contextId: string): Promise<L3ContextRow | null> {
    this.requireTx();
    return this.queryOne<L3ContextRow>(
      `SELECT * FROM l3_contexts
       WHERE id = $1::uuid AND user_id = $2::uuid
       FOR UPDATE`,
      [contextId, userId],
    );
  }

  async lockActiveL3TargetReference(
    userId: string,
    targetType: "source" | "context" | "word",
    targetId: string,
  ): Promise<void> {
    this.requireTx();
    await this.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`l3:active-target:${userId.toLowerCase()}:${targetType}:${targetId.toLowerCase()}`],
    );
  }

  async getContextDeleteBlockers(userId: string, contextId: string): Promise<L3ContextDeleteBlockers> {
    const row = await this.queryOne<ContextDeleteBlockerRow>(
      `SELECT
         (
           SELECT COUNT(*)::int
           FROM l3_occurrences
           WHERE context_id = $1::uuid AND user_id = $2::uuid
         ) AS occurrence_count,
         (
           SELECT COUNT(*)::int
           FROM l3_context_links
           WHERE context_id = $1::uuid AND user_id = $2::uuid
         ) AS context_link_count,
         (
           SELECT COUNT(*)::int
           FROM l3_context_links
           WHERE target_type = 'context'
             AND lower(target_id) = lower($1::text)
             AND user_id = $2::uuid
         ) AS inbound_context_link_count`,
      [contextId, userId],
    );
    return {
      occurrenceCount: countValue(row?.occurrence_count),
      contextLinkCount: countValue(row?.context_link_count),
      inboundContextLinkCount: countValue(row?.inbound_context_link_count),
    };
  }

  async deleteSource(userId: string, sourceId: string): Promise<L3SourceRow | null> {
    return this.queryOne<L3SourceRow>(
      `DELETE FROM l3_sources
       WHERE id = $1::uuid AND user_id = $2::uuid
         AND NOT EXISTS (
           SELECT 1 FROM l3_contexts c
           WHERE c.source_id = l3_sources.id AND c.user_id = l3_sources.user_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM l3_context_links l
           WHERE l.target_type = 'source'
             AND lower(l.target_id) = l3_sources.id::text
             AND l.user_id = l3_sources.user_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM l3_import_jobs j
           WHERE j.source_id = l3_sources.id AND j.user_id = l3_sources.user_id
         )
       RETURNING *`,
      [sourceId, userId],
    );
  }

  async deleteContext(userId: string, contextId: string): Promise<L3ContextRow | null> {
    // P0 语境管理出口（2026-09-08 评估修正）：occurrences 与同 context 的 context_links
    // 的 FK 均 ON DELETE CASCADE，随本行一并删除，不设守卫；唯一守卫是 inbound 软引用
    // （target_type='context' 且 target_id 指向本行——无 FK，删源会留悬空引用）。
    // 与 services 层 hasContextDeleteBlockers 的语义保持一致。
    return this.queryOne<L3ContextRow>(
      `DELETE FROM l3_contexts
       WHERE id = $1::uuid AND user_id = $2::uuid
         AND NOT EXISTS (
           SELECT 1 FROM l3_context_links inbound
           WHERE inbound.target_type = 'context'
             AND lower(inbound.target_id) = l3_contexts.id::text
             AND inbound.user_id = l3_contexts.user_id
         )
       RETURNING *`,
      [contextId, userId],
    );
  }

  async createImportJob(input: NewL3ImportJob): Promise<L3ImportJobRow> {
    const row = await this.queryOne<L3ImportJobRow>(
      `INSERT INTO l3_import_jobs
         (user_id, source_id, status, input_hash, input_summary, stats, error)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7)
       RETURNING *`,
      [
        input.user_id,
        input.source_id ?? null,
        input.status,
        input.input_hash,
        input.input_summary ?? null,
        JSON.stringify(input.stats ?? {}),
        input.error ?? null,
      ],
    );
    if (!row) throw new Error("L3 import job insert returned no row");
    return row;
  }

  async findImportJobByInputHash(userId: string, inputHash: string): Promise<L3ImportJobRow | null> {
    return this.queryOne<L3ImportJobRow>(
      `SELECT * FROM l3_import_jobs
       WHERE user_id = $1::uuid AND input_hash = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, inputHash],
    );
  }

  async updateImportJobStatus(
    importJobId: string,
    userId: string,
    status: string,
    stats: unknown = {},
    error: string | null = null,
  ): Promise<L3ImportJobRow> {
    const row = await this.queryOne<L3ImportJobRow>(
      `UPDATE l3_import_jobs
       SET status = $3,
           stats = $4::jsonb,
           error = $5,
           updated_at = now()
       WHERE id = $1::uuid AND user_id = $2::uuid
       RETURNING *`,
      [importJobId, userId, status, JSON.stringify(stats ?? {}), error],
    );
    if (!row) throw new Error("L3 import job status update returned no row");
    return row;
  }

  async findSourceById(userId: string, sourceId: string): Promise<L3SourceRow | null> {
    return this.queryOne<L3SourceRow>(
      `SELECT * FROM l3_sources WHERE id = $1::uuid AND user_id = $2::uuid`,
      [sourceId, userId],
    );
  }

  async findSourceByContentHash(userId: string, contentHash: string): Promise<L3SourceRow | null> {
    return this.queryOne<L3SourceRow>(
      `SELECT * FROM l3_sources WHERE user_id = $1::uuid AND content_hash = $2 LIMIT 1`,
      [userId, contentHash],
    );
  }

  async listSources(input: {
    userId: string; sourceType?: string; q?: string; sort: "recent" | "captures"; limit: number; offset: number;
  }): Promise<L3SourceListPage> {
    const params: unknown[] = [input.userId];
    let where = `WHERE s.user_id = $1::uuid`;
    if (input.sourceType) {
      params.push(input.sourceType);
      where += ` AND s.source_type = $${params.length}`;
    }
    if (input.q && input.q.trim().length > 0) {
      params.push(`%${input.q.trim().replace(/[\\%_]/g, "\\$&")}%`);
      where += ` AND (s.title ILIKE $${params.length} ESCAPE '\\' OR s.content_text ILIKE $${params.length} ESCAPE '\\')`;
    }
    const orderBy = input.sort === "captures"
      ? `context_count DESC NULLS LAST, s.created_at DESC`
      : `s.created_at DESC`;
    const rows = await this.query<{ id: string; title: string; source_type: string; url: string | null; created_at: string; context_count: string }>(
      `SELECT s.id, s.title, s.source_type, s.url, s.created_at,
              (SELECT count(*) FROM l3_contexts c WHERE c.source_id = s.id AND c.user_id = s.user_id) AS context_count
         FROM l3_sources s
         ${where}
        ORDER BY ${orderBy}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, input.limit, input.offset],
    );
    const totalRow = await this.queryOne<{ total: string }>(
      `SELECT count(*) AS total FROM l3_sources s ${where}`,
      params,
    );
    return {
      items: rows.map((r) => ({ ...r, context_count: Number(r.context_count) })),
      total: Number(totalRow?.total ?? 0),
      limit: input.limit,
      offset: input.offset,
    };
  }

  async findWordbookByIdForUser(userId: string, wordbookId: string): Promise<WordbookRow | null> {
    return this.queryOne<WordbookRow>(
      `SELECT * FROM wordbooks WHERE id = $1::uuid AND user_id = $2::uuid`,
      [wordbookId, userId],
    );
  }

  async findContextById(userId: string, contextId: string): Promise<L3ContextRow | null> {
    return this.queryOne<L3ContextRow>(
      `SELECT * FROM l3_contexts WHERE id = $1::uuid AND user_id = $2::uuid`,
      [contextId, userId],
    );
  }

  async findContextWithSourceById(
    userId: string,
    contextId: string,
  ): Promise<{ context: L3ContextRow; source: L3SourceRow } | null> {
    const row = await this.queryOne<JoinedContextWithSourceRow>(
      `SELECT
${CONTEXT_SOURCE_COLUMNS}
       FROM l3_contexts c
       JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id
       WHERE c.id = $1::uuid AND c.user_id = $2::uuid`,
      [contextId, userId],
    );
    return row ? { context: mapContext(row), source: mapSource(row) } : null;
  }

  async findWordById(wordId: string): Promise<WordRow | null> {
    return this.queryOne<WordRow>(
      `SELECT * FROM words WHERE id = $1::uuid AND is_deleted = false`,
      [wordId],
    );
  }

  async findWordBySlug(slug: string): Promise<WordRow | null> {
    return this.queryOne<WordRow>(
      `SELECT * FROM words WHERE slug = $1 AND is_deleted = false`,
      [slug],
    );
  }

  async findWordInWordbookById(wordbookId: string, wordId: string): Promise<WordRow | null> {
    return this.queryOne<WordRow>(
      `SELECT w.*
       FROM words w
       JOIN wordbook_items wi ON wi.word_id = w.id
       WHERE wi.wordbook_id = $1::uuid
         AND w.id = $2::uuid
         AND w.is_deleted = false`,
      [wordbookId, wordId],
    );
  }

  async findWordInWordbookBySlug(wordbookId: string, slug: string): Promise<WordRow | null> {
    return this.queryOne<WordRow>(
      `SELECT w.*
       FROM words w
       JOIN wordbook_items wi ON wi.word_id = w.id
       WHERE wi.wordbook_id = $1::uuid
         AND w.slug = $2
         AND w.is_deleted = false`,
      [wordbookId, slug],
    );
  }

  async listContextsForWord(input: L3WordLookup): Promise<L3PaginatedList<L3WordContextListItem>> {
    const cursor = decodeCursor(input.cursor);
    const params: unknown[] = [input.userId, input.limit + 1];
    let wordFilter = "";
    if (input.wordId) {
      params.push(input.wordId);
      wordFilter = `AND o.word_id = $${params.length}::uuid`;
    } else if (input.slug) {
      params.push(input.slug);
      wordFilter = `AND w.slug = $${params.length}`;
    }
    let cursorFilter = "";
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorFilter = cursorPredicate(params.length);
    }

    const rows = await this.query<JoinedContextRow>(
      `WITH selected_contexts AS (
         SELECT c.id, c.created_at
         FROM l3_contexts c
         JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id
         WHERE c.user_id = $1::uuid
           AND s.user_id = $1::uuid
           AND EXISTS (
             SELECT 1
             FROM l3_occurrences o
             JOIN words w ON w.id = o.word_id
             WHERE o.context_id = c.id
               AND o.user_id = $1::uuid
               ${wordFilter}
           )
           ${cursorFilter}
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT $2
       )
       SELECT
${CONTEXT_SOURCE_COLUMNS},
         o.id AS occurrence_id, o.context_id AS occurrence_context_id, o.word_id,
         o.user_id AS occurrence_user_id, o.surface, o.lemma, o.start_offset,
         o.end_offset, o.confidence, o.evidence, o.bound_sense,
         o.created_at AS occurrence_created_at,
         COALESCE(
           (
             SELECT jsonb_agg(to_jsonb(l) ORDER BY l.created_at)
             FROM l3_context_links l
             WHERE l.user_id = $1::uuid
               AND (l.context_id = c.id OR l.word_id = o.word_id)
           ),
           '[]'::jsonb
         ) AS links
       FROM selected_contexts selected
       JOIN l3_contexts c ON c.id = selected.id
       JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id
       JOIN LATERAL (
         SELECT o.*
         FROM l3_occurrences o
         JOIN words w ON w.id = o.word_id
         WHERE o.context_id = c.id
           AND o.user_id = $1::uuid
           ${wordFilter}
         ORDER BY o.created_at ASC, o.id ASC
         LIMIT 1
       ) o ON true
       ORDER BY c.created_at DESC, c.id DESC`,
      params,
    );

    return buildWordPage(rows, input.limit, input.cursor);
  }

  async listContextsForSource(input: L3SourceLookup): Promise<L3PaginatedList<L3SourceContextListItem>> {
    const cursor = decodeCursor(input.cursor);
    const params: unknown[] = [input.userId, input.limit + 1, input.sourceId];
    let cursorFilter = "";
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorFilter = cursorPredicate(params.length);
    }

    const rows = await this.query<SourceContextRow>(
      `SELECT
${CONTEXT_SOURCE_COLUMNS},
${OCCURRENCES_AGG},
${LINKS_AGG}
       FROM l3_contexts c
       JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id
       WHERE c.user_id = $1::uuid
         AND s.user_id = $1::uuid
         AND c.source_id = $3::uuid
         ${cursorFilter}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT $2`,
      params,
    );

    return buildSourcePage(rows, input.limit, input.cursor);
  }

  async getContextDetail(userId: string, contextId: string): Promise<L3ContextDetail | null> {
    const row = await this.queryOne<ContextDetailRow>(
      `SELECT
${CONTEXT_SOURCE_COLUMNS},
${OCCURRENCES_AGG},
${LINKS_AGG}
       FROM l3_contexts c
       JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id
       WHERE c.id = $1::uuid AND c.user_id = $2::uuid`,
      [contextId, userId],
    );
    if (!row) return null;
    return {
      context: mapContext(row),
      source: mapSource(row),
      occurrences: row.occurrences ?? [],
      links: row.links ?? [],
    };
  }

  async getWordSpace(input: L3WordSpaceLookup): Promise<L3WordSpace | null> {
    const cursor = decodeCursor(input.cursor);
    const word = input.wordbookId
      ? await this.findWordInWordbookBySlug(input.wordbookId, input.slug)
      : await this.findWordBySlug(input.slug);
    if (!word) return null;
    const params: unknown[] = [input.userId, input.limit + 1, word.id];
    let wordbookFilter = "";
    if (input.wordbookId) {
      params.push(input.wordbookId);
      wordbookFilter = `AND s.wordbook_id = $${params.length}::uuid`;
    }
    let cursorFilter = "";
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorFilter = cursorPredicate(params.length);
    }
    const rows = await this.query<WordSpaceRow>(
      `SELECT
${CONTEXT_SOURCE_COLUMNS},
         w.id AS word_id, w.slug AS word_slug, w.title AS word_title,
         w.lemma AS word_lemma, w.pos AS word_pos, w.cefr AS word_cefr,
         w.ipa AS word_ipa, w.aliases AS word_aliases,
         w.short_definition AS word_short_definition,
         w.definition_md AS word_definition_md, w.body_md AS word_body_md,
         w.prototype_text AS word_prototype_text,
         w.examples AS word_examples, w.metadata AS word_metadata,
         w.source_path AS word_source_path, w.source_updated_at AS word_source_updated_at,
         w.content_hash AS word_content_hash, w.is_published AS word_is_published,
         w.is_deleted AS word_is_deleted, w.created_at AS word_created_at,
         w.updated_at AS word_updated_at,
${OCCURRENCES_AGG},
${LINKS_AGG}
       FROM l3_occurrences anchor
       JOIN words w ON w.id = anchor.word_id
       JOIN l3_contexts c ON c.id = anchor.context_id AND c.user_id = anchor.user_id
       JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id
       WHERE anchor.user_id = $1::uuid
         AND anchor.word_id = $3::uuid
         AND w.is_deleted = false
         ${wordbookFilter}
         ${cursorFilter}
       GROUP BY c.id, s.id, w.id
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT $2`,
      params,
    );
    const pageRows = rows.slice(0, input.limit);
    const contexts = pageRows.map((row) => mapContext(row));
    const sources = uniqueById(pageRows.map((row) => mapSource(row)));
    const occurrences = uniqueById(pageRows.flatMap((row) => row.occurrences ?? []));
    const links = uniqueById(pageRows.flatMap((row) => row.links ?? []));
    const last = pageRows[pageRows.length - 1];
    return {
      word: rows[0] ? mapWord(rows[0]) : word,
      contexts,
      sources,
      occurrences,
      links,
      stats: buildStats(sources, contexts, occurrences, links),
      limit: input.limit,
      cursor: input.cursor ?? null,
      nextCursor: rows.length > input.limit && last
        ? encodeCursor(last.context_created_at, last.context_id)
        : null,
    };
  }

  async getSourceSpace(input: L3SourceSpaceLookup): Promise<L3SourceSpace | null> {
    const source = await this.findSourceById(input.userId, input.sourceId);
    if (!source) return null;
    const page = await this.listContextsForSource(input);
    const contexts = page.items.map((item) => item.context);
    const occurrences = uniqueById(page.items.flatMap((item) => item.occurrences));
    const links = uniqueById(page.items.flatMap((item) => item.links));
    const wordIds = [...new Set(occurrences.map((o) => o.word_id))];
    const words = wordIds.length
      ? await this.query<{ id: string; slug: string; title: string; short_definition: string | null }>(
          `SELECT id, slug, title, short_definition FROM words WHERE id = ANY($1::uuid[])`,
          [wordIds],
        )
      : [];
    return {
      source,
      contexts,
      occurrences,
      links,
      words,
      stats: buildStats([source], contexts, occurrences, links),
      limit: page.limit,
      cursor: page.cursor,
      nextCursor: page.nextCursor,
    };
  }

  async getGraph(input: L3GraphLookup): Promise<L3GraphReadModel> {
    const cursor = decodeCursor(input.cursor);
    const params: unknown[] = [input.userId, input.limit + 1];
    let sourceFilter = "";
    if (input.sourceId) {
      params.push(input.sourceId);
      sourceFilter = `AND s.id = $${params.length}::uuid`;
    }
    let wordbookFilter = "";
    if (input.wordbookId) {
      params.push(input.wordbookId);
      wordbookFilter = `AND s.wordbook_id = $${params.length}::uuid`;
    }
    let slugFilter = "";
    if (input.slug) {
      params.push(input.slug);
      slugFilter = `AND EXISTS (
        SELECT 1 FROM l3_occurrences so
        JOIN words sw ON sw.id = so.word_id
        WHERE so.context_id = c.id
          AND so.user_id = c.user_id
          AND sw.slug = $${params.length}
          AND sw.is_deleted = false
      )`;
    }
    let cursorFilter = "";
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorFilter = cursorPredicate(params.length);
    }

    const rows = await this.query<GraphContextRow>(
      `SELECT
${CONTEXT_SOURCE_COLUMNS},
${OCCURRENCES_AGG},
${LINKS_AGG}
       FROM l3_contexts c
       JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id
       WHERE c.user_id = $1::uuid
         AND s.user_id = $1::uuid
         ${sourceFilter}
         ${wordbookFilter}
         ${slugFilter}
         ${cursorFilter}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT $2`,
      params,
    );
    const pageRows = rows.slice(0, input.limit);
    const contexts = pageRows.map((row) => mapContext(row));
    const sources = uniqueById(pageRows.map((row) => mapSource(row)));
    const occurrences = uniqueById(pageRows.flatMap((row) => row.occurrences ?? []));
    const links = uniqueById(pageRows.flatMap((row) => row.links ?? []));
    const last = pageRows[pageRows.length - 1];
    return {
      nodes: [],
      edges: [],
      stats: { ...buildStats(sources, contexts, occurrences, links), nodeCount: 0, edgeCount: 0 },
      limit: input.limit,
      cursor: input.cursor ?? null,
      nextCursor: rows.length > input.limit && last
        ? encodeCursor(last.context_created_at, last.context_id)
        : null,
      metadata: { sources, contexts, occurrences, links } as unknown as Json,
    };
  }
}
