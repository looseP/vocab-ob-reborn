# Phase 2D: L2 Composer Contract Upgrade 实施计划

> **For agentic workers:** implement this plan task-by-task with TDD. Keep the existing 337-test baseline green after each major task. Do not start Phase 3/L3 and do not touch frontend code in this phase.

## Goal

把 L2 从当前的 `LLM draft/confirm` 升级成可实施的 **L2 Composer contract**：

- dictionary-grounded collocation
- style-profile-driven example/corpus
- external prompt API
- `l2-content-v1` wrapper schema
- item-level provenance/evidence
- backward-compatible legacy L2 array content

## Current Baseline

- Phase 0/1/2A/2B/2B hardening/2C 已完成。
- 当前验收基线：337 tests passing，typecheck 0 error，arch:check 0 violation，db:generate 0 diff。
- 当前字段：`collocation | corpus | synonym | antonym`。
- 产品字段“例句”短期映射为 storage field `corpus`，不要改 DB 列名 `words.corpus_items`。

## Required Reading

- `src/services/l2-content.service.ts`
- `src/http/routes/l2.ts`
- `src/schemas/service/index.ts`
- `src/repositories/l2-content.repository.ts`
- `src/services/index.ts`
- `src/llm/prompts/index.ts`
- `src/llm/prompts/collocations.ts`
- `src/llm/prompts/examples.ts`
- `docs/adr/0003-llm-provider-and-l2-extension.md`
- `docs/adr/0004-purpose-stack-patterns-philosophy.md`
- `docs/adr/0005-l3-context-space-boundary.md`
- `docs/design/l2-composer/l2-composer-style-profile-content-provenance-design.md`

## Non-Negotiable Contract Fixes

1. **Do not change `parseL2Content()` into a `{ success, data }` API.**  
   Current service code expects `parseL2Content(field, content)` to return parsed content on success and throw on invalid content. Keep that contract. If a boolean result is needed, add or update `safeParseL2Content()` / `isValidL2Content()`.

2. **No-LLM behavior is field/source-mode specific.**  
   - `example/corpus` internal draft requires LLM; without LLM, return `L2_CONTENT_UNAVAILABLE`.
   - `collocation` can return dictionary-only draft when dictionary candidates exist.
   - `confirmDraft()` must not require LLM.

3. **Dictionary grounding is candidate grounding, not absolute truth.**  
   Datamuse can provide useful free candidates, but it is not a full authoritative collocation dictionary. Treat it as a `DictionaryProvider` candidate source with provenance/evidence, not as unquestionable truth.

4. **Do not import app errors into schema modules.**  
   `src/schemas/service/index.ts` should stay mostly pure. Route/service layers decide HTTP status and error shape.

5. **Do not add git commit steps.**  
   The implementer should modify files and report results; do not require commits unless the user explicitly asks.

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `src/domain/l2-style-profile.ts` | Built-in style profile registry |
| `src/dictionary/provider.ts` | Dictionary provider interfaces/types |
| `src/dictionary/normalizer.ts` | POS-aware dictionary candidate normalization |
| `src/dictionary/providers/datamuse.ts` | Datamuse candidate provider with mocked tests |
| `src/dictionary/index.ts` | Barrel + `createDictionaryProvider()` |
| `tests/domain/l2-style-profile.test.ts` | Style profile tests |
| `tests/dictionary/datamuse.test.ts` | Datamuse provider tests with mocked fetch |

### Modified Files

| File | Change |
|---|---|
| `src/services/index.ts` | Always create `L2ContentService`; LLM deps optional |
| `src/services/l2-content.service.ts` | deps object, dictionary-grounded collocation, style profile options, external prompt helper |
| `src/schemas/service/index.ts` | field mapping, v1 wrapper schema, provenance/evidence, safe parse helper |
| `src/repositories/l2-content.repository.ts` | `extractL2Items()` and `refreshL2Cache()` flatten |
| `src/http/routes/l2.ts` | `example -> corpus`, confirm body compatibility, external-prompt endpoint |
| `src/server.ts` | optional DictionaryProvider assembly |
| `.dependency-cruiser.cjs` | dictionary layer boundary rule if needed |

---

