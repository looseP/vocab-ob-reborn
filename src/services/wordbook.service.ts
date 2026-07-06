/**
 * WordbookService — wordbook management.
 *
 * Business logic:
 * - Create wordbook (with default enforcement)
 * - Get or create default wordbook
 * - Add words to wordbook
 * - List wordbooks for user
 */

import type { IWordbookRepository } from "../repositories/interfaces";
import type { WordbookRow } from "../domain";
import { Wordbook } from "../domain/wordbook.entity";
import { BusinessRuleError } from "../errors";

export interface CreateWordbookParams {
  userId: string;
  name: string;
  description?: string;
  isDefault?: boolean;
}

export class WordbookService {
  constructor(private readonly wordbooks: IWordbookRepository) {}

  async create(params: CreateWordbookParams): Promise<Wordbook> {
    if (!params.name || params.name.trim().length === 0) {
      throw new BusinessRuleError("Wordbook name cannot be empty");
    }

    // If creating a default, check no existing default
    if (params.isDefault) {
      const existing = await this.wordbooks.findDefaultByUser(params.userId);
      if (existing) {
        throw new BusinessRuleError("User already has a default wordbook");
      }
    }

    const row = await this.wordbooks.create(
      params.userId,
      params.name,
      params.isDefault ?? false,
    );
    return new Wordbook(row);
  }

  async getOrCreateDefault(userId: string): Promise<Wordbook> {
    const row = await this.wordbooks.getOrCreateDefault(userId);
    return new Wordbook(row);
  }

  async findAllByUser(userId: string): Promise<Wordbook[]> {
    const rows = await this.wordbooks.findAllByUser(userId);
    return rows.map((r) => new Wordbook(r));
  }

  async findById(id: string): Promise<Wordbook | null> {
    const row = await this.wordbooks.findById(id);
    return row ? new Wordbook(row) : null;
  }

  async addWords(wordbookId: string, wordIds: string[]): Promise<void> {
    if (wordIds.length === 0) return;
    await this.wordbooks.addWords(wordbookId, wordIds);
  }

  async getWordCount(wordbookId: string): Promise<number> {
    return this.wordbooks.countWords(wordbookId);
  }
}
