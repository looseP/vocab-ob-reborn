/**
 * Completeness quality gate, adapted from the v1 ingestion pipeline
 * (old-odds lib/sync/quality.ts) for the L1 note format:
 *
 * - lenient:  only a missing definition rejects.
 * - standard: missing definition rejects; missing IPA flags needs_supplement
 *   (IPA is the retention bar — the format has no example section, so the
 *   old examples check was removed; it used to cap every score at 80).
 * - strict:   any missing field flags needs_supplement.
 */

import type { IngestWord } from "./types";
import { isBlank } from "./utils";

export type QualityStrictness = "lenient" | "standard" | "strict";
export type WordQualityTier = "ok" | "needs_supplement" | "rejected";
export type MissingField = "definition" | "ipa";

export interface QualityIssue {
  field: MissingField;
  reason: string;
}

export interface WordQualityReport {
  tier: WordQualityTier;
  /** 0–100 completeness score. */
  score: number;
  missing: MissingField[];
  issues: QualityIssue[];
  strictness: QualityStrictness;
}

const FIELD_SCORE_WEIGHTS: Record<MissingField, number> = {
  definition: 60,
  ipa: 40,
};

function hasDefinition(word: IngestWord): boolean {
  if (!isBlank(word.definitionMd)) return true;
  return word.coreDefinitions.some((def) => !isBlank(def.sense));
}

function hasIpa(word: IngestWord): boolean {
  return !isBlank(word.ipa);
}

function collectMissing(word: IngestWord): MissingField[] {
  const missing: MissingField[] = [];
  if (!hasDefinition(word)) missing.push("definition");
  if (!hasIpa(word)) missing.push("ipa");
  return missing;
}

function buildIssues(missing: MissingField[]): QualityIssue[] {
  const reasons: Record<MissingField, string> = {
    definition: "缺少核心释义（definitionMd / coreDefinitions 均为空）",
    ipa: "缺少音标（ipa 为空，无法通过 standard 档保级）",
  };
  return missing.map((field) => ({ field, reason: reasons[field]! }));
}

function computeScore(missing: MissingField[]): number {
  let score = 100;
  for (const field of missing) score -= FIELD_SCORE_WEIGHTS[field]!;
  return Math.max(0, Math.min(100, score));
}

function decideTier(missing: MissingField[], strictness: QualityStrictness): WordQualityTier {
  if (missing.includes("definition")) return "rejected";
  if (strictness === "strict") {
    return missing.length > 0 ? "needs_supplement" : "ok";
  }
  if (strictness === "standard") {
    return missing.includes("ipa") ? "needs_supplement" : "ok";
  }
  return "ok"; // lenient
}

export function assessWordCompleteness(
  word: IngestWord,
  strictness: QualityStrictness = "standard",
): WordQualityReport {
  const missing = collectMissing(word);
  return {
    tier: decideTier(missing, strictness),
    score: computeScore(missing),
    missing,
    issues: buildIssues(missing),
    strictness,
  };
}
