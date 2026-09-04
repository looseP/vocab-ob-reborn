/**
 * Deterministic L3 raw-text import parser.
 *
 * This helper is intentionally pure: no DB, repositories, HTTP, dictionary,
 * LLM, MCP, or recommendation imports. It only turns caller-provided text and
 * explicit target words into context/occurrence candidates.
 */

export interface L3ImportTargetWord {
  wordId?: string;
  slug?: string;
}

export interface L3ImportParserOptions {
  contextType?: "sentence" | "paragraph";
  maxContexts?: number;
  minContextLength?: number;
  maxOccurrencesPerWordPerContext?: number;
}

export interface ParsedImportContext {
  text: string;
  startOffset: number;
  endOffset: number;
  occurrences: ParsedImportOccurrence[];
}

export interface ParsedImportOccurrence {
  wordId?: string;
  slug?: string;
  surface: string;
  startOffset: number;
  endOffset: number;
  confidence: number;
}

export interface ParsedRawTextImport {
  contexts: ParsedImportContext[];
  skippedContextCount: number;
  warnings: string[];
}

const DEFAULT_MAX_CONTEXTS = 50;
const MAX_CONTEXTS_LIMIT = 200;
const DEFAULT_MIN_CONTEXT_LENGTH = 3;
const DEFAULT_MAX_OCCURRENCES = 3;
const SENTENCE_TERMINATOR_RE = /[.!?。？！]+/gu;
const WORD_BOUNDARY_CHARS = /[\p{L}\p{N}_-]/u;

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function isBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return true;
  return !WORD_BOUNDARY_CHARS.test(text[index] ?? "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeOptions(options: L3ImportParserOptions | undefined): Required<L3ImportParserOptions> {
  return {
    contextType: options?.contextType ?? "sentence",
    maxContexts: clampInteger(options?.maxContexts, DEFAULT_MAX_CONTEXTS, 1, MAX_CONTEXTS_LIMIT),
    minContextLength: clampInteger(options?.minContextLength, DEFAULT_MIN_CONTEXT_LENGTH, 1, 10_000),
    maxOccurrencesPerWordPerContext: clampInteger(
      options?.maxOccurrencesPerWordPerContext,
      DEFAULT_MAX_OCCURRENCES,
      1,
      50,
    ),
  };
}

function splitSentences(text: string): Array<{ text: string; startOffset: number; endOffset: number }> {
  const contexts: Array<{ text: string; startOffset: number; endOffset: number }> = [];
  let segmentStart = 0;
  for (const match of text.matchAll(SENTENCE_TERMINATOR_RE)) {
    const end = (match.index ?? 0) + match[0].length;
    const raw = text.slice(segmentStart, end);
    const leading = raw.search(/\S/);
    if (leading >= 0) {
      const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
      contexts.push({
        text: raw.slice(leading, raw.length - trailing),
        startOffset: segmentStart + leading,
        endOffset: end - trailing,
      });
    }
    segmentStart = end;
  }

  if (segmentStart < text.length) {
    const raw = text.slice(segmentStart);
    const leading = raw.search(/\S/);
    if (leading >= 0) {
      const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
      contexts.push({
        text: raw.slice(leading, raw.length - trailing),
        startOffset: segmentStart + leading,
        endOffset: text.length - trailing,
      });
    }
  }
  return contexts;
}

function splitParagraphs(text: string): Array<{ text: string; startOffset: number; endOffset: number }> {
  const contexts: Array<{ text: string; startOffset: number; endOffset: number }> = [];
  const paragraphRe = /\S[\s\S]*?(?=\r?\n\s*\r?\n|$)/g;
  for (const match of text.matchAll(paragraphRe)) {
    const raw = match[0];
    const absoluteStart = match.index ?? 0;
    const leading = raw.search(/\S/);
    if (leading < 0) continue;
    const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
    contexts.push({
      text: raw.slice(leading, raw.length - trailing),
      startOffset: absoluteStart + leading,
      endOffset: absoluteStart + raw.length - trailing,
    });
  }
  return contexts;
}

function findOccurrences(
  contextText: string,
  targetWords: L3ImportTargetWord[],
  maxOccurrencesPerWord: number,
): ParsedImportOccurrence[] {
  const occurrences: ParsedImportOccurrence[] = [];
  for (const target of targetWords) {
    if (!target.slug) continue;
    const slug = target.slug.trim();
    if (!slug) continue;
    let count = 0;
    const matcher = new RegExp(escapeRegExp(slug), "giu");
    for (const match of contextText.matchAll(matcher)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (!isBoundary(contextText, start - 1) || !isBoundary(contextText, end)) continue;
      occurrences.push({
        ...(target.wordId ? { wordId: target.wordId } : {}),
        slug,
        surface: contextText.slice(start, end),
        startOffset: start,
        endOffset: end,
        confidence: 1,
      });
      count += 1;
      if (count >= maxOccurrencesPerWord) break;
    }
  }
  return occurrences;
}

export function parseRawTextImport(
  text: string,
  targetWords: L3ImportTargetWord[] = [],
  options?: L3ImportParserOptions,
): ParsedRawTextImport {
  const normalized = normalizeOptions(options);
  const warnings: string[] = [];
  const split = normalized.contextType === "paragraph" ? splitParagraphs(text) : splitSentences(text);
  const contexts: ParsedImportContext[] = [];
  let skippedContextCount = 0;
  let contextLimitReached = false;

  for (const candidate of split) {
    if (candidate.text.trim().length < normalized.minContextLength) {
      skippedContextCount += 1;
      continue;
    }
    if (contexts.length >= normalized.maxContexts) {
      skippedContextCount += 1;
      contextLimitReached = true;
      continue;
    }
    contexts.push({
      ...candidate,
      occurrences: targetWords.length > 0
        ? findOccurrences(candidate.text, targetWords, normalized.maxOccurrencesPerWordPerContext)
        : [],
    });
  }

  if (contextLimitReached) {
    warnings.push("Context limit reached; remaining contexts skipped.");
  }
  if (targetWords.length === 0) {
    warnings.push("No targetWords supplied; occurrences were not generated.");
  }

  return { contexts, skippedContextCount, warnings };
}
