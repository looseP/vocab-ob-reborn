/**
 * CaptureService — R1 reading-capture orchestration.
 *
 * Flow: normalize headword → ensure a minimal word stub exists →
 * single transaction: wordbook membership + note read.
 *
 * Two-phase by design: INSERT INTO words is reserved to the
 * vocab_batch_import role (batch pool), so the stub is ensured through
 * WordRepository.insertMany outside the app-role transaction; membership
 * and note read land atomically inside it.
 *
 * L3 reservation (product decision 2026-08-22): `sentence`, `sourceUrl`
 * and `obsidianRef` are accepted for forward-compatible contracts but are
 * NOT persisted this round — responses report l3Status="deferred".
 * Enablement rules agreed for the future implementation:
 *  - Admission gate: the word must meet the L2 transition stability
 *    standard (stability ≥ 21d, review_count ≥ 5, last rating ∈
 *    {good, easy} — same thresholds as L2TransitionService).
 *  - A source without an occurrence is unreachable from any word space,
 *    so source/context/occurrence must always be written as one trio.
 *  - url / obsidianRef ride along as metadata on that trio; context_type
 *    by length (≤200 chars = 'sentence', else 'paragraph').
 */

import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type { IWordRepository } from "../repositories/interfaces";
import { ValidationError } from "../errors";

export const CAPTURE_L3_STATUS = {
  /** Current fixed value until L3 capture ships. */
  deferred: "deferred",
} as const;

export interface CaptureInput {
  userId: string;
  wordbookId: string;
  headword: string;
  /** Reserved for future L3 capture — accepted, not persisted yet. */
  sentence?: string;
  /** Reserved for future L3 capture — accepted, not persisted yet. */
  sourceUrl?: string;
  /** Reserved for future L3 capture — accepted, not persisted yet. */
  obsidianRef?: string;
}

export interface CaptureResult {
  ok: true;
  /** False when this call created the word stub. */
  existed: boolean;
  word: {
    id: string;
    slug: string;
    title: string;
    lemma: string;
    shortDefinition: string | null;
  };
  noteContentMd: string | null;
  l3Status: keyof typeof CAPTURE_L3_STATUS;
  sourceId: string | null;
  contextId: string | null;
  occurrenceId: string | null;
}

export function slugifyHeadword(headword: string): string {
  return headword
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

export class CaptureService {
  constructor(private readonly words: IWordRepository) {}

  async capture(input: CaptureInput): Promise<CaptureResult> {
    const title = input.headword.trim();
    const slug = slugifyHeadword(title);
    if (!slug) {
      throw new ValidationError("headword must contain latin word characters", "headword");
    }

    let row = await this.words.findBySlug(slug);
    let existed = row != null;
    if (!row) {
      if (!this.words.insertMany) throw new Error("insertMany not configured");
      await this.words.insertMany([
        { slug, title, lemma: title, pos: null, cefr: null, ipa: null, short_definition: null },
      ]);
      row = await this.words.findBySlug(slug);
      if (!row) throw new Error(`capture word upsert failed for slug "${slug}"`);
      existed = false;
    }
    const wordRow = row;

    const transactionResult = await withTransaction(async (tx) => {
      const repos = createRepositories(tx);

      await repos.wordbooks.addWords(input.wordbookId, [wordRow.id]);

      const note = await repos.notes.findByWord(input.userId, input.wordbookId, wordRow.id);

      return {
        result: {
          ok: true as const,
          existed,
          word: {
            id: wordRow.id,
            slug: wordRow.slug,
            title: wordRow.title,
            lemma: wordRow.lemma,
            shortDefinition: wordRow.short_definition,
          },
          noteContentMd: note?.content_md ?? null,
          l3Status: CAPTURE_L3_STATUS.deferred,
          sourceId: null,
          contextId: null,
          occurrenceId: null,
        } satisfies CaptureResult,
      };
    }, { actorId: input.userId });

    return transactionResult.result;
  }
}
