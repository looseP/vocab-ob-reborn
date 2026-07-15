/**
 * NoteService — note CRUD with versioning.
 *
 * M4 fix: upsertNote wraps the entire upsert + revision flow in a
 * transaction, ensuring version increment and revision creation are atomic.
 */

import type { PoolClient } from "pg";
import type { INoteRepository, IRepositories, IWordbookRepository } from "../repositories/interfaces";
import type { NoteRevisionRow } from "../domain";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import { NotFoundError } from "../errors";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

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
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  private withActorNotes<T>(
    userId: string,
    callback: (notes: INoteRepository) => Promise<T>,
  ): Promise<T> {
    return this.txRunner(
      async (tx) => callback(this.repositoryFactory(tx).notes),
      { actorId: userId },
    );
  }

  async getNote(
    userId: string,
    wordId: string,
    wordbookId: string,
  ): Promise<{ contentMd: string; updatedAt: string | null; version: number }> {
    return this.withActorNotes(userId, async (notes) => {
      const note = await notes.findByWord(userId, wordbookId, wordId);
      return {
        contentMd: note?.content_md ?? "",
        updatedAt: note?.updated_at ?? null,
        version: note?.version ?? 0,
      };
    });
  }

  /**
   * M4 fix: wrap in transaction so upsert + revision are atomic.
   * H-NEW-2 fix: getOrCreateDefault moved inside transaction callback.
   */
  async upsertNote(params: UpsertNoteParams): Promise<UpsertNoteResult> {
    const { userId, wordId, contentMd } = params;

    return this.txRunner(async (tx) => {
      // H-NEW-2 fix: getOrCreateDefault inside tx — if it creates a new
      // wordbook, that creation is atomic with the upsert
      const repos = this.repositoryFactory(tx);
      const wordbookId = params.wordbookId
        ?? (await repos.wordbooks.getOrCreateDefault(userId)).id;

      const result = await repos.notes.upsert(userId, wordbookId, wordId, contentMd);
      return {
        ok: true,
        updatedAt: result.note.updated_at,
        version: result.note.version,
      };
    }, { actorId: userId });
  }

  async getRevisions(
    userId: string,
    wordId: string,
    wordbookId: string,
  ): Promise<NoteRevisionRow[]> {
    return this.withActorNotes(
      userId,
      (notes) => notes.findRevisions(userId, wordbookId, wordId),
    );
  }

  async restoreRevision(
    userId: string,
    wordId: string,
    wordbookId: string,
    revisionId: string,
  ): Promise<UpsertNoteResult> {
    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const revisions = await repos.notes.findRevisions(
        userId,
        wordbookId,
        wordId,
      );
      const target = revisions.find((revision) => revision.id === revisionId);
      if (!target) {
        throw new NotFoundError("NoteRevision", revisionId);
      }
      const result = await repos.notes.upsert(
        userId,
        wordbookId,
        wordId,
        target.content_md,
      );
      return {
        ok: true,
        updatedAt: result.note.updated_at,
        version: result.note.version,
      };
    }, { actorId: userId });
  }
}
