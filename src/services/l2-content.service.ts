/**
 * L2ContentService — generates & confirms multi-source L2 enrichment content.
 *
 * Two-phase draft→confirm flow:
 *   generateDraft() — calls LLM within a daily token budget, returns a parsed
 *     draft (or a structured error: OVER_BUDGET / LLM_ERROR / PARSE_FAILED).
 *   confirmDraft()  — persists an approved draft inside a transaction:
 *     1. insert word_l2_content row
 *     2. refreshL2Cache (aggregate active rows back into words JSONB columns)
 *     3. recompute l2_content_hash and markL2StaleForRecheck (re-trigger L2
 *        cards whose snapshot changed, without touching L1)
 *
 * Architecture: services may import db/transaction + db/content-hash (the
 * services-no-raw-db-access rule only forbids db/sql|connection|client|...).
 */

import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import { computeL2Hash } from "../db/content-hash";
import { parseLlmJson } from "../llm/parser";
import type { LlmProvider } from "../llm/provider";
import type { UsageTracker } from "../llm/usage-tracker";
import type { DictionaryProvider, DictionaryCandidate } from "../dictionary/provider";
import { buildPromptForField } from "../llm/prompts";
import { logger } from "../observability/logger";
import { parseL2Content } from "../schemas/service";
import type { L2Field } from "../schemas/service";
import {
  getStyleProfile,
  validateStyleProfileField,
  type L2StyleProfile,
} from "../domain/l2-style-profile";
import { ValidationError } from "../errors";
import {
  assertJsonResourceBudget,
  JSON_MAX_DEPTH,
  L2_CONTENT_MAX_BYTES,
  L2_DRAFT_MAX_COUNT,
  L2_OPTION_STRING_MAX_LENGTH,
  L2_USER_INSTRUCTION_MAX_LENGTH,
} from "../schemas/resource-budget";
import { createHash } from "node:crypto";

/**
 * Dependencies injected into {@link L2ContentService}.
 *
 * All members are optional so the service can always be constructed — even
 * when no LLM provider is wired up. The draft flow degrades gracefully:
 * `generateDraft` returns a structured `L2_CONTENT_UNAVAILABLE` error for
 * fields that require the LLM, while `confirmDraft` (a pure DB cascade) runs
 * with no LLM at all.
 *
 * `dictionaryProvider` grounds the collocation draft flow (B3): the service
 * looks up candidates before any LLM call, returns `NO_DICTIONARY_CANDIDATES`
 * when empty, a dictionary-only draft when the LLM is absent, or an LLM-refined
 * draft constrained to those candidates when both are available.
 */
export interface L2ContentServiceDeps {
  /** LLM provider — required for example/corpus/synonym/antonym drafts. */
  llmProvider?: LlmProvider;
  /** LLM usage tracker — paired with llmProvider for daily budget enforcement. */
  usageTracker?: UsageTracker;
  /** Dictionary provider — grounds the collocation draft flow (B3). */
  dictionaryProvider?: DictionaryProvider;
}

export interface WordContext {
  lemma: string;
  pos: string;
  semanticField: string;
  shortDefinition: string;
  cefrTarget: string;
}

export interface GenerateDraftResult {
  draft?: unknown;
  raw?: string;
  error?:
    | "OVER_BUDGET"
    | "LLM_ERROR"
    | "PARSE_FAILED"
    | "L2_CONTENT_UNAVAILABLE"
    | "NO_DICTIONARY_CANDIDATES";
  message?: string;
  warning?: string;
  /** Which source produced this draft — surfaces the degrade path to callers. */
  sourceMode?: "internal_llm" | "dictionary" | "dictionary_llm_refined";
  /** Echoes the canonical storage field the draft is intended for. */
  storageField?: L2Field;
}

/**
 * Fields whose draft generation currently requires the LLM.
 *
 * `collocation` is dictionary-grounded in B3: when dictionary candidates exist
 * the LLM refines them (and without candidates the draft short-circuits before
 * any LLM call), so it is removed from this set. `corpus`/`synonym`/`antonym`
 * still require the LLM and degrade to `L2_CONTENT_UNAVAILABLE` without it.
 */
const LLM_REQUIRED_FIELDS: ReadonlySet<L2Field> = new Set<L2Field>([
  "corpus",
  "synonym",
  "antonym",
]);

