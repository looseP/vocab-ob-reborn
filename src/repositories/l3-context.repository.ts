/**
 * L3ContextRepository — isolated context-space persistence.
 *
 * L3 writes only l3_* tables. It links to words through occurrences/links but
 * never writes words JSONB, word_l2_content, or review progress state.
 */

import type {
  Direction,
  L3ContextLinkListItem,
  L3ContextLinkRow,
  L3ContextRow,
  L3ContextDetail,
  L3GraphReadModel,
  L3ImportJobRow,
  L3OccurrenceListItem,
  L3OccurrenceRow,
  L3PaginatedList,
  L3ReadStats,
  L3SourceContextListItem,
  L3SourceRow,
  L3SourceListPage,
  L3SourceSpace,
  L3SpaceSummaryDay,
  L3SubSpace,
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
  L3ContextLinkLookup,
  L3GraphLookup,
  L3OccurrenceLookup,
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

interface OccurrenceEvidenceRow extends JoinedContextWithSourceRow {
  occ_id: string;
  occ_context_id: string;
  occ_word_id: string;
  occ_user_id: string;
  occ_surface: string;
  occ_lemma: string | null;
  occ_start_offset: number | null;
  occ_end_offset: number | null;
  occ_confidence: number | string | null;
  occ_evidence: unknown;
  occ_bound_sense: string | null;
  occ_created_at: string;
  word_slug: string;
  word_title: string;
}

interface ContextLinkEvidenceRow extends JoinedContextWithSourceRow {
  link_id: string;
  link_user_id: string;
  link_context_id: string | null;
  link_word_id: string | null;
  link_type: string;
  target_type: string;
  target_id: string | null;
  target_ref: unknown;
  link_confidence: number | string | null;
  link_provenance: unknown;
  link_created_at: string;
  word_slug: string | null;
  word_title: string | null;
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

function mapOccurrenceEvidenceRow(row: OccurrenceEvidenceRow): L3OccurrenceListItem {
  return {
    occurrence: {
      id: row.occ_id,
      context_id: row.occ_context_id,
      word_id: row.occ_word_id,
      user_id: row.occ_user_id,
      surface: row.occ_surface,
      lemma: row.occ_lemma,
      start_offset: row.occ_start_offset,
      end_offset: row.occ_end_offset,
      confidence: row.occ_confidence,
      evidence: (row.occ_evidence ?? {}) as never,
      bound_sense: row.occ_bound_sense,
      created_at: row.occ_created_at,
    },
    word: { id: row.occ_word_id, slug: row.word_slug, title: row.word_title },
    context: mapContext(row),
    source: mapSource(row),
  };
}

function buildOccurrencePage(
  rows: OccurrenceEvidenceRow[],
  limit: number,
  cursor: string | null | undefined,
): L3PaginatedList<L3OccurrenceListItem> {
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map(mapOccurrenceEvidenceRow);
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    limit,
    cursor: cursor ?? null,
    nextCursor: rows.length > limit && last ? encodeCursor(last.occ_created_at, last.occ_id) : null,
  };
}

function mapContextLinkEvidenceRow(row: ContextLinkEvidenceRow): L3ContextLinkListItem {
  const context = row.link_context_id != null ? mapContext(row) : null;
  return {
    link: {
      id: row.link_id,
      user_id: row.link_user_id,
      context_id: row.link_context_id,
      word_id: row.link_word_id,
      link_type: row.link_type as never,
      target_type: row.target_type as never,
      target_id: row.target_id,
      target_ref: (row.target_ref ?? {}) as never,
      confidence: row.link_confidence,
      provenance: (row.link_provenance ?? {}) as never,
      created_at: row.link_created_at,
    },
    word: row.link_word_id != null
      ? { id: row.link_word_id, slug: row.word_slug ?? "", title: row.word_title ?? "" }
      : null,
    context,
    source: context ? mapSource(row) : null,
  };
}

function buildContextLinkPage(
  rows: ContextLinkEvidenceRow[],
  limit: number,
  cursor: string | null | undefined,
): L3PaginatedList<L3ContextLinkListItem> {
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map(mapContextLinkEvidenceRow);
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    limit,
    cursor: cursor ?? null,
    nextCursor: rows.length > limit && last ? encodeCursor(last.link_created_at, last.link_id) : null,
  };
}