## Task A1: Field Mapping (`example -> corpus`)

**Files**

- Modify: `src/schemas/service/index.ts`
- Modify: `src/http/routes/l2.ts`
- Test: `tests/http/l2.test.ts`

### Requirements

- Keep storage fields: `collocation | corpus | synonym | antonym`.
- Add composer/product fields: `collocation | example`.
- Route accepts both `example` and legacy `corpus`.
- `example` maps to `corpus` before service calls.
- Do not throw `ValidationError` from schema module.

### Suggested API

```ts
export const L2_FIELDS = ["collocation", "corpus", "synonym", "antonym"] as const;
export type L2Field = (typeof L2_FIELDS)[number];

export const L2_COMPOSER_FIELDS = ["collocation", "example"] as const;
export type L2ComposerField = (typeof L2_COMPOSER_FIELDS)[number];

export type L2RouteField = L2Field | L2ComposerField;

export function mapToStorageField(field: unknown): L2Field | null {
  if (field === "example") return "corpus";
  if (typeof field === "string" && (L2_FIELDS as readonly string[]).includes(field)) {
    return field as L2Field;
  }
  return null;
}

export function toComposerField(field: L2Field): L2ComposerField | "synonym" | "antonym" {
  return field === "corpus" ? "example" : field;
}
```

### Tests

- `POST /api/l2/:slug/draft` with `field=example` calls service with `field=corpus`.
- `POST /api/l2/:slug/confirm` with `field=example` calls service with `field=corpus`.
- `field=corpus` still works.
- invalid field returns 400.

---

## Task A2: v1 Wrapper Schema + Provenance/Evidence

**Files**

- Modify: `src/schemas/service/index.ts`
- Test: add schema-focused tests or extend `tests/services/l2-content.test.ts`

### Critical Contract

Keep:

```ts
export function parseL2Content(field: L2Field, content: unknown): unknown {
  // returns parsed content or throws
}
```

Add/keep safe helper:

```ts
export function safeParseL2Content(
  field: L2Field,
  content: unknown,
): { success: true; data: unknown } | { success: false; error: unknown } {
  try {
    return { success: true, data: parseL2Content(field, content) };
  } catch (error) {
    return { success: false, error };
  }
}
```

`isValidL2Content()` can use `safeParseL2Content()`.

### v1 Source Enum

```ts
export const l2ContentSourceSchema = z.enum([
  "manual",
  "llm",
  "llm_edited",
  "external_chat",
  "dictionary",
  "dictionary_llm_refined",
]);
```

### Provenance

```ts
export const l2ProvenanceSchema = z.object({
  source: l2ContentSourceSchema,
  provider: z.string().optional(),
  model: z.string().optional(),
  styleProfileId: z.string().optional(),
  styleProfileVersion: z.string().optional(),
  promptVersion: z.string().optional(),
  promptHash: z.string().optional(),
  dictionaryName: z.string().optional(),
  dictionaryEntryId: z.string().optional(),
  dictionaryUrl: z.string().optional(),
  externalTool: z.string().optional(),
  generatedAt: z.string().optional(),
  confirmedAt: z.string().optional(),
  userEdited: z.boolean().optional(),
  confidence: z.number().optional(),
  note: z.string().optional(),
}).passthrough();
```

### Evidence

```ts
export const l2EvidenceSchema = z.object({
  dictionaryName: z.string().optional(),
  dictionaryEntryId: z.string().optional(),
  dictionaryUrl: z.string().optional(),
  rawPhrase: z.string().optional(),
  rawExample: z.string().optional(),
}).passthrough();
```

### v1 Collocation Item

```ts
export const l2CollocationV1ItemSchema = z.object({
  phrase: z.string().trim().min(1),
  meaning: z.string().optional(),
  gloss: z.string().optional(),
  translation: z.string().optional(),
  example: z.string().optional(),
  exampleTranslation: z.string().optional(),
  pattern: z.string().optional(),
  tone: z.string().optional(),
  register: z.string().optional(),
  tags: z.array(z.string()).optional(),
  note: z.string().optional(),
  evidence: l2EvidenceSchema.optional(),
  provenance: l2ProvenanceSchema,
}).passthrough().superRefine((item, ctx) => {
  if (
    (item.provenance.source === "dictionary" ||
      item.provenance.source === "dictionary_llm_refined") &&
    !item.provenance.dictionaryName &&
    !item.evidence?.dictionaryName
  ) {
    ctx.addIssue({
      code: "custom",
      message: "dictionary collocation requires dictionaryName in provenance or evidence",
      path: ["evidence", "dictionaryName"],
    });
  }
});
```

