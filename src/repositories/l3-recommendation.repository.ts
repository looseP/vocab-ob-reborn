/**
 * L3RecommendationRepository - auditable recommendation persistence.
 *
 * Recommendation writes are limited to l3_recommendation_* tables. Signal reads
 * may inspect L1/L2/L3 state but never update learning progress or active L3.
 */

import type {
  L3PaginatedList,
  L3RecommendationItemRow,
  L3RecommendationRunRow,
} from "../domain";
import { ValidationError } from "../errors";
import type {
  IL3RecommendationRepository,
  L3RecommendationLinkGapCandidate,
  L3RecommendationLookup,
  L3RecommendationSignal,
  L3RecommendationSignalLookup,
  NewL3RecommendationItem,
  NewL3RecommendationRun,
} from "./interfaces";
import { BaseRepository } from "./base";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string" &&
      UUID_RE.test(parsed.id) &&
      !Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    throw new ValidationError("Invalid pagination cursor", "cursor");
  }
  throw new ValidationError("Invalid pagination cursor", "cursor");
}

function buildPage(
  rows: L3RecommendationItemRow[],
  limit: number,
  cursor: string | null | undefined,
): L3PaginatedList<L3RecommendationItemRow> {
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows,
    limit,
    cursor: cursor ?? null,
    nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

export class L3RecommendationRepository extends BaseRepository implements IL3RecommendationRepository {
  async createRun(input: NewL3RecommendationRun): Promise<L3RecommendationRunRow> {
    const row = await this.queryOne<L3RecommendationRunRow>(
      `INSERT INTO l3_recommendation_runs
         (user_id, wordbook_id, mode, status, input_hash, stats, completed_at)
       VALUES ($1::uuid, $2::uuid, $3, COALESCE($4, 'completed'), $5, $6::jsonb, now())
       RETURNING *`,
      [
        input.user_id,
        input.wordbook_id ?? null,
        input.mode,
        input.status ?? null,
        input.input_hash ?? null,
        JSON.stringify(input.stats ?? {}),
      ],
    );
    if (!row) throw new Error("L3 recommendation run insert returned no row");
    return row;
  }

  async createItem(input: NewL3RecommendationItem): Promise<L3RecommendationItemRow> {
    const row = await this.queryOne<L3RecommendationItemRow>(
      `INSERT INTO l3_recommendation_items
         (run_id, user_id, wordbook_id, recommendation_type, status, title, summary,
          priority_score, confidence, reason_codes, evidence, payload, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, COALESCE($5, 'pending'), $6, $7,
               $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::timestamptz)
       RETURNING *`,
      [
        input.run_id,
        input.user_id,
        input.wordbook_id ?? null,
        input.recommendation_type,
        input.status ?? null,
        input.title,
        input.summary,
        input.priority_score,
        input.confidence,
        JSON.stringify(input.reason_codes),
        JSON.stringify(input.evidence),
        JSON.stringify(input.payload),
        input.expires_at ?? null,
      ],
    );
    if (!row) throw new Error("L3 recommendation item insert returned no row");
    return row;
  }

  async listItems(input: L3RecommendationLookup): Promise<L3PaginatedList<L3RecommendationItemRow>> {
    const cursor = decodeCursor(input.cursor);
    const params: unknown[] = [input.userId, input.limit + 1];
    let statusFilter = "";
    if (input.status) {
      params.push(input.status);
      statusFilter = `AND status = $${params.length}`;
    }
    let typeFilter = "";
    if (input.recommendationType) {
      params.push(input.recommendationType);
      typeFilter = `AND recommendation_type = $${params.length}`;
    }
    let cursorFilter = "";
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorFilter = `AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    const rows = await this.query<L3RecommendationItemRow>(
      `SELECT * FROM l3_recommendation_items
       WHERE user_id = $1::uuid
         ${statusFilter}
         ${typeFilter}
         ${cursorFilter}
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      params,
    );
    return buildPage(rows, input.limit, input.cursor);
  }

  async findItemByIdForUser(userId: string, itemId: string): Promise<L3RecommendationItemRow | null> {
    return this.queryOne<L3RecommendationItemRow>(
      `SELECT * FROM l3_recommendation_items WHERE id = $1::uuid AND user_id = $2::uuid`,
      [itemId, userId],
    );
  }

  async lockItemByIdForUser(userId: string, itemId: string): Promise<L3RecommendationItemRow | null> {
    this.requireTx();
    return this.queryOne<L3RecommendationItemRow>(
      `SELECT * FROM l3_recommendation_items WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
      [itemId, userId],
    );
  }

  async markItemStatus(
    itemId: string,
    userId: string,
    status: string,
    acceptedProposalId: string | null = null,
  ): Promise<L3RecommendationItemRow> {
    const acceptedExpr = status === "accepted" ? "now()" : "accepted_at";
    const rejectedExpr = status === "rejected" ? "now()" : "rejected_at";
    const dismissedExpr = status === "dismissed" ? "now()" : "dismissed_at";
    const row = await this.queryOne<L3RecommendationItemRow>(
      `UPDATE l3_recommendation_items
       SET status = $3,
           accepted_proposal_id = COALESCE($4::uuid, accepted_proposal_id),
           accepted_at = ${acceptedExpr},
           rejected_at = ${rejectedExpr},
           dismissed_at = ${dismissedExpr},
           updated_at = now()
       WHERE id = $1::uuid AND user_id = $2::uuid
       RETURNING *`,
      [itemId, userId, status, acceptedProposalId],
    );
    if (!row) throw new Error("L3 recommendation status update returned no row");
    return row;
  }

  async findSignals(input: L3RecommendationSignalLookup): Promise<L3RecommendationSignal[]> {
    const params: unknown[] = [input.userId, input.horizonDays, input.limit];
    let wordbookFilter = "";
    if (input.wordbookId) {
      params.push(input.wordbookId);
      wordbookFilter = `AND wi.wordbook_id = $${params.length}::uuid`;
    }
    let seedFilter = "";
    if (input.seedSlug) {
      params.push(input.seedSlug);
      seedFilter = `AND (
        w.slug = $${params.length}
        OR EXISTS (
          SELECT 1
          FROM l3_occurrences so
          JOIN l3_occurrences oo ON oo.context_id = so.context_id AND oo.user_id = so.user_id
          JOIN words sw ON sw.id = so.word_id
          WHERE sw.slug = $${params.length}
            AND oo.word_id = w.id
            AND oo.user_id = $1::uuid
        )
      )`;
    }
    return this.query<L3RecommendationSignal>(
      `SELECT
         w.id AS word_id,
         w.slug,
         w.title,
         uwp.due_at,
         uwp.state,
         uwp.retrievability,
         uwp.l1_weak_signal,
         uwp.review_count,
         l2.l2_retrievability,
         l2.l2_due_at,
         l2.l2_review_count,
         l2.l2_paused,
         COALESCE(l2_fields.fields, ARRAY[]::text[]) AS l2_fields,
         COALESCE(l3_counts.context_count, 0) AS l3_context_count,
         COALESCE(l3_counts.occurrence_count, 0) AS l3_occurrence_count,
         COALESCE(l3_counts.link_count, 0) AS l3_link_count,
         COALESCE(graph_counts.neighbor_count, 0) AS graph_neighbor_count
       FROM wordbook_items wi
       JOIN wordbooks wb ON wb.id = wi.wordbook_id AND wb.user_id = $1::uuid
       JOIN words w ON w.id = wi.word_id AND w.is_deleted = false
       LEFT JOIN user_word_progress uwp
         ON uwp.user_id = $1::uuid AND uwp.wordbook_id = wi.wordbook_id AND uwp.word_id = w.id
       LEFT JOIN user_word_l2_progress l2
         ON l2.user_id = $1::uuid AND l2.wordbook_id = wi.wordbook_id AND l2.word_id = w.id
       LEFT JOIN LATERAL (
         SELECT ARRAY_AGG(DISTINCT field) AS fields
         FROM word_l2_content c
         WHERE c.word_id = w.id AND c.is_active = true
       ) l2_fields ON true
       LEFT JOIN LATERAL (
         SELECT
           COUNT(DISTINCT o.context_id) AS context_count,
           COUNT(DISTINCT o.id) AS occurrence_count,
           COUNT(DISTINCT l.id) AS link_count
         FROM l3_occurrences o
         JOIN l3_contexts c ON c.id = o.context_id AND c.user_id = o.user_id
         JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id
         LEFT JOIN l3_context_links l
           ON l.user_id = o.user_id AND (l.word_id = o.word_id OR l.context_id = o.context_id)
         WHERE o.user_id = $1::uuid
           AND o.word_id = w.id
           AND (s.wordbook_id IS NULL OR s.wordbook_id = wi.wordbook_id)
       ) l3_counts ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT l.id) AS neighbor_count
         FROM l3_context_links l
         WHERE l.user_id = $1::uuid
           AND (l.word_id = w.id OR l.target_id = w.id::text)
       ) graph_counts ON true
       WHERE wb.user_id = $1::uuid
         ${wordbookFilter}
         ${seedFilter}
         AND (
           uwp.due_at IS NULL
           OR uwp.due_at <= now() + ($2::int * interval '1 day')
           OR uwp.l1_weak_signal = true
           OR l2.l2_retrievability IS NULL
           OR l3_counts.context_count = 0
         )
       ORDER BY
         uwp.l1_weak_signal DESC NULLS LAST,
         uwp.due_at ASC NULLS LAST,
         l2.l2_retrievability ASC NULLS LAST,
         l3_counts.context_count ASC,
         w.slug ASC
       LIMIT $3`,
      params,
    );
  }

  async findLinkGapCandidates(input: L3RecommendationSignalLookup): Promise<L3RecommendationLinkGapCandidate[]> {
    const params: unknown[] = [input.userId, input.limit];
    let wordbookFilter = "";
    if (input.wordbookId) {
      params.push(input.wordbookId);
      wordbookFilter = `AND s.wordbook_id = $${params.length}::uuid`;
    }
    return this.query<L3RecommendationLinkGapCandidate>(
      `SELECT
         c.id AS context_id,
         s.id AS source_id,
         LEAST(w1.id::text, w2.id::text)::uuid AS word_id,
         CASE WHEN w1.id::text <= w2.id::text THEN w1.slug ELSE w2.slug END AS word_slug,
         GREATEST(w1.id::text, w2.id::text)::uuid AS target_word_id,
         CASE WHEN w1.id::text > w2.id::text THEN w1.slug ELSE w2.slug END AS target_word_slug,
         COUNT(*) AS cooccurrence_count
       FROM l3_contexts c
       JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id
       JOIN l3_occurrences o1 ON o1.context_id = c.id AND o1.user_id = c.user_id
       JOIN l3_occurrences o2 ON o2.context_id = c.id AND o2.user_id = c.user_id AND o2.word_id > o1.word_id
       JOIN words w1 ON w1.id = o1.word_id AND w1.is_deleted = false
       JOIN words w2 ON w2.id = o2.word_id AND w2.is_deleted = false
       WHERE c.user_id = $1::uuid
         ${wordbookFilter}
          AND NOT EXISTS (
            SELECT 1 FROM l3_context_links l
            WHERE l.user_id = c.user_id
              AND l.target_type = 'word'
              AND (
                (l.word_id = o1.word_id AND l.target_id = o2.word_id::text)
                OR (l.word_id = o2.word_id AND l.target_id = o1.word_id::text)
              )
          )
       GROUP BY c.id, s.id, w1.id, w1.slug, w2.id, w2.slug
       ORDER BY cooccurrence_count DESC, word_slug ASC, target_word_slug ASC
       LIMIT $2`,
      params,
    );
  }
}