export class L3ContextRepository extends BaseRepository implements IL3ContextRepository {
  async createSource(input: NewL3Source, spaces?: readonly string[]): Promise<L3SourceRow> {
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
    // V0 接通子空间死轴：与来源插入同一事务（调用方 txRunner），junction 唯一约束防重复。
    if (spaces && spaces.length > 0) {
      await this.query(
        `INSERT INTO l3_source_spaces (source_id, user_id, space)
         SELECT $2::uuid, $1::uuid, sp FROM unnest($3::text[]) AS sp
         ON CONFLICT (source_id, space) DO NOTHING`,
        [input.user_id, row.id, spaces],
      );
    }
    return row;
  }

  async replaceSourceSpaces(
    userId: string,
    sourceId: string,
    spaces: readonly string[],
  ): Promise<void> {
    // 全量替换：事务内先删后插（调用方须已校验来源归属）；空数组 = 清空标签。
    await this.query(
      `DELETE FROM l3_source_spaces WHERE source_id = $1::uuid AND user_id = $2::uuid`,
      [sourceId, userId],
    );
    if (spaces.length > 0) {
      await this.query(
        `INSERT INTO l3_source_spaces (source_id, user_id, space)
         SELECT $1::uuid, $2::uuid, sp FROM unnest($3::text[]) AS sp
         ON CONFLICT (source_id, space) DO NOTHING`,
        [sourceId, userId, [...new Set(spaces)]],
      );
    }
  }