### v1 Corpus/Example Item

```ts
export const l2CorpusV1ItemSchema = z.object({
  sentence: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1).optional(),
  translation: z.string().optional(),
  usageNote: z.string().optional(),
  pattern: z.string().optional(),
  register: z.string().optional(),
  difficulty: z.string().optional(),
  source: z.string().optional(),
  styleProfileId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  provenance: l2ProvenanceSchema,
}).passthrough().refine((item) => Boolean(item.sentence || item.text), {
  message: "Either sentence or text is required",
});
```

### v1 Wrapper

```ts
export const l2ContentV1Schema = z.object({
  schemaVersion: z.literal("l2-content-v1"),
  field: z.enum(["collocation", "corpus", "example", "synonym", "antonym"]),
  items: z.array(z.unknown()).min(1),
}).passthrough();
```

### parse behavior

- If content is v1 wrapper:
  - Map wrapper `field=example` to `corpus`.
  - Require wrapper field to match the requested storage field after mapping.
  - Validate items by requested storage field.
  - Return parsed wrapper, preserving `schemaVersion`, `field`, `items`, provenance/evidence.
- If content is legacy array:
  - Use existing legacy schemas.
  - Do not weaken existing required fields unless tests explicitly cover the new relaxed contract.

### Tests

- `parseL2Content("collocation", v1Wrapper)` returns parsed content, not `{ success }`.
- `safeParseL2Content("collocation", v1Wrapper).success === true`.
- v1 collocation without `provenance.source` is rejected.
- dictionary/dictionary_llm_refined collocation without dictionary evidence is rejected.
- v1 corpus supports `sentence`.
- v1 corpus supports legacy `text`.
- v1 corpus without provenance is rejected.
- legacy array fixtures still pass using the current complete legacy fixture shapes.

---

## Task A3: `refreshL2Cache()` Flatten

**Files**

- Modify: `src/repositories/l2-content.repository.ts`
- Test: `tests/repositories/l2-content.test.ts`

### Requirements

Current implementation pushes `row.content` as a single item. Phase 2D needs stable cache item arrays.

Implement:

```ts
export function extractL2Items(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;

  if (content && typeof content === "object") {
    const maybe = content as { schemaVersion?: unknown; items?: unknown };
    if (maybe.schemaVersion === "l2-content-v1" && Array.isArray(maybe.items)) {
      return maybe.items;
    }
    return [content];
  }

  return [];
}
```

Update:

```ts
grouped[row.field].push(...extractL2Items(row.content));
```

### Tests

- legacy array row becomes flat cache items.
- v1 wrapper row becomes flat `items`.
- single object row becomes one item.
- multiple active rows merge in query order.
- absent field still writes empty array.

---

## Task A4: L2ContentService Always Available

**Files**

- Modify: `src/services/index.ts`
- Modify: `src/services/l2-content.service.ts`
- Modify: `src/http/routes/l2.ts`
- Test: `tests/services/l2-content.test.ts`
- Test: `tests/http/l2.test.ts`

### Requirements

- `createServices()` should always return `l2content`.
- `L2ContentService` should accept a deps object.
- LLM provider and usage tracker are optional but must be treated as a pair for LLM-backed draft.
- `confirmDraft()` must work without LLM.
- `draft` route can still return 503 when the requested draft mode requires unavailable dependencies.

### Suggested Service Constructor

```ts
export interface L2ContentServiceDeps {
  llmProvider?: LlmProvider;
  usageTracker?: UsageTracker;
  dictionaryProvider?: DictionaryProvider;
}

export class L2ContentService {
  constructor(private readonly deps: L2ContentServiceDeps = {}) {}
}
```

### GenerateDraft Result

Extend without breaking existing error handling:

