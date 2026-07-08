/**
 * Word — rich domain entity wrapping a raw word row.
 *
 * Encapsulates business rules about publication status, metadata access,
 * and content hash comparison. Zero DB/framework dependencies.
 */

import type { WordRow } from "./index";

export class Word {
  constructor(private readonly row: WordRow) {}

  get id(): string { return this.row.id; }
  get slug(): string { return this.row.slug; }
  get lemma(): string { return this.row.lemma; }
  get title(): string { return this.row.title; }
  get pos(): string { return this.row.pos ?? ""; }
  get shortDefinition(): string { return this.row.short_definition ?? ""; }
  get cefr(): string { return this.row.cefr ?? ""; }
  get contentHash(): string { return this.row.content_hash; }

  get isPublished(): boolean {
    return this.row.is_published && !this.row.is_deleted;
  }

  get freqLabel(): string | null {
    return this.metadataField("word_freq");
  }

  get semanticField(): string | null {
    return this.metadataField("semantic_field");
  }

  /** Check if this word's content hash differs from a snapshot. */
  hasContentDrift(snapshotHash: string | null): boolean {
    return snapshotHash !== null && snapshotHash !== this.row.content_hash;
  }

  private metadataField(key: string): string | null {
    const meta = this.row.metadata as Record<string, unknown> | null;
    const val = meta?.[key];
    return typeof val === "string" ? val : null;
  }
}
