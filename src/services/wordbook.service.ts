/**
 * WordbookService — wordbook management.
 *
 * Business logic:
 * - Create wordbook (with default enforcement)
 * - Get or create default wordbook
 * - Add words to wordbook
 * - List wordbooks for user
 */

import type { PoolClient } from "pg";
import type { IRepositories, IWordbookRepository } from "../repositories/interfaces";
import { Wordbook } from "../domain/wordbook.entity";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import { BusinessRuleError } from "../errors";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

export interface CreateWordbookParams {
  userId: string;
  name: string;
  description?: string;
  isDefault?: boolean;
}

export class WordbookService {
  constructor(
    private readonly wordbooks: IWordbookRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  private withActorWordbooks<T>(
    userId: string,
    callback: (wordbooks: IWordbookRepository) => Promise<T>,
  ): Promise<T> {
    return this.txRunner(
      async (tx) => callback(this.repositoryFactory(tx).wordbooks),
      { actorId: userId },
    );
  }

  async create(params: CreateWordbookParams): Promise<Wordbook> {
    if (!params.name || params.name.trim().length === 0) {
      throw new BusinessRuleError("Wordbook name cannot be empty");
    }

    return this.withActorWordbooks(params.userId, async (wordbooks) => {
      // If creating a default, check no existing default in the same actor transaction.
      if (params.isDefault) {
        const existing = await wordbooks.findDefaultByUser(params.userId);
        if (existing) {
          throw new BusinessRuleError("User already has a default wordbook");
        }
      }

      const row = await wordbooks.create(
        params.userId,
        params.name,
        params.isDefault ?? false,
        params.description?.trim() || null,
      );
      return new Wordbook(row);
    });
  }

  async getOrCreateDefault(userId: string): Promise<Wordbook> {
    return this.withActorWordbooks(userId, async (wordbooks) => {
      const row = await wordbooks.getOrCreateDefault(userId);
      return new Wordbook(row);
    });
  }

  async findAllByUser(userId: string): Promise<Wordbook[]> {
    return this.withActorWordbooks(userId, async (wordbooks) => {
      const rows = await wordbooks.findAllByUser(userId);
      return rows.map((r) => new Wordbook(r));
    });
  }

  async findById(userId: string, id: string): Promise<Wordbook | null> {
    return this.withActorWordbooks(userId, async (wordbooks) => {
      const row = await wordbooks.findById(id);
      return row ? new Wordbook(row) : null;
    });
  }

  async addWords(userId: string, wordbookId: string, wordIds: string[]): Promise<void> {
    if (wordIds.length === 0) return;
    await this.withActorWordbooks(
      userId,
      (wordbooks) => wordbooks.addWords(wordbookId, wordIds),
    );
  }

  async getWordCount(userId: string, wordbookId: string): Promise<number> {
    return this.withActorWordbooks(
      userId,
      (wordbooks) => wordbooks.countWords(wordbookId),
    );
  }
}
