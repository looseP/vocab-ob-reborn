/**
 * Word — rich domain entity wrapping a raw word row.
 *
 * Encapsulates business rules about publication status, metadata access,
 * and content hash comparison. Zero DB/framework dependencies.
 */

import type { Json, WordDetail, WordRow } from "./index";

/** L2 JSONB 缓存列 → 数组（列恒为 JSON 数组；对非数组脏值/缺省兜底为空数组）。 */
function l2CacheArray(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}

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

  /** Return the explicit public representation used by HTTP response contracts. */
  toDetail(): WordDetail {
    return {
      id: this.row.id,
      slug: this.row.slug,
      title: this.row.title,
      lemma: this.row.lemma,
      pos: this.row.pos,
      cefr: this.row.cefr,
      ipa: this.row.ipa,
      aliases: [...this.row.aliases],
      short_definition: this.row.short_definition,
      definition_md: this.row.definition_md,
      body_md: this.row.body_md,
      examples: this.row.examples,
      prototype_text: this.row.prototype_text,
      metadata: this.row.metadata,
      l2_content: {
        collocations: l2CacheArray(this.row.collocations),
        corpus_items: l2CacheArray(this.row.corpus_items),
        synonym_items: l2CacheArray(this.row.synonym_items),
        antonym_items: l2CacheArray(this.row.antonym_items),
      },
      // 实体本身无用户语义，默认 false；路由层（owner scope）以 EXISTS 结果覆盖。
      l2_promoted: false,
    };
  }

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
