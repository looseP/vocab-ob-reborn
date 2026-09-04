# ADR-0006: L2 Composer Contract Freeze (Phase 2E)

- **Status**: Accepted
- **Date**: 2026-07-07（Phase 2E 建立）
- **Builds on**: ADR-0003（LLM Provider + L2 扩展两阶段闭环）
- **Phase**: Phase 2E
- **Amended**: Phase 2E.1 final seal — external-prompt collocation grounding,
  v1-first output, and machine-generated collocation evidence.

## Context

Phase 2B–2D built the L2 Composer: a draft → external-prompt → confirm flow
that generates and persists multi-source L2 enrichment content (collocation /
corpus / synonym / antonym). By Phase 2E the surface had grown three source
paths (internal LLM, dictionary-grounded, external-prompt) and a v1 content
wrapper carrying per-item provenance/evidence.

A review surfaced one **blocking** correctness gap — the dictionary-grounded
LLM refine path returned the LLM's output verbatim without verifying that
emitted collocations were actually in the dictionary candidate set, so an
LLM that ignored the "do not invent" instruction could persist invented
phrases — plus several contracts that were enforced in code but not pinned by
tests or documented anywhere. Phase 2E freezes the contract so future work
does not silently regress these guarantees.

## Decision

The L2 Composer contract is **frozen** as of Phase 2E. The following
guarantees are now binding (enforced in code + tests + docs), and changing
any of them requires a new ADR.

### 1. L2 Composer is not chat

- No streaming, no multi-turn, no tool-use. Drafts are single-shot JSON.
- The draft endpoint (`POST /api/l2/:slug/draft`) is a one-shot generation call
  that returns a structured draft or error — never a conversational reply.
- There is no "chat" route on the L2 surface.

### 2. Collocation must be dictionary-grounded

- `field=collocation` consults the dictionary provider **before any LLM call**.
- The dictionary is the sole source of which phrases exist; the LLM only
  refines/annotates candidates.
- When there are no candidates — for any reason (no provider, provider failure,
  empty result, no POS relation) — `generateDraft` returns
  `NO_DICTIONARY_CANDIDATES` and **never** falls back to an ungrounded LLM
  draft. (Enforced structurally: the collocation branch returns before
  constructing any LLM prompt.)
- **Ungrounded LLM output is filtered (drop not reject)**: the refine path
  drops any LLM item whose `phrase` is not in the candidate set
  (case-insensitive, trimmed comparison) and surfaces a `warning`, rather than
  rejecting the whole draft. Invented phrases never reach `confirm`/DB.
  *(This is the blocking fix shipped in Phase 2E.)*

### 3. example/corpus uses a style profile

- `field=example` (storage: `corpus`) drafts accept a `styleProfileId`
  (B4). The profile's register/difficulty/domains rules are injected into the
  example prompt.
- A mismatched profile field scope (e.g. a collocation-only profile used for
  example) throws a structured `ValidationError` → 400, **before** the LLM is
  called.
- Style profiles do not override the dictionary-grounding constraint on
  collocation; they only shape the prompt.

### 4. External prompt is non-persistent and non-token-consuming

- `POST /api/l2/:slug/external-prompt` assembles a prompt for an external chat
  tool **without calling `llmProvider` and without touching `usageTracker`**.
- It works with an empty deps object (no LLM configured) — proving the
  external-prompt flow is independent of the LLM subsystem.
- For `field=collocation`, external-prompt follows the same dictionary
  grounding contract as internal draft: dictionary candidates are looked up
  before prompt assembly, and no provider / provider failure / empty candidates
  returns `NO_DICTIONARY_CANDIDATES` instead of producing an ungrounded prompt.
- The returned `prompt` is pasted into an external tool by an operator; the
  result is later confirmed via `/confirm` with a v1 document. External-prompt
  output uses `provenance.source = "external_chat"`; collocation items must also
  carry dictionary evidence (`dictionaryName` and `rawPhrase`). Until confirmed,
  external-prompt output is non-persistent.

### 5. confirm preserves provenance/evidence (v1 wrapper not stripped)

- `confirmDraft` validates content with `parseL2Content` (defense-in-depth;
  the route also pre-validates → 400).
- The v1 wrapper (`{ schemaVersion: "l2-content-v1", field, items }`) and its
  item schemas use `.passthrough()`, so item-level `provenance` and `evidence`
  round-trip through parse → insert intact. Unknown provenance fields survive
  (forward-compatible — no schema bump needed to add metadata).
- Dictionary-sourced collocations (`provenance.source` = `dictionary` |
  `dictionary_llm_refined`) must carry a `dictionaryName` (in provenance or
  evidence); a dictionary claim without a dictionary name is rejected
  (superRefine).
- Phase 2E.1 tightens the v1 collocation contract: every non-`manual`
  collocation source (`llm`, `llm_edited`, `external_chat`, `dictionary`,
  `dictionary_llm_refined`) must carry dictionary evidence. `external_chat`
  collocations additionally require `evidence.rawPhrase`, preventing pasted
  external output from bypassing the dictionary grounding audit trail.

### 6. Phase 2E does not introduce the L3 schema

- Phase 2E touches only the L2 Composer surface. It does **not** add any L3
  table, column, or service. L3 remains out of scope (see ADR-0005).
- The L2 Composer's dictionary-grounded collocation flow is designed to
  eventually consume L3 authentic occurrences as a Tier 3 provider, but that
  integration is deferred to Phase 3.

## Consequences

- ✅ The blocking ungrounded-collocation gap is closed: invented phrases are
  dropped at draft time and never reach the DB.
- ✅ The five frozen contracts are pinned by contract tests
  (`tests/phase2e-contract.test.ts` + existing `l2-content`/`l2` suites) and
  documented in `docs/operations/l2-composer-api-contract.md` and
  `docs/operations/l2-dictionary-provider.md`.
- ✅ Future providers (Wiktionary, Oxford/Ozdic via official API, L3 corpus)
  integrate behind the existing `DictionaryProvider` interface — no service
  changes required.
- ⚠️ The ungrounded collocation prompt template
  (`buildCollocationPrompt`'s no-candidates branch) is now dead code from the
  service's perspective. It is kept as a library function (other callers may
  use it directly) but the draft flow never invokes it. Removing it is a
  separate cleanup, out of Phase 2E scope.
- ⚠️ `dependency-cruiser` does not yet enforce a `dictionary-no-outbound`
  rule; the dictionary layer is factually clean but not machine-verified.
  Adding the rule is deferred (unrelated to the contract freeze).