```ts
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
  sourceMode?: "internal_llm" | "dictionary" | "dictionary_llm_refined";
  storageField?: L2Field;
}
```

### Tests

- `confirmDraft()` works with `new L2ContentService({})`.
- `generateDraft(word, "corpus", options)` returns `L2_CONTENT_UNAVAILABLE` when no LLM deps.
- HTTP confirm without LLM service deps still works for manual/external content.
- HTTP draft maps `L2_CONTENT_UNAVAILABLE` to 503.

---

## Task B1: Style Profile Registry

**Files**

- Create: `src/domain/l2-style-profile.ts`
- Test: `tests/domain/l2-style-profile.test.ts`

### Requirements

- No DB table in this phase.
- Built-in profiles only.
- Field scope uses product fields: `collocation | example`.
- Route/service maps `corpus` to product field `example` for validation.

### Suggested Types

```ts
export type L2StyleProfileField = "collocation" | "example";

export interface L2StyleProfile {
  id: string;
  version: string;
  label: string;
  fieldScope: L2StyleProfileField[];
  description?: string;
  promptRules: {
    register?: "neutral" | "academic" | "spoken" | "exam" | "literary" | "formal" | "informal";
    difficulty?: string;
    cefrRange?: string[];
    domains?: string[];
    sentenceLength?: "short" | "medium" | "long";
    includeTranslation?: boolean;
    includeUsageNote?: boolean;
    includePattern?: boolean;
    avoidRareWords?: boolean;
    avoidCliches?: boolean;
    examReady?: boolean;
    maxItems?: number;
  };
}
```

### Built-ins

Minimum:

- `default`
- `postgraduate_essay`
- `academic`
- `daily_spoken`
- `core_collocation`
- `exam_collocation`

Optional if desired:

- `academic_collocation`

### Functions

```ts
export function getStyleProfile(id?: string): L2StyleProfile;
export function findStyleProfile(id: string): L2StyleProfile | undefined;
export function validateStyleProfileField(
  profile: L2StyleProfile,
  field: L2StyleProfileField,
): void;
```

### Tests

- default profile resolves when id omitted.
- profile ids are unique.
- `postgraduate_essay` rejects `collocation`.
- `core_collocation` accepts `collocation`.
- `core_collocation` rejects `example`.

---

## Task B2: DictionaryProvider + POS-Aware Datamuse Candidate Provider

**Files**

- Create: `src/dictionary/provider.ts`
- Create: `src/dictionary/normalizer.ts`
- Create: `src/dictionary/providers/datamuse.ts`
- Create: `src/dictionary/index.ts`
- Test: `tests/dictionary/datamuse.test.ts`

### Provider Contract

```ts
export interface DictionaryCandidate {
  phrase: string;
  headword?: string;
  pos?: string;
  meaning?: string;
  example?: string;
  sourceName: string;
  sourceEntryId?: string;
  sourceUrl?: string;
  relation?: string;
  score?: number;
  raw?: unknown;
}

export interface DictionaryLookupResult {
  candidates: DictionaryCandidate[];
  warning?: string;
}

export interface DictionaryProvider {
  lookupCollocations(params: {
    lemma: string;
    pos?: string;
    limit?: number;
  }): Promise<DictionaryLookupResult>;
}
```

### Datamuse Guidance

Do not hardcode only `rel_jjb` with `${lemma} ${word}` for every POS.

Use POS-aware lookup:

- adjective lemma: query nouns modified by adjective, likely `rel_jja=<lemma>`, phrase `${lemma} ${word}`.
- noun lemma: query adjectives often used with noun, likely `rel_jjb=<lemma>`, phrase `${word} ${lemma}`.
- verb/adverb/unknown: either query broader related candidates or return empty with warning if relation is not reliable.

This provider is a free candidate source. Keep source/evidence explicit:

- `sourceName = "Datamuse"`
- `relation = "rel_jja" | "rel_jjb" | ...`
- `sourceUrl` should include the query URL when practical.

### Testing

- Mock `global.fetch`; no real network tests.
- adjective case returns phrase order `abundant rainfall` for `lemma=abundant` + Datamuse word `rainfall`.
- noun case returns phrase order `heavy rain` for `lemma=rain` + Datamuse word `heavy`.
- non-OK response returns empty candidates + warning.
- rejected fetch returns empty candidates + warning.