/**
 * Whether a field's draft needs the LLM given its current source state.
 *
 * `collocation` only needs the LLM when dictionary candidates are present to
 * refine; with no candidates the draft returns `NO_DICTIONARY_CANDIDATES`
 * (LLM never called) and with candidates but no LLM it returns a
 * dictionary-only draft. The other three LLM-required fields always need the
 * LLM regardless of options.
 */
function requiresLlm(field: L2Field, hasCandidates: boolean): boolean {
  if (field === "collocation") return hasCandidates; // refine candidates
  return LLM_REQUIRED_FIELDS.has(field);
}

export interface GenerateDraftOptions {
  source?: string;
  /** Explicit source mode override; otherwise inferred from field + dictionary state. */
  sourceMode?: "internal_llm" | "dictionary" | "dictionary_llm_refined";
  /** Style profile id for example/corpus drafts (B4); validated against field scope. */
  styleProfileId?: string;
  /** Override the default item count for the field's prompt. */
  count?: number;
  /** Free-text caller guidance (reserved for B5 external-prompt flow). */
  userInstruction?: string;
}

/**
 * Options for {@link L2ContentService.confirmDraft} (B6). Accepts either a
 * legacy `source: string` (kept so existing call sites/tests that pass `"manual"`
 * keep working) or this structured object carrying source metadata that reaches
 * the `word_l2_content` row.
 */
export interface ConfirmDraftOptions {
  source?: string;
  /** Free-text reference for the source (URL, conversation id, …) → `source_ref`. */
  sourceRef?: string | null;
  /** Identity of the approver → `approved_by`. Defaults to `"user"`. */
  approvedBy?: string | null;
}

/**
 * Options for {@link L2ContentService.buildExternalPrompt} (B5). Mirrors the
 * draft options that influence the prompt text (style profile, count, user
 * instruction) but is processed WITHOUT touching the LLM or usage budget.
 */
export interface BuildExternalPromptOptions {
  styleProfileId?: string;
  count?: number;
  userInstruction?: string;
}

/** Result of {@link L2ContentService.buildExternalPrompt}. */
export interface BuildExternalPromptResult {
  /** Canonical storage field (`corpus` even when the request sent `example`). */
  storageField: L2Field;
  /**
   * Resolved style profile id (defaults to `"default"` when none provided).
   * Absent on the error path.
   */
  styleProfileId?: string;
  /**
   * Stable prompt version tag for provenance tracking. Absent on the error path.
   */
  promptVersion?: string;
  /** sha256 hex of the assembled prompt text. Absent on the error path. */
  promptHash?: string;
  /** The assembled prompt text (system + user messages joined). Absent on the error path. */
  prompt?: string;
  /**
   * JSON-schema-ish description of the expected LLM output shape. Absent on
   * the error path.
   */
  expectedJsonSchema?: Record<string, unknown>;
  /**
   * Structured error for the collocation dictionary-grounding path (B3/B5).
   * Present only when the dictionary had no candidates for `collocation`; the
   * route maps this to 422. Absent on the success path.
   */
  error?: "NO_DICTIONARY_CANDIDATES";
  /** Human-readable warning describing why the prompt could not be built. */
  warning?: string;
}

/** Resolve a style profile id into an {@link L2StyleProfile}, or undefined. */
function resolveStyleProfile(
  styleProfileId: string | undefined,
  field: L2Field,
): L2StyleProfile | undefined {
  if (!styleProfileId) return undefined;
  const profile = getStyleProfile(styleProfileId);
  // Map storage field → composer field for scope validation: `corpus` is the
  // storage name for the `example` composer field.
  const composerField = field === "corpus" ? "example" : (field as "collocation" | "example");
  // Throws a structured Error (→ caught and rethrown as ValidationError below)
  // when the profile doesn't support this field scope.
  validateStyleProfileField(profile, composerField);
  return profile;
}

/**
 * Normalize the third `generateDraft` parameter into a full options object.
 *
 * Accepts either a legacy `source: string` (kept so existing call sites and
 * tests that pass `"manual"` keep working) or a `GenerateDraftOptions`
 * object. A string is treated as `{ source }`.
 */
