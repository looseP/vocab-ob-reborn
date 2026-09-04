import { createHash } from "node:crypto";
import type { IngestWord } from "./types";

/** Same normalization contract as the capture stub path (services/capture). */
export function slugifyHeadword(headword: string): string {
  return headword
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

export function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim().length === 0;
}

/**
 * Stable content hash for a fully-parsed word. Deliberately independent from
 * the minimal-stub formula used by WordRepository.insertMany: a stub and its
 * later full-note import MUST produce different hashes so the upsert in the
 * import pipeline actually refreshes content.
 */
export function computeIngestHash(word: IngestWord): string {
  return createHash("sha256")
    .update(
      [
        word.slug,
        word.title,
        word.lemma,
        word.pos ?? "",
        word.cefr ?? "",
        word.ipa ?? "",
        word.shortDefinition ?? "",
        word.definitionMd,
        word.bodyMd,
      ].join("\u0000"),
    )
    .digest("hex");
}