  async ensureSourceSpaces(
    userId: string,
    sourceId: string,
    spaces: readonly string[],
  ): Promise<void> {
    if (spaces.length === 0) return;
    // 只增不删：录题/建卷按题型自动补能力域标签，保留来源既有标签（幂等）。
    await this.query(
      `INSERT INTO l3_source_spaces (source_id, user_id, space)
       SELECT $1::uuid, $2::uuid, sp FROM unnest($3::text[]) AS sp
       ON CONFLICT (source_id, space) DO NOTHING`,
      [sourceId, userId, [...new Set(spaces)]],
    );
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

  /** 批量取源（ADR-0037）：待录核对面要按锚点算原文切片，逐题查会 N+1。 */
  async findSourcesByIds(userId: string, sourceIds: readonly string[]): Promise<L3SourceRow[]> {
    const unique = [...new Set(sourceIds)];
    if (unique.length === 0) return [];
    return this.query<L3SourceRow>(
      `SELECT * FROM l3_sources WHERE user_id = $1::uuid AND id = ANY($2::uuid[])`,
      [userId, unique],
    );
  }

  async findSourceByContentHash(userId: string, contentHash: string): Promise<L3SourceRow | null> {
    return this.queryOne<L3SourceRow>(
      `SELECT * FROM l3_sources WHERE user_id = $1::uuid AND content_hash = $2 LIMIT 1`,
      [userId, contentHash],
    );
  }

  async listSources(input: {
    userId: string; sourceType?: string; q?: string; sort: "recent" | "captures";
    direction?: Direction | null; space?: L3SubSpace | null; limit: number; offset: number;
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
    // ADR-0029 §6②：两轴过滤（与练习线 errorBook 同款 SQL 模式）。
    if (input.direction) {
      params.push(input.direction);
      where += ` AND s.direction = $${params.length}`;
    }
    if (input.space) {
      params.push(input.space);
      where += ` AND EXISTS (SELECT 1 FROM l3_source_spaces sp
                              WHERE sp.source_id = s.id AND sp.user_id = s.user_id AND sp.space = $${params.length})`;
    }
    const orderBy = input.sort === "captures"
      ? `context_count DESC NULLS LAST, s.created_at DESC`
      : `s.created_at DESC`;
    const rows = await this.query<{ id: string; title: string; source_type: string; url: string | null; created_at: string; context_count: string; spaces: string[] | null }>(
      `SELECT s.id, s.title, s.source_type, s.url, s.created_at,
              (SELECT count(*) FROM l3_contexts c WHERE c.source_id = s.id AND c.user_id = s.user_id) AS context_count,
              COALESCE((SELECT array_agg(sp.space ORDER BY sp.space)
                          FROM l3_source_spaces sp
                         WHERE sp.source_id = s.id AND sp.user_id = s.user_id), ARRAY[]::text[]) AS spaces
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
      items: rows.map((r) => ({
        ...r,
        context_count: Number(r.context_count),
        // CHECK 已约束枚举；pg 驱动仅给 string[]，此处收窄到 L3SubSpace。
        spaces: (Array.isArray(r.spaces) ? r.spaces : []) as L3SubSpace[],
      })),
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
    // ADR-0029 §6②：两轴过滤（尾随缩进与 cursorFilter 行对齐，空串时 SQL 字节不变）。
    let axisFilter = "";
    if (input.direction) {
      params.push(input.direction);
      axisFilter += `AND s.direction = $${params.length}\n           `;
    }
    if (input.space) {
      params.push(input.space);
      axisFilter += `AND EXISTS (SELECT 1 FROM l3_source_spaces sp\n             WHERE sp.source_id = s.id AND sp.user_id = s.user_id AND sp.space = $${params.length})\n           `;
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
           ${axisFilter}${cursorFilter}
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

  /** ADR-0029 §6①：occurrence 只读列表（cursor 分页 + 词 / 语境 / 两轴过滤）。 */
  async listOccurrences(input: L3OccurrenceLookup): Promise<L3PaginatedList<L3OccurrenceListItem>> {
    const cursor = decodeCursor(input.cursor);
    const params: unknown[] = [input.userId, input.limit + 1];
    let wordFilter = "";
    if (input.wordId) {
      params.push(input.wordId);
      wordFilter = ` AND o.word_id = $${params.length}::uuid`;
    } else if (input.slug) {
      params.push(input.slug);
      wordFilter = ` AND w.slug = $${params.length}`;
    }
    let contextFilter = "";
    if (input.contextId) {
      params.push(input.contextId);
      contextFilter = ` AND o.context_id = $${params.length}::uuid`;
    }
    let axisFilter = "";
    if (input.direction) {
      params.push(input.direction);
      axisFilter += ` AND s.direction = $${params.length}`;
    }
    if (input.space) {
      params.push(input.space);
      axisFilter += ` AND EXISTS (SELECT 1 FROM l3_source_spaces sp
                              WHERE sp.source_id = s.id AND sp.user_id = s.user_id AND sp.space = $${params.length})`;
    }
    let cursorFilter = "";
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorFilter = ` AND (o.created_at, o.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }

    const rows = await this.query<OccurrenceEvidenceRow>(
      `SELECT
         o.id AS occ_id, o.context_id AS occ_context_id, o.word_id AS occ_word_id,
         o.user_id AS occ_user_id, o.surface AS occ_surface, o.lemma AS occ_lemma,
         o.start_offset AS occ_start_offset, o.end_offset AS occ_end_offset,
         o.confidence AS occ_confidence, o.evidence AS occ_evidence,
         o.bound_sense AS occ_bound_sense, o.created_at AS occ_created_at,
         w.slug AS word_slug, w.title AS word_title,
${CONTEXT_SOURCE_COLUMNS}
       FROM l3_occurrences o
       JOIN words w ON w.id = o.word_id
       JOIN l3_contexts c ON c.id = o.context_id AND c.user_id = o.user_id
       JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id
       WHERE o.user_id = $1::uuid
         ${wordFilter}
         ${contextFilter}
         ${axisFilter}
         ${cursorFilter}
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT $2`,
      params,
    );

    return buildOccurrencePage(rows, input.limit, input.cursor);
  }

  /** ADR-0029 §6①：context-link 只读列表（cursor 分页 + 词 / 语境 / 类型 / 两轴过滤）。 */
  async listContextLinks(input: L3ContextLinkLookup): Promise<L3PaginatedList<L3ContextLinkListItem>> {
    const cursor = decodeCursor(input.cursor);
    const params: unknown[] = [input.userId, input.limit + 1];
    let wordFilter = "";
    if (input.wordId) {
      params.push(input.wordId);
      wordFilter = ` AND l.word_id = $${params.length}::uuid`;
    } else if (input.slug) {
      params.push(input.slug);
      wordFilter = ` AND w.slug = $${params.length}`;
    }
    let contextFilter = "";
    if (input.contextId) {
      params.push(input.contextId);
      contextFilter = ` AND l.context_id = $${params.length}::uuid`;
    }
    let typeFilter = "";
    if (input.linkType) {
      params.push(input.linkType);
      typeFilter += ` AND l.link_type = $${params.length}`;
    }
    if (input.targetType) {
      params.push(input.targetType);
      typeFilter += ` AND l.target_type = $${params.length}`;
    }
    let axisFilter = "";
    if (input.direction) {
      params.push(input.direction);
      axisFilter += ` AND s.direction = $${params.length}`;
    }
    if (input.space) {
      params.push(input.space);
      axisFilter += ` AND EXISTS (SELECT 1 FROM l3_source_spaces sp
                              WHERE sp.source_id = s.id AND sp.user_id = s.user_id AND sp.space = $${params.length})`;
    }
    let cursorFilter = "";
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorFilter = ` AND (l.created_at, l.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }

    const rows = await this.query<ContextLinkEvidenceRow>(
      `SELECT
         l.id AS link_id, l.user_id AS link_user_id, l.context_id AS link_context_id,
         l.word_id AS link_word_id, l.link_type, l.target_type, l.target_id,
         l.target_ref, l.confidence AS link_confidence, l.provenance AS link_provenance,
         l.created_at AS link_created_at,
         w.slug AS word_slug, w.title AS word_title,
${CONTEXT_SOURCE_COLUMNS}
       FROM l3_context_links l
       LEFT JOIN words w ON w.id = l.word_id
       LEFT JOIN l3_contexts c ON c.id = l.context_id AND c.user_id = l.user_id
       LEFT JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id
       WHERE l.user_id = $1::uuid
         ${wordFilter}
         ${contextFilter}
         ${typeFilter}
         ${axisFilter}
         ${cursorFilter}
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT $2`,
      params,
    );

    return buildContextLinkPage(rows, input.limit, input.cursor);
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

  /** B1 素材宇宙：四类实体全量计数（单往返四条 count，user-scoped，无过滤轴）。 */
  async getSpaceSummaryCounts(userId: string): Promise<L3ReadStats> {
    const row = await this.queryOne<{
      source_count: string;
      context_count: string;
      occurrence_count: string;
      link_count: string;
    }>(
      `SELECT
         (SELECT count(*) FROM l3_sources s WHERE s.user_id = $1::uuid) AS source_count,
         (SELECT count(*) FROM l3_contexts c WHERE c.user_id = $1::uuid) AS context_count,
         (SELECT count(*) FROM l3_occurrences o WHERE o.user_id = $1::uuid) AS occurrence_count,
         (SELECT count(*) FROM l3_context_links l WHERE l.user_id = $1::uuid) AS link_count`,
      [userId],
    );
    return {
      sourceCount: Number(row?.source_count ?? 0),
      contextCount: Number(row?.context_count ?? 0),
      occurrenceCount: Number(row?.occurrence_count ?? 0),
      linkCount: Number(row?.link_count ?? 0),
    };
  }

  /**
   * B1 素材宇宙：近 windowDays 天每日新增。
   *
   * 日界口径对齐 review/stats（Asia/Shanghai 显示时区，`db/timezone.ts`；
   * 沿用 `review.repository.getHeatmap` 的 `AT TIME ZONE` + `::date::text`
   * 先例）。窗口为滚动 N 天（now() - N days）——趋势图对首日边界精度不敏感。
   * 结果为稀疏行（仅含产生过新增的日期），升序；展示端按窗口补零。
   */
  async getSpaceGrowth(userId: string, windowDays: number): Promise<L3SpaceSummaryDay[]> {
    const rows = await this.query<{
      day: string;
      source_count: string;
      context_count: string;
      occurrence_count: string;
      link_count: string;
    }>(
      `SELECT day,
              sum(src)::text AS source_count,
              sum(ctx)::text AS context_count,
              sum(occ)::text AS occurrence_count,
              sum(lnk)::text AS link_count
         FROM (
           SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day, 1 AS src, 0 AS ctx, 0 AS occ, 0 AS lnk
             FROM l3_sources WHERE user_id = $1::uuid AND created_at >= now() - ($2 || ' days')::interval
           UNION ALL
           SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date::text, 0, 1, 0, 0
             FROM l3_contexts WHERE user_id = $1::uuid AND created_at >= now() - ($2 || ' days')::interval
           UNION ALL
           SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date::text, 0, 0, 1, 0
             FROM l3_occurrences WHERE user_id = $1::uuid AND created_at >= now() - ($2 || ' days')::interval
           UNION ALL
           SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date::text, 0, 0, 0, 1
             FROM l3_context_links WHERE user_id = $1::uuid AND created_at >= now() - ($2 || ' days')::interval
         ) t
        GROUP BY day
        ORDER BY day`,
      [userId, windowDays],
    );
    return rows.map((r) => ({
      day: r.day,
      sourceCount: Number(r.source_count),
      contextCount: Number(r.context_count),
      occurrenceCount: Number(r.occurrence_count),
      linkCount: Number(r.link_count),
    }));
  }
}
