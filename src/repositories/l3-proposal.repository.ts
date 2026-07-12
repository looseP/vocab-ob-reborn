/**
 * L3ProposalRepository - unreviewed L3 candidate persistence.
 *
 * Proposal writes are isolated from active l3_sources/contexts/occurrences/links.
 * Confirm logic can run inside a transaction through the shared repository factory.
 */

import type {
  L3PaginatedList,
  L3ProposalBundle,
  L3ProposalItemRow,
  L3ProposalRow,
} from "../domain";
import { ValidationError } from "../errors";
import type {
  IL3ProposalRepository,
  L3ProposalLookup,
  NewL3Proposal,
  NewL3ProposalItem,
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
  rows: L3ProposalRow[],
  limit: number,
  cursor: string | null | undefined,
): L3PaginatedList<L3ProposalRow> {
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows,
    limit,
    cursor: cursor ?? null,
    nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

export class L3ProposalRepository extends BaseRepository implements IL3ProposalRepository {
  async createProposal(input: NewL3Proposal): Promise<L3ProposalRow> {
    const row = await this.queryOne<L3ProposalRow>(
      `INSERT INTO l3_proposals
         (user_id, wordbook_id, source_type, status, title, summary, input_hash, proposed_by, provenance, review_note)
       VALUES ($1::uuid, $2::uuid, $3, COALESCE($4, 'pending'), $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING *`,
      [
        input.user_id,
        input.wordbook_id ?? null,
        input.source_type,
        input.status ?? null,
        input.title ?? null,
        input.summary ?? null,
        input.input_hash ?? null,
        input.proposed_by ?? null,
        JSON.stringify(input.provenance ?? {}),
        input.review_note ?? null,
      ],
    );
    if (!row) throw new Error("L3 proposal insert returned no row");
    return row;
  }

  async createProposalItem(input: NewL3ProposalItem): Promise<L3ProposalItemRow> {
    const row = await this.queryOne<L3ProposalItemRow>(
      `INSERT INTO l3_proposal_items
         (proposal_id, user_id, item_type, ordinal, payload, status, validation_errors)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, COALESCE($6, 'pending'), $7::jsonb)
       RETURNING *`,
      [
        input.proposal_id,
        input.user_id,
        input.item_type,
        input.ordinal,
        JSON.stringify(input.payload),
        input.status ?? null,
        JSON.stringify(input.validation_errors ?? []),
      ],
    );
    if (!row) throw new Error("L3 proposal item insert returned no row");
    return row;
  }

  async findProposalByIdForUser(userId: string, proposalId: string): Promise<L3ProposalRow | null> {
    return this.queryOne<L3ProposalRow>(
      `SELECT * FROM l3_proposals WHERE id = $1::uuid AND user_id = $2::uuid`,
      [proposalId, userId],
    );
  }

  async findProposalByInputHash(userId: string, inputHash: string): Promise<L3ProposalRow | null> {
    return this.queryOne<L3ProposalRow>(
      `SELECT * FROM l3_proposals
       WHERE user_id = $1::uuid AND input_hash = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, inputHash],
    );
  }

  async lockProposalByIdForUser(userId: string, proposalId: string): Promise<L3ProposalRow | null> {
    this.requireTx();
    return this.queryOne<L3ProposalRow>(
      `SELECT * FROM l3_proposals WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
      [proposalId, userId],
    );
  }

  async findProposalItems(userId: string, proposalId: string): Promise<L3ProposalItemRow[]> {
    return this.query<L3ProposalItemRow>(
      `SELECT * FROM l3_proposal_items
       WHERE proposal_id = $1::uuid AND user_id = $2::uuid
       ORDER BY ordinal ASC, id ASC`,
      [proposalId, userId],
    );
  }

  async getProposalBundle(userId: string, proposalId: string): Promise<L3ProposalBundle | null> {
    const proposal = await this.findProposalByIdForUser(userId, proposalId);
    if (!proposal) return null;
    const items = await this.findProposalItems(userId, proposalId);
    return { proposal, items };
  }

  async listProposals(input: L3ProposalLookup): Promise<L3PaginatedList<L3ProposalRow>> {
    const cursor = decodeCursor(input.cursor);
    const params: unknown[] = [input.userId, input.limit + 1];
    let statusFilter = "";
    if (input.status) {
      params.push(input.status);
      statusFilter = `AND status = $${params.length}`;
    }
    let cursorFilter = "";
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorFilter = `AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }

    const rows = await this.query<L3ProposalRow>(
      `SELECT * FROM l3_proposals
       WHERE user_id = $1::uuid
         ${statusFilter}
         ${cursorFilter}
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      params,
    );
    return buildPage(rows, input.limit, input.cursor);
  }

  async updateProposalItemValidation(
    itemId: string,
    userId: string,
    validationErrors: unknown,
  ): Promise<L3ProposalItemRow> {
    const row = await this.queryOne<L3ProposalItemRow>(
      `UPDATE l3_proposal_items
       SET validation_errors = $3::jsonb, updated_at = now()
       WHERE id = $1::uuid AND user_id = $2::uuid
       RETURNING *`,
      [itemId, userId, JSON.stringify(validationErrors)],
    );
    if (!row) throw new Error("L3 proposal item validation update returned no row");
    return row;
  }

  async markProposalItemConfirmed(
    itemId: string,
    userId: string,
    activeEntityType: string,
    activeEntityId: string,
  ): Promise<L3ProposalItemRow> {
    const row = await this.queryOne<L3ProposalItemRow>(
      `UPDATE l3_proposal_items
       SET status = 'confirmed',
           validation_errors = '[]'::jsonb,
           active_entity_type = $3,
           active_entity_id = $4::uuid,
           updated_at = now()
       WHERE id = $1::uuid AND user_id = $2::uuid
       RETURNING *`,
      [itemId, userId, activeEntityType, activeEntityId],
    );
    if (!row) throw new Error("L3 proposal item confirm update returned no row");
    return row;
  }

  async markProposalItemsRejected(proposalId: string, userId: string): Promise<void> {
    await this.query(
      `UPDATE l3_proposal_items
       SET status = 'rejected', updated_at = now()
       WHERE proposal_id = $1::uuid AND user_id = $2::uuid AND status = 'pending'`,
      [proposalId, userId],
    );
  }

  async markProposalConfirmed(
    proposalId: string,
    userId: string,
    reviewNote?: string | null,
  ): Promise<L3ProposalRow> {
    const row = await this.queryOne<L3ProposalRow>(
      `UPDATE l3_proposals
       SET status = 'confirmed',
           confirmed_at = now(),
           review_note = COALESCE($3, review_note),
           updated_at = now()
       WHERE id = $1::uuid AND user_id = $2::uuid
       RETURNING *`,
      [proposalId, userId, reviewNote ?? null],
    );
    if (!row) throw new Error("L3 proposal confirm update returned no row");
    return row;
  }

  async markProposalRejected(
    proposalId: string,
    userId: string,
    reviewNote?: string | null,
  ): Promise<L3ProposalRow> {
    const row = await this.queryOne<L3ProposalRow>(
      `UPDATE l3_proposals
       SET status = 'rejected',
           rejected_at = now(),
           review_note = $3,
           updated_at = now()
       WHERE id = $1::uuid AND user_id = $2::uuid
       RETURNING *`,
      [proposalId, userId, reviewNote ?? null],
    );
    if (!row) throw new Error("L3 proposal reject update returned no row");
    return row;
  }
}