function normalizeDraftOptions(
  sourceOrOptions?: string | GenerateDraftOptions,
): GenerateDraftOptions {
  const options = typeof sourceOrOptions === "string"
    ? { source: sourceOrOptions }
    : sourceOrOptions ?? {};

  if (options.count !== undefined && (
    !Number.isInteger(options.count) ||
    options.count < 1 ||
    options.count > L2_DRAFT_MAX_COUNT
  )) {
    throw new ValidationError(`count must be an integer between 1 and ${L2_DRAFT_MAX_COUNT}`, "count");
  }
  if (options.userInstruction !== undefined && options.userInstruction.length > L2_USER_INSTRUCTION_MAX_LENGTH) {
    throw new ValidationError(
      `userInstruction exceeds maximum length of ${L2_USER_INSTRUCTION_MAX_LENGTH}`,
      "userInstruction",
    );
  }
  if (options.styleProfileId !== undefined && options.styleProfileId.length > L2_OPTION_STRING_MAX_LENGTH) {
    throw new ValidationError(`styleProfileId exceeds maximum length of ${L2_OPTION_STRING_MAX_LENGTH}`, "styleProfileId");
  }
  if (options.source !== undefined && options.source.length > L2_OPTION_STRING_MAX_LENGTH) {
    throw new ValidationError(`source exceeds maximum length of ${L2_OPTION_STRING_MAX_LENGTH}`, "source");
  }
  return options;
}

function normalizeExternalPromptOptions(
  options: BuildExternalPromptOptions = {},
): BuildExternalPromptOptions {
  normalizeDraftOptions(options);
  return options;
}

/**
 * Normalize the fourth `confirmDraft` parameter into a full options object
 * (B6). Accepts either a legacy `source: string` (back-compat — existing call
 * sites and tests that pass `"manual"` keep working) or a
 * {@link ConfirmDraftOptions} object. A string is treated as `{ source }`.
 */
function normalizeConfirmOptions(
  sourceOrOptions?: string | ConfirmDraftOptions,
): ConfirmDraftOptions {
  if (typeof sourceOrOptions === "string") return { source: sourceOrOptions };
  return sourceOrOptions ?? {};
}

/**
 * Describe the JSON shape an LLM is expected to return for `field`, for the
 * external-prompt endpoint (B5). This is a *description* (not a live Zod
 * schema) so external tool operators can see the expected structure.
 *
 * The description declares the v1 document shape
 * `{ schemaVersion: "l2-content-v1", field, items: [...] }` (P3: v1-first
 * output format) rather than the legacy bare array. Each item carries a
 * `provenance.source` so the origin is never lost:
 *   - example (corpus)      → `provenance.source = "external_chat"`
 *   - collocation           → `provenance.source = "external_chat"` plus
 *     dictionary evidence
 *
 * `field` uses the composer-facing name (`example`) when the storage field is
 * `corpus`, matching what the prompt instructs the LLM to emit.
 */
function describeExpectedJsonSchema(
  field: L2Field,
  styleProfile: L2StyleProfile | undefined,
): Record<string, unknown> {
  // Composer-facing field name in the v1 wrapper: `example` for corpus.
  const composerField = field === "corpus" ? "example" : field;
  const includeUsageNote = styleProfile?.promptRules.includeUsageNote === true;
  let itemShape: Record<string, unknown>;
  switch (field) {
    case "collocation":
      itemShape = {
        type: "object",
        required: ["phrase", "evidence", "provenance"],
        properties: {
          phrase: { type: "string" },
          meaning: { type: "string" },
          gloss: { type: "string" },
          example: { type: "string" },
          exampleTranslation: { type: "string" },
          tone: { type: "string", enum: ["formal", "neutral", "informal"] },
          evidence: {
            type: "object",
            required: ["dictionaryName", "rawPhrase"],
            properties: {
              dictionaryName: { type: "string" },
              dictionaryUrl: { type: "string" },
              rawPhrase: { type: "string" },
            },
          },
          provenance: {
            type: "object",
            required: ["source"],
            properties: {
              source: { type: "string", enum: ["external_chat"] },
              externalTool: { type: "string" },
              promptVersion: { type: "string" },
              promptHash: { type: "string" },
            },
          },
        },
      };
      break;
    case "corpus":
      itemShape = {
        type: "object",
        required: ["text", "translation", "source", "provenance"],
        properties: {
          text: { type: "string" },
          translation: { type: "string" },
          source: { type: "string" },
          ...(includeUsageNote ? { usageNote: { type: "string" } } : {}),
          provenance: {
            type: "object",
            required: ["source"],
            properties: {
              source: { type: "string", enum: ["external_chat"] },
              externalTool: { type: "string" },
              promptVersion: { type: "string" },
              promptHash: { type: "string" },
            },
          },
        },
      };
      break;
    case "synonym":
    case "antonym":
      itemShape = {
        type: "object",
        required: ["word", "semanticDiff", "tone", "usage", "delta", "object", "provenance"],
        properties: {
          word: { type: "string" },
          semanticDiff: { type: "string" },
          tone: { type: "string", enum: ["formal", "neutral", "informal"] },
          usage: { type: "string" },
          delta: { type: "string" },
          object: { type: "string" },
          provenance: {
            type: "object",
            required: ["source"],
            properties: {
              source: { type: "string", enum: ["external_chat"] },
              externalTool: { type: "string" },
            },
          },
        },
      };
      break;
  }
  return {
    type: "object",
    required: ["schemaVersion", "field", "items"],
    properties: {
      schemaVersion: { type: "string", const: "l2-content-v1" },
      field: { type: "string", enum: [composerField] },
      items: {
        type: "array",
        items: itemShape,
      },
    },
  };
}

