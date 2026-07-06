/**
 * WordService — word listing, search, and detail retrieval.
 *
 * M1 fix: getWordBySlug uses NotFoundError (AppError subclass) instead
 * of an anonymous Error class, so errorToResponse correctly maps to 404.
 */

import type { IWordRepository } from "../repositories/interfaces";
import type { PaginatedResult, WordSummary } from "../domain";
import { Word } from "../domain/word.entity";
import { NotFoundError } from "../errors";

export interface GetWordsParams {
  q?: string;
  freq?: string;
  semantic?: string;
  review?: string;
  wordbookId?: string;
  limit: number;
  offset: number;
}

export class WordService {
  constructor(private readonly words: IWordRepository) {}

  async getPublicWords(params: GetWordsParams): Promise<PaginatedResult<WordSummary>> {
    return this.words.findPublic({
      filters: {
        q: params.q,
        freq: params.freq,
        semantic: params.semantic,
        review: params.review,
      },
      pagination: { limit: params.limit, offset: params.offset },
      wordbookId: params.wordbookId,
    });
  }

  async getWordBySlug(slug: string): Promise<{ word: Word }> {
    const row = await this.words.findBySlug(slug);
    if (!row) {
      // M1 fix: use NotFoundError (AppError subclass) → errorToResponse maps to 404
      throw new NotFoundError("Word", slug);
    }
    return { word: new Word(row) };
  }

  async getWordCount(): Promise<number> {
    return this.words.count();
  }

  async getAllSlugs(limit?: number): Promise<string[]> {
    return this.words.findSlugs(limit);
  }
}