---

## Task B3: Dictionary-Grounded Collocation Draft

**Files**

- Modify: `src/services/l2-content.service.ts`
- Modify: `src/llm/prompts/collocations.ts`
- Modify: `src/llm/prompts/index.ts`
- Modify: `src/server.ts`
- Test: `tests/services/l2-content.test.ts`
- Test: `tests/llm/prompts.test.ts`

### Requirements

- `collocation` default source mode: `dictionary_llm_refined`.
- Call DictionaryProvider before LLM.
- If dictionary has no candidates, return `NO_DICTIONARY_CANDIDATES`; do not call LLM.
- If dictionary has candidates but no LLM deps, return dictionary-only draft with `sourceMode = "dictionary"`.
- If dictionary has candidates and LLM deps are available, refine via LLM.
- LLM prompt must explicitly say it may only use provided dictionary candidates.
- LLM output should be parsed and schema validated before returning draft where practical.

### GenerateDraft Options

Replace the third `source: string` parameter with an options object, while updating all call sites/tests:

```ts
export interface GenerateDraftOptions {
  source?: string;
  sourceMode?: "internal_llm" | "dictionary" | "dictionary_llm_refined";
  styleProfileId?: string;
  refreshMode?: "replace_all" | "append_more";
  count?: number;
  userInstruction?: string;
  allowUngrounded?: boolean;
}
```

If keeping backwards compatibility is easier, accept both:

```ts
sourceOrOptions?: string | GenerateDraftOptions
```

and normalize internally.

### Prompt Builder Contract

Current `buildPromptForField(field, word)` is not enough. Extend to:

```ts
export interface PromptBuildOptions {
  styleProfile?: L2StyleProfile;
  dictionaryCandidates?: DictionaryCandidate[];
  count?: number;
  userInstruction?: string;
}

export function buildPromptForField(
  field: L2Field,
  word: PromptWordContext,
  options?: PromptBuildOptions,
): LlmMessage[];
```

Keep old calls working with `options` omitted.

### Tests

- collocation calls dictionary first.
- dictionary empty does not call LLM.
- dictionary candidates but no LLM returns dictionary-only draft.
- LLM prompt contains serialized dictionary candidates.
- LLM prompt contains “do not invent” / equivalent grounding instruction.
- no `usageTracker.record()` when LLM is not called.
- budget checked only before actual LLM call.

---

## Task B4: Example/Corpus Draft + Style Profile

**Files**

- Modify: `src/services/l2-content.service.ts`
- Modify: `src/llm/prompts/examples.ts`
- Modify: `src/llm/prompts/index.ts`
- Modify: `src/http/routes/l2.ts`
- Test: `tests/http/l2.test.ts`
- Test: `tests/services/l2-content.test.ts`
- Test: `tests/llm/prompts.test.ts`

### Requirements

- `field=example` route maps to storage `corpus`.
- example/corpus internal draft requires LLM deps.
- `styleProfileId` applies to example/corpus prompt.
- mismatched profile field scope returns 400 at route layer or validation error at service layer.
- style profile prompt influence should be testable.

### Tests

- `POST /api/l2/:slug/draft { field: "example", styleProfileId: "academic" }` calls service with `field="corpus"` and options containing `styleProfileId`.
- mismatched `styleProfileId="core_collocation"` with `field="example"` returns 400.
- example prompt includes selected profile rules.
- existing `field="corpus"` tests still pass.

---

## Task B5: External Prompt API

**Files**

- Modify: `src/http/routes/l2.ts`
- Modify: `src/services/l2-content.service.ts`
- Test: `tests/http/l2.test.ts`

### Endpoint

```http
POST /api/l2/:slug/external-prompt
```

### Requirements

- Does not call LLM.
- Does not consume usage budget.
- Works even when LLM provider is not configured.
- Accepts `field`, `styleProfileId`, `count`, `userInstruction`.
- Maps `field=example` to storage `corpus`.
- Validates style profile field scope.

### Response