export class L2ContentService {
  constructor(private readonly deps: L2ContentServiceDeps = {}) {}

  /**
   * Generate an L2 content draft, honoring the daily token budget and the
   * field's source semantics. Never throws — failures are returned as
   * structured `error` results so the HTTP layer can map them to status codes.
   *
   * Source paths (B3/B4):
   *   - `collocation` → dictionary-grounded (B3):
   *       1. lookupCollocations via dictionaryProvider (no LLM call yet)
   *       2. no candidates → `{ error: "NO_DICTIONARY_CANDIDATES", warning }`,
   *          LLM never called, no usage recorded
   *       3. candidates but no LLM deps → dictionary-only draft
   *          (`sourceMode = "dictionary"`), items carry provenance.source
   *       4. candidates + LLM deps → LLM refine prompt grounded on candidates
   *          (`sourceMode = "dictionary_llm_refined"`)
   *   - `corpus`/`synonym`/`antonym` → internal LLM (B4 style profile for corpus):
   *       requires LLM; without it returns `L2_CONTENT_UNAVAILABLE`.
   *
   * The third parameter accepts a legacy `source: string` (back-compat) or a
   * {@link GenerateDraftOptions} object carrying `styleProfileId`, `count`, etc.
   */
  async generateDraft(
    word: WordContext,
    field: L2Field,
    sourceOrOptions?: string | GenerateDraftOptions,
  ): Promise<GenerateDraftResult> {
    const options = normalizeDraftOptions(sourceOrOptions);
    const llmProvider = this.deps.llmProvider;
    const usageTracker = this.deps.usageTracker;
    const dictionaryProvider = this.deps.dictionaryProvider;

    // 0. Style profile resolution (B4). For corpus/example, resolve + validate
    //    the profile's field scope early so a mismatched profile (e.g.
    //    core_collocation used with field=example) fails fast with a structured
    //    ValidationError rather than reaching the LLM. Style profiles only
    //    apply to collocation/example; they're ignored for synonym/antonym.
    let styleProfile: L2StyleProfile | undefined;
    if (options.styleProfileId && (field === "collocation" || field === "corpus")) {
      try {
        styleProfile = resolveStyleProfile(options.styleProfileId, field);
      } catch (err) {
        throw new ValidationError(
          `Style profile "${options.styleProfileId}" is invalid for field "${field}"`,
          field,
          err,
        );
      }
    }

    // 1. Dictionary grounding (B3) — collocation only.
    //    Look up candidates BEFORE any LLM call. The dictionary is the sole
    //    source of which phrases exist; the LLM only refines/annotates.
    if (field === "collocation") {
      if (!dictionaryProvider) {
        // No dictionary configured → collocation cannot be grounded. Surface
        // as the no-candidates error rather than silently falling back to an
        // ungrounded LLM draft (the B3 contract forbids invented collocations).
        return {
          error: "NO_DICTIONARY_CANDIDATES",
          warning: "Dictionary provider not configured",
          storageField: field,
        };
      }

      let candidates: DictionaryCandidate[];
      let warning: string | undefined;
      try {
        const lookup = await dictionaryProvider.lookupCollocations({
          lemma: word.lemma,
          pos: word.pos,
          limit: options.count ?? 5,
        });
        candidates = lookup.candidates;
        warning = lookup.warning;
      } catch (err) {
        // Provider failure degrades like an empty lookup — no candidates, with
        // a warning describing the failure. LLM is NOT called on failure.
        candidates = [];
        warning = `Dictionary lookup failed: ${(err as Error).message}`;
      }

      if (candidates.length === 0) {
        // No candidates → structured error, LLM never called, no usage recorded.
        return {
          error: "NO_DICTIONARY_CANDIDATES",
          warning,
          storageField: field,
        };
      }

      // Candidates but no LLM → dictionary-only draft (B3 degrade path). Items
      // carry provenance.source = "dictionary" so the origin is never lost.
      if (!llmProvider || !usageTracker) {
        return {
          draft: this.buildDictionaryOnlyDraft(candidates),
          sourceMode: "dictionary",
          storageField: field,
          warning,
        };
      }

      // Reserve budget atomically immediately before the external call. The
      // repository lock + reservation closes the cross-process TOCTOU window.
      const reservationId = await usageTracker.reserve();
      if (!reservationId) {
        return { error: "OVER_BUDGET", storageField: field };
      }

      const messages = buildPromptForField(field, word, {
        dictionaryCandidates: candidates,
        count: options.count,
        styleProfile,
        userInstruction: options.userInstruction,
      });

      let result;
      try {
        result = await llmProvider.generate(messages, { temperature: 0.7 });
      } catch {
        await usageTracker.release(reservationId).catch((releaseError) => {
          logger.warn("l2-content", "usage reservation release failed", {
            message: (releaseError as Error).message,
          });
        });
        return {
          error: "LLM_ERROR",
          message: "LLM provider request failed",
          storageField: field,
        };
      }

      try {
        await usageTracker.settle(
          reservationId,
          result.model,
          result.model,
          result.promptTokens,
          result.completionTokens,
        );
      } catch (err) {
        logger.warn("l2-content", "usage tracking failed", {
          message: (err as Error).message,
        });
      }

      const parsed = parseLlmJson(result.content);
      if (!parsed.success) {
        return { error: "PARSE_FAILED", storageField: field };
      }

      // Defensive grounding (Phase 2E): LLMs sometimes ignore the "do not
      // invent" instruction and emit collocations absent from the candidate
      // list. Drop those items (rather than rejecting the whole draft) so a
      // single hallucination doesn't waste the LLM call, and surface a warning
      // so the caller/operator can see the filter fired. This is the
      // drop-not-reject contract: the dictionary is still the sole source of
      // which phrases exist; invented phrases never reach confirm/DB.
      const normalizePhraseKey = (p: string): string => p.trim().toLowerCase();
      const candidateByKey = new Map(
        candidates.map((c) => [normalizePhraseKey(c.phrase), c]),
      );
      const llmItems = Array.isArray(parsed.data) ? parsed.data : [];
      const groundedItems: unknown[] = [];
      let droppedCount = 0;
      for (const item of llmItems) {
        const phrase =
          item && typeof item === "object" && "phrase" in item
            ? String((item as { phrase: unknown }).phrase)
            : "";
        const key = normalizePhraseKey(phrase);
        const candidate = candidateByKey.get(key);
        if (phrase.trim().length > 0 && candidate) {
          // Merge provenance/evidence onto the LLM-refined item so the
          // dictionary origin is never lost, even though the LLM rewrote the
          // gloss/example/tone. The canonical phrase comes from the dictionary
          // (candidate.phrase) so downstream consumers see the exact lemma pair
          // the dictionary returned, not the LLM's casing/whitespace variant.
          const refined = { ...(item as Record<string, unknown>) };
          refined.phrase = candidate.phrase;
          refined.provenance = {
            source: "dictionary_llm_refined",
            dictionaryName: candidate.sourceName,
            ...(candidate.sourceEntryId
              ? { dictionaryEntryId: candidate.sourceEntryId }
              : {}),
            ...(candidate.sourceUrl ? { dictionaryUrl: candidate.sourceUrl } : {}),
          };
          refined.evidence = {
            dictionaryName: candidate.sourceName,
            ...(candidate.sourceUrl ? { dictionaryUrl: candidate.sourceUrl } : {}),
            rawPhrase: candidate.phrase,
          };
          groundedItems.push(refined);
        } else {
          droppedCount += 1;
        }
      }

      // All items ungrounded → fall back to a dictionary-only draft + warning.
      // The LLM call wasn't wasted silently: the operator is told every item was
      // hallucinated and the dictionary's own items are returned instead.
      if (groundedItems.length === 0) {
        return {
          draft: this.buildDictionaryOnlyDraft(candidates),
          raw: result.content,
          sourceMode: "dictionary",
          storageField: field,
          warning: "All LLM items ungrounded, fell back to dictionary-only",
        };
      }

      const groundedWarning =
        droppedCount > 0
          ? `Filtered ${droppedCount} ungrounded collocation item(s) not present in dictionary candidates`
          : warning;

      return {
        draft: groundedItems,
        raw: result.content,
        sourceMode: "dictionary_llm_refined",
        storageField: field,
        warning: groundedWarning,
      };
    }

    // 2. LLM-required fields (corpus/synonym/antonym). Without LLM deps these
    //    degrade to L2_CONTENT_UNAVAILABLE (B4: corpus/example internal draft
    //    requires the LLM).
    if (requiresLlm(field, false) && (!llmProvider || !usageTracker)) {
      return {
        error: "L2_CONTENT_UNAVAILABLE",
        message: "LLM provider not configured",
        storageField: field,
      };
    }

    // 3. Atomically reserve budget before spending tokens.
    const reservationId = await usageTracker!.reserve();
    if (!reservationId) {
      return { error: "OVER_BUDGET", storageField: field };
    }

    // 4. Pick the prompt template for the requested field, threading the
    //    resolved style profile into corpus/example prompts (B4).
    const messages = buildPromptForField(field, word, {
      styleProfile,
      count: options.count,
      userInstruction: options.userInstruction,
    });

    // 5. Call the provider — catch provider/transport errors.
    let result;
    try {
      result = await llmProvider!.generate(messages, { temperature: 0.7 });
    } catch {
      await usageTracker!.release(reservationId).catch((releaseError) => {
        logger.warn("l2-content", "usage reservation release failed", {
          message: (releaseError as Error).message,
        });
      });
      return {
        error: "LLM_ERROR",
        message: "LLM provider request failed",
        storageField: field,
      };
    }

    // 6. Replace the reservation with actual provider usage.
    try {
      await usageTracker!.settle(
        reservationId,
        result.model,
        result.model,
        result.promptTokens,
        result.completionTokens,
      );
    } catch (err) {
      logger.warn("l2-content", "usage tracking failed", {
        message: (err as Error).message,
      });
    }

    // 7. Parse the LLM's JSON output (tolerant of markdown / prose wrappers).
    const parsed = parseLlmJson(result.content);
    if (!parsed.success) {
      return { error: "PARSE_FAILED", storageField: field };
    }

    return {
      draft: parsed.data,
      raw: result.content,
      sourceMode: "internal_llm",
      storageField: field,
    };
  }

