/**
 * Note — rich domain entity for user notes on words.
 *
 * Encapsulates versioning logic: when content changes, version increments
 * and a revision should be created.
 */

import type { NoteRow } from "./index";

export class Note {
  constructor(private readonly row: NoteRow) {}

  get id(): string { return this.row.id; }
  get wordId(): string { return this.row.word_id; }
  get wordbookId(): string { return this.row.wordbook_id; }
  get contentMd(): string { return this.row.content_md; }
  get version(): number { return this.row.version; }
  get updatedAt(): string { return this.row.updated_at; }

  /** Should a new revision be created when saving this content? */
  shouldCreateRevision(newContent: string): boolean {
    return this.contentMd !== newContent;
  }

  /** Compute the next version number after a content change. */
  nextVersion(newContent: string): number {
    return this.shouldCreateRevision(newContent)
      ? this.version + 1
      : this.version;
  }
}
