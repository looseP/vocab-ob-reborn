/**
 * Completeness quality gate, ported from the v1 ingestion pipeline
 * (old-odds lib/sync/quality.ts) with identical tiers, weights and rules:
 *
 * - lenient:  only a missing definition rejects.
 * - standard: missing definition rejects; missing BOTH examples and ipa
 *   flags needs_supplement.
 * - strict:   any missing field flags needs_supplement.
 *
 * The migration corpus (2026-08-22) carries no example sections yet, so
 * under "standard" a word with IPA still lands on "ok" — matching intent.
 */

import type { IngestWord } from "./types";
import { isBlank } from "./utils";

export type QualityStrictness = "lenient" | "standard" | "strict";
export type WordQualityTier = "ok" | "needs_supplement" | "rejected";
export type MissingField = "definition" | "examples" | "ipa";

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
  examples: 20,
  ipa: 20,
};

function hasDefinition(word: IngestWord): boolean {
  if (!isBlank(word.definitionMd)) return true;
  return word.coreDefinitions.some((def) => !isBlank(def.sense));
}

/** Example sections are not part of the migration format yet. */
function hasExamples(_word: IngestWord): boolean {
  return false;
}

function hasIpa(word: IngestWord): boolean {
  return !isBlank(word.ipa);
}

function collectMissing(word: IngestWord): MissingField[] {
  const missing: MissingField[] = [];
  if (!hasDefinition(word)) missing.push("definition");
  if (!hasExamples(word)) missing.push("examples");
  if (!hasIpa(word)) missing.push("ipa");
  return missing;
}

function buildIssues(missing: MissingField[]): QualityIssue[] {
  const reasons: Record<MissingField, string> = {
    definition: "缺少核心释义（definitionMd / coreDefinitions 均为空）",
    examples: "缺少例句（collocation / corpus 均为空）",
    ipa: "缺少音标（ipa 为空）",
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
  const missingExamples = missing.includes("examples");
  const missingIpa = missing.includes("ipa");

  if (strictness === "strict") {
    return missing.length > 0 ? "needs_supplement" : "ok";
  }
  if (strictness === "standard") {
    return missingExamples && missingIpa ? "needs_supplement" : "ok";
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
