/**
 * Prompt registry — maps each L2Field to the prompt builder that produces its
 * LLM messages, encapsulating the per-field config (item count, CEFR target,
 * domain preference, …).
 *
 * Centralizing this mapping here lets `L2ContentService.generateDraft` look up
 * the builder by field key (`promptBuilders[field](word)`) instead of a
 * multi-case switch, lowering the method's cyclomatic complexity. The per-field
 * config values are the same that previously lived inline in the switch.
 *
 * The registry is a `Record<L2Field, …>` (exhaustive over the four fields), so
 * adding a new field is a compile error until a builder is registered — no
 * silent `undefined` branch at runtime.
 */

import type { LlmMessage } from "../provider";
import type { L2Field } from "../../schemas/service";
import type { DictionaryCandidate } from "../../dictionary/provider";
import type { L2StyleProfile } from "../../domain/l2-style-profile";
import { buildCollocationPrompt } from "./collocations";
import { buildExamplePrompt } from "./examples";
import { buildSynonymPrompt } from "./synonyms";
import { buildAntonymPrompt } from "./antonyms";

/**
 * Structural word context accepted by every prompt builder.
 *
 * Each prompt module declares its own `WordContext` interface with this exact
 * shape, so a value typed against this interface satisfies all of them
 * structurally (TypeScript structural typing). We re-declare it here rather
 * than importing from the service layer so the llm layer stays decoupled from
 * services (architecture: llm must not depend on services).
 */
export interface PromptWordContext {
  lemma: string;
  pos: string;
  semanticField: string;
  shortDefinition: string;
  cefrTarget: string;
}

/**
 * Options threaded through to the per-field prompt builders.
 *
 * - `styleProfile` (B4): applies to `corpus`/example prompts; the profile's
 *   register/difficulty/domains rules override the legacy config defaults.
 * - `dictionaryCandidates` (B3): applies to the `collocation` prompt; when
 *   present the LLM is constrained to only refine candidates from the list.
 * - `count`: overrides the default item count for a field.
 * - `userInstruction`: free-text guidance appended to the prompt (reserved for
 *   B5's external-prompt flow; ignored by builders that don't yet consume it).
 *
 * Every option is optional and builders ignore options they don't use, so
 * `buildPromptForField(field, word)` with no options keeps working unchanged.
 */
export interface PromptBuildOptions {
  styleProfile?: L2StyleProfile;
  dictionaryCandidates?: DictionaryCandidate[];
  count?: number;
  userInstruction?: string;
}

/** Builds the LLM message array for a single field given a word's context. */
export type PromptBuilder = (
  word: PromptWordContext,
  options?: PromptBuildOptions,
) => LlmMessage[];

/**
 * Exhaustive field → prompt-builder registry.
 *
 * Config values mirror the previous inline switch:
 *   collocation → 3 items, CEFR-targeted
 *   corpus      → 2 items, 科技/商业 domains, CEFR difficulty
 *   synonym     → 3 items
 *   antonym     → 2 items (buildAntonymPrompt; same JSON shape as synonym)
 *
 * Each builder receives the {@link PromptBuildOptions} so it can opt into the
 * dictionary-grounded (collocation) or style-profile-driven (corpus) prompt
 * paths; options are ignored by builders that don't consume them.
 */
export const promptBuilders: Record<L2Field, PromptBuilder> = {
  collocation: (word, options) =>
    buildCollocationPrompt(
      word,
      { count: options?.count ?? 3, cefrTarget: word.cefrTarget },
      { dictionaryCandidates: options?.dictionaryCandidates },
    ),
  corpus: (word, options) =>
    buildExamplePrompt(
      word,
      {
        domains: options?.styleProfile?.promptRules.domains ?? ["科技", "商业"],
        difficulty:
          options?.styleProfile?.promptRules.difficulty ?? word.cefrTarget,
        count: options?.count ?? options?.styleProfile?.promptRules.maxItems ?? 2,
      },
      { styleProfile: options?.styleProfile },
    ),
  synonym: (word, options) => buildSynonymPrompt(word, { count: options?.count ?? 3 }),
  antonym: (word, options) => buildAntonymPrompt(word, { count: options?.count ?? 2 }),
};

/**
 * Resolve the prompt messages for a given L2 field and word.
 *
 * Thin convenience wrapper over the registry; `generateDraft` calls this so the
 * lookup + invocation stays in one place. Throws nothing on its own — an
 * unknown field is a *compile-time* error because `L2Field` is a closed union
 * and the registry is exhaustive.
 */
export function buildPromptForField(
  field: L2Field,
  word: PromptWordContext,
  options?: PromptBuildOptions,
): LlmMessage[] {
  return promptBuilders[field](word, options);
}