```ts
{
  field: "example",
  storageField: "corpus",
  styleProfileId: "postgraduate_essay",
  promptVersion: "l2-example-external-v1",
  promptHash: "...",
  prompt: "...",
  expectedJsonSchema: { ... }
}
```

### Tests

- returns prompt without calling LLM.
- works without LLM provider configured.
- invalid field returns 400.
- mismatched styleProfileId returns 400.

---

## Task B6: Confirm Body Compatibility + Source Metadata

**Files**

- Modify: `src/http/routes/l2.ts`
- Modify: `src/services/l2-content.service.ts`
- Modify: `src/repositories/interfaces.ts`
- Test: `tests/http/l2.test.ts`
- Test: `tests/services/l2-content.test.ts`

### Supported Bodies

Legacy:

```ts
{ field, content, source }
```

New items shorthand:

```ts
{ field, items, source, sourceRef }
```

New document:

```ts
{ field, document, source, sourceRef }
```

### Route Normalization

- `document` wins over `items`.
- `items` becomes `{ schemaVersion: "l2-content-v1", field: storageField, items }`.
- legacy `content` remains unchanged.
- `field=example` maps to `corpus`.
- pass source metadata to service.

### Service Contract

Prefer:

```ts
export interface ConfirmDraftOptions {
  source?: string;
  sourceRef?: string | null;
  approvedBy?: string | null;
}

confirmDraft(
  wordId: string,
  field: L2Field,
  content: unknown,
  options?: string | ConfirmDraftOptions,
): Promise<void>
```

If `options` is a string, treat it as legacy `source`.

Repository insert should receive:

```ts
{
  word_id,
  field,
  content: parsed,
  source,
  source_ref: sourceRef,
  approved_by: approvedBy ?? "user",
}
```

### Tests

- legacy body still works.
- `{ items }` body wraps into v1 document and confirms.
- `{ document }` body confirms.
- `sourceRef` reaches repository insert as `source_ref`.
- `field=example` confirms with storage field `corpus`.

---

## Task B7: Architecture Boundary

**Files**

- Modify: `.dependency-cruiser.cjs` if needed
- Test/verify: `npm run arch:check`

### Requirements

- `src/dictionary` must not import `src/db`, `src/repositories`, `src/services`.
- `src/llm` must not import `src/db` or `src/repositories`.
- `src/services` may orchestrate `dictionary`, `llm`, and repositories.
- `src/http` must not directly import `src/db`, `src/repositories`, or `src/llm`.

If current dependency rules already enforce enough, document that no rule change was needed.

---

## Task B8: Final Verification

Run:

```bash
npm run typecheck
npm run arch:check
npm run test
npm run db:generate
```

Expected:

- typecheck: zero errors
- arch:check: zero violations
- tests: all pass, with new Phase 2D tests added
- db:generate: zero diff, no migration generated

Final report must include:

- files changed
- test counts
- whether a migration was produced
- any remaining Phase 3/L3 risks

---

## Acceptance Checklist

- [ ] `example -> corpus` mapping implemented without DB rename
- [ ] `parseL2Content()` preserves return-or-throw contract
- [ ] safe parse helper available for route/tests
- [ ] v1 wrapper schema with item-level provenance/evidence
- [ ] legacy array content still supported
- [ ] `refreshL2Cache()` flattens legacy arrays, v1 wrapper items, and single objects
- [ ] `L2ContentService` always exists
- [ ] `confirmDraft()` works without LLM
- [ ] `example/corpus` draft returns unavailable without LLM deps
- [ ] collocation draft uses dictionary first
- [ ] collocation with dictionary candidates can return dictionary-only draft without LLM
- [ ] collocation LLM prompt is candidate-grounded and forbids invented collocations
- [ ] Style Profile Registry has built-in profiles and field-scope validation
- [ ] External Prompt API works without LLM and without usage budget
- [ ] confirm body supports legacy content, items shorthand, and document wrapper
- [ ] sourceRef reaches `word_l2_content.source_ref`
- [ ] architecture boundaries remain green
- [ ] `npm run typecheck` passes
- [ ] `npm run arch:check` passes
- [ ] `npm run test` passes
- [ ] `npm run db:generate` produces zero diff