  /**
   * Build a fully-assembled prompt for an external chat tool (B5).
   *
   * This does NOT call the LLM and does NOT touch the usage budget — it only
   * composes the prompt text, hashes it, and returns a description of the
   * expected JSON shape. It works even when no LLM provider is configured. The
   * caller (typically an operator) pastes the returned `prompt` into an
   * external chat tool, then confirms the result via `/confirm`.
   *
   * `collocation` is dictionary-grounded (B3): the service looks up candidates
   * before composing the prompt. With no provider, a throwing provider, or
   * empty candidates it returns a structured `{ error: "NO_DICTIONARY_CANDIDATES",
   * warning, storageField }` result (the route maps this to 422) — the LLM is
   * never consulted. With candidates the prompt carries them so an external tool
   * is constrained to the same dictionary candidates as the internal flow.
   *
   * Throws a structured {@link ValidationError} when `styleProfileId`'s field
   * scope doesn't include the requested field (mapped to 400 by the route).
   */
  async buildExternalPrompt(
    word: WordContext,
    field: L2Field,
    inputOptions: BuildExternalPromptOptions = {},
  ): Promise<BuildExternalPromptResult> {
    const options = normalizeExternalPromptOptions(inputOptions);

    // Style profile resolution (B4). For corpus/example + collocation, resolve
    // and validate the profile's field scope so a mismatched profile fails fast.
    // `corpus` is the storage name for the `example` composer field.
    let styleProfile: L2StyleProfile | undefined;
    if (options.styleProfileId && (field === "collocation" || field === "corpus")) {
      try {
        styleProfile = resolveStyleProfile(options.styleProfileId, field);
      } catch (err) {
        throw new ValidationError(
          `Style profile "${options.styleProfileId}" is invalid for field "${field}"`,
          field,
          err,
        );
      }
    } else if (options.styleProfileId) {
      // styleProfileId provided for synonym/antonym — those don't consume
      // profiles; surface as a validation error rather than silently ignoring.
      throw new ValidationError(
        `Style profile "${options.styleProfileId}" is invalid for field "${field}"`,
        field,
      );
    }

    // ── Dictionary grounding for collocation (B3) ───────────────────────────
    // Same contract as generateDraft: the dictionary is the sole source of
    // which phrases exist, so the external prompt must be grounded on real
    // candidates too. No provider / throwing provider / empty candidates →
    // structured error (route → 422), no LLM, no usage.
    let dictionaryCandidates: DictionaryCandidate[] | undefined;
    if (field === "collocation") {
      const dictionaryProvider = this.deps.dictionaryProvider;
      if (!dictionaryProvider) {
        return {
          error: "NO_DICTIONARY_CANDIDATES",
          warning: "Dictionary provider not configured",
          storageField: field,
        };
      }

      let candidates: DictionaryCandidate[];
      try {
        const lookup = await dictionaryProvider.lookupCollocations({
          lemma: word.lemma,
          pos: word.pos,
          limit: options.count ?? 5,
        });
        candidates = lookup.candidates;
      } catch (err) {
        // Provider failure degrades like an empty lookup — no candidates, with a
        // warning describing the failure. LLM is NOT called on failure.
        return {
          error: "NO_DICTIONARY_CANDIDATES",
          warning: `Dictionary lookup failed: ${(err as Error).message}`,
          storageField: field,
        };
      }

      if (candidates.length === 0) {
        return {
          error: "NO_DICTIONARY_CANDIDATES",
          warning: "No dictionary candidates found",
          storageField: field,
        };
      }

      dictionaryCandidates = candidates;
    }

    // Compose the prompt messages (same builder used by generateDraft, so the
    // external prompt is byte-identical to what the internal LLM would receive).
    const messages = buildPromptForField(field, word, {
      styleProfile,
      dictionaryCandidates,
      count: options.count,
      userInstruction: options.userInstruction,
    });

    // Stable, human-readable prompt text: join messages with role markers so
    // the hash covers the full prompt (system + user), not just one message.
    // P3: append a v1-first output-format instruction so an external chat tool
    // emits the v1 document wrapper `{ schemaVersion, field, items }` with
    // item-level `provenance.source`. External-prompt output always uses
    // "external_chat"; collocation also carries dictionary evidence. This
    // instruction is part of the hashed prompt text so promptVersion/promptHash
    // stay consistent with what the operator pastes into the external tool.
    const composerField = field === "corpus" ? "example" : field;
    const provenanceSourceHint =
      field === "collocation"
        ? 'Each item must include provenance.source = "external_chat" and evidence (dictionaryName / dictionaryUrl / rawPhrase). The phrase must equal one phrase from dictionaryCandidates.'
        : '每个 item 必须带 provenance.source = "external_chat"。';
    const v1FormatInstruction = `\n\n【输出格式 / Output format】
请输出 l2-content-v1 格式的 JSON document：
{"schemaVersion":"l2-content-v1","field":"${composerField}","items":[{...}]}
${provenanceSourceHint}`;

    const promptText =
      messages
        .map((m) => `## ${m.role}\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
        .join("\n\n") + v1FormatInstruction;

    const promptHash = createHash("sha256").update(promptText, "utf8").digest("hex");

    // Composer-facing field name in the version tag: `example` for corpus.
    const composerTag = field === "corpus" ? "example" : field;
    const promptVersion = `l2-${composerTag}-external-v1`;

    return {
      storageField: field,
      styleProfileId: styleProfile?.id ?? "default",
      promptVersion,
      promptHash,
      prompt: promptText,
      expectedJsonSchema: describeExpectedJsonSchema(field, styleProfile),
    };
  }

  /**
   * Build a dictionary-only collocation draft (B3). Each candidate becomes an
   * item carrying `provenance.source = "dictionary"` plus the dictionary name
   * and URL as evidence, so the origin is never lost even when the LLM is
   * absent. Fields the dictionary doesn't provide (gloss/tone/example) are
   * left absent rather than fabricated.
   */
  private buildDictionaryOnlyDraft(candidates: DictionaryCandidate[]): unknown {
    return candidates.map((c) => ({
      phrase: c.phrase,
      ...(c.meaning ? { gloss: c.meaning } : {}),
      ...(c.example ? { example: c.example, exampleTranslation: "" } : {}),
      provenance: {
        source: "dictionary" as const,
        dictionaryName: c.sourceName,
        ...(c.sourceEntryId ? { dictionaryEntryId: c.sourceEntryId } : {}),
        ...(c.sourceUrl ? { dictionaryUrl: c.sourceUrl } : {}),
      },
      evidence: {
        dictionaryName: c.sourceName,
        ...(c.sourceUrl ? { dictionaryUrl: c.sourceUrl } : {}),
        rawPhrase: c.headword ?? c.phrase,
        ...(c.example ? { rawExample: c.example } : {}),
      },
    }));
  }

  /**
   * Persist a confirmed draft and cascade the L2 cache + recheck.
   * Runs inside a single transaction so the insert, cache refresh, and
   * recheck-marker are atomic.
   *
   * The fourth parameter accepts either a legacy `source: string` (back-compat
   * — existing call sites/tests that pass `"manual"` keep working) or a
   * {@link ConfirmDraftOptions} object carrying `source`, `sourceRef`, and
   * `approvedBy`. `sourceRef` reaches `word_l2_content.source_ref` and
   * `approvedBy` (default `"user"`) reaches `word_l2_content.approved_by`.
   */
  async confirmDraft(
    wordId: string,
    field: L2Field,
    content: unknown,
    options?: string | ConfirmDraftOptions,
  ): Promise<void> {
    const opts = normalizeConfirmOptions(options);
    const source = opts.source ?? "manual";
    const sourceRef = opts.sourceRef ?? null;
    const approvedBy = opts.approvedBy ?? "user";

    // 0. Field-specific content validation — reject malformed structures before
    //    touching the DB. This is a defense-in-depth check (the HTTP layer also
    //    validates) so callers that bypass HTTP can't write bad rows. Throws a
    //    structured ValidationError (→ 422 via errorToResponse) on mismatch.
    try {
      assertJsonResourceBudget(content, {
        maxBytes: L2_CONTENT_MAX_BYTES,
        maxDepth: JSON_MAX_DEPTH,
      });
    } catch (err) {
      throw new ValidationError(
        `L2 content exceeds serialized size or depth budget`,
        field,
        err,
      );
    }

    let parsed: unknown;
    try {
      parsed = parseL2Content(field, content);
    } catch (err) {
      throw new ValidationError(
        `Invalid L2 content for field "${field}"`,
        field,
        err,
      );
    }

    await withTransaction(async (tx) => {
      const repos = createRepositories(tx);

      // 1. Write the L2 content row.
      await repos.l2Content.insert({
        word_id: wordId,
        field,
        // Cast the *parsed* (schema-validated) value rather than the raw input.
        // The repository stores `Json`; the cast bridges the typed schema
        // output to the repository's loose `Json`/`content` column type.
        content: parsed as never,
        source,
        source_ref: sourceRef,
        approved_by: approvedBy,
      });

      // 2. Refresh the words JSONB cache columns from all active rows.
      await repos.l2Content.refreshL2Cache(wordId);

      // 3. Re-read the word (cache columns just updated) and recompute L2 hash.
      //    SELECT * returns the L2 JSONB columns even though WordRow omits them.
      const word = await repos.words.findById(wordId);
      if (word) {
        const l2Hash = computeL2Hash(word as never);
        // 4. Only re-trigger L2 cards whose snapshot changed (L1 untouched).
        await repos.l2Progress.markL2StaleForRecheck(wordId, l2Hash);
      }
    });
  }
}
