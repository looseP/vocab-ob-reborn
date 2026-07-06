/**
 * Service factory — creates all services with their dependencies.
 *
 * M6 fix: fsrsAdapter is required (not optional), enforced at compile time.
 * H1 fix: RepositoryFactory deleted — services create their own repos inside tx.
 *
 * Usage:
 *   const services = createServices({ fsrsAdapter, loadWeights });
 *   const words = await services.words.getPublicWords({...});
 *   await services.reviews.submitAnswer(input);  // creates tx internally
 */

import { WordService } from "./word.service";
import { ReviewService, type FsrsAdapterFn } from "./review.service";
import { NoteService } from "./note.service";
import { WordbookService } from "./wordbook.service";
import { StatsService } from "./stats.service";
import { createRepositories } from "../index";

export interface ServiceDeps {
  /** FSRS scheduling adapter — M6 fix: required */
  fsrsAdapter: FsrsAdapterFn;
  /** Load wordbook FSRS weights */
  loadWeights?: (wordbookId: string) => Promise<number[] | null>;
}

export function createServices(deps: ServiceDeps) {
  const repos = createRepositories();

  const loadWeights = deps.loadWeights ?? (async () => null);

  return {
    words: new WordService(repos.words),
    reviews: new ReviewService({
      fsrsAdapter: deps.fsrsAdapter,
      loadWeights,
    }),
    notes: new NoteService(repos.notes, repos.wordbooks),
    wordbooks: new WordbookService(repos.wordbooks),
    stats: new StatsService(repos.stats),
  };
}

export type Services = ReturnType<typeof createServices>;
