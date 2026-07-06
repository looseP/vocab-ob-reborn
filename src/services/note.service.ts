/**
 * NoteService — note CRUD with versioning.
 *
 * M4 fix: upsertNote wraps the entire upsert + revision flow in a
 * transaction, ensuring version increment and revision creation are atomic.
 */

import type { INoteRepository, IWordbookRepository } from "../repositories/interfaces";
import type { NoteRevisionRow } from "../domain";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../index";
import { NotFoundError } from "../errors";

export interface UpsertNoteParams {
  userId: string;
  wordId: string;
  contentMd: string;
  wordbookId?: string;
}

export interface UpsertNoteResult {
  ok: boolean;
  updatedAt: string;
  version: number;
}

export class NoteService {
  constructor(
    private readonly notes: INoteRepository,
    private readonly wordbooks: IWordbookRepository,
  ) {}

  async getNote(
    userId: string,
    wordId: string,
    wordbookId: string,
  ): Promise<{ contentMd: string; updatedAt: string | null; version: number }> {
    const note = await this.notes.findByWord(userId, wordbookId, wordId);
    return {
      contentMd: note?.content_md ?? "",
      updatedAt: note?.updated_at ?? null,
      version: note?.version ?? 0,
    };
  }

  /**
   * M4 fix: wrap in transaction so upsert + revision are atomic.
   */
  async upsertNote(params: UpsertNoteParams): Promise<UpsertNoteResult> {
    const { userId, wordId, contentMd } = params;
    const wordbookId = params.wordbookId
      ?? (await this.wordbooks.getOrCreateDefault(userId)).id;

    return withTransaction(async (tx) => {
      // M4 fix: use tx-bound repos so upsert + revision share the same connection
      const repos = createRepositories(tx);
      const result = await repos.notes.upsert(userId, wordbookId, wordId, contentMd);
      return {
        ok: true,
        updatedAt: result.note.updated_at,
        version: result.note.version,
      };
    });
  }

  async getRevisions(
    userId: string,
    wordId: string,
    wordbookId: string,
  ): Promise<NoteRevisionRow[]> {
    return this.notes.findRevisions(userId, wordbookId, wordId);
  }

  async restoreRevision(
    userId: string,
    wordId: string,
    wordbookId: string,
    revisionId: string,
  ): Promise<UpsertNoteResult> {
    const revisions = await this.notes.findRevisions(userId, wordbookId, wordId);
    const target = revisions.find((r) => r.id === revisionId);
    if (!target) {
      throw new NotFoundError("NoteRevision", revisionId);
    }
    return this.upsertNote({
      userId,
      wordId,
      contentMd: target.content_md,
      wordbookId,
    });
  }
}
