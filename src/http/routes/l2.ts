/**
 * L2 enrichment HTTP routes — draft/confirm flow.
 *
 * Architecture constraint (dependency-cruiser enforced):
 * - http layer must NOT import @/db, @/repositories, or @/llm directly.
 * - All data access goes through the injected `services.words` / `services.l2content`.
 *
 * Routes:
 *   POST /:slug/draft            generate an L2 content draft via the LLM
 *   POST /:slug/external-prompt  assemble a prompt for an external chat tool
 *                                (no LLM call, no usage budget) — B5
 *   POST /:slug/confirm          persist a confirmed draft + cascade L2 cache/recheck
 *
 * The L2ContentService is always present (constructed even without an LLM
 * provider). `confirmDraft` is a pure DB cascade and needs no LLM, so the
 * confirm route never 503s for a missing provider. `generateDraft` degrades
 * to a structured `L2_CONTENT_UNAVAILABLE` error for fields that need the
 * LLM, which the draft route maps to 503.
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";
import { isValidL2Content, mapToStorageField } from "@/schemas/service";
import {
  assertJsonResourceBudget,
  JSON_MAX_DEPTH,
  L2_CONTENT_MAX_BYTES,
  L2_DRAFT_MAX_COUNT,
  L2_OPTION_STRING_MAX_LENGTH,
  L2_USER_INSTRUCTION_MAX_LENGTH,
} from "@/schemas/resource-budget";
import { jsonError } from "../error-response";

function parseDraftOptions(body: Record<string, unknown>, includeSource: boolean): Record<string, unknown> | null {
  const options: Record<string, unknown> = includeSource
    ? { source: body.source ?? "manual" }
    : {};

  if (body.source !== undefined && (typeof body.source !== "string" || body.source.length > L2_OPTION_STRING_MAX_LENGTH)) {
    return null;
  }
  if (body.styleProfileId !== undefined) {
    if (typeof body.styleProfileId !== "string" || body.styleProfileId.length === 0 || body.styleProfileId.length > L2_OPTION_STRING_MAX_LENGTH) {
      return null;
    }
    options.styleProfileId = body.styleProfileId;
  }
  if (body.count !== undefined) {
    if (!Number.isInteger(body.count) || (body.count as number) < 1 || (body.count as number) > L2_DRAFT_MAX_COUNT) {
      return null;
    }
    options.count = body.count;
  }
  if (body.userInstruction !== undefined) {
    if (typeof body.userInstruction !== "string" || body.userInstruction.length > L2_USER_INSTRUCTION_MAX_LENGTH) {
      return null;
    }
    options.userInstruction = body.userInstruction;
  }
  return options;
}

export function l2Routes(services: Services) {
  const app = new Hono<AppEnv>();

  // POST /:slug/draft — generate an LLM-backed draft for one field of a word.
  //
  // Body may carry `styleProfileId` (B4): applied to example/corpus prompts to
  // drive register/difficulty/domains. The route passes it through to the
  // service as part of the options object; the service validates the profile's
  // field scope (a mismatched profile throws ValidationError → 400 here).
  app.post("/:slug/draft", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json().catch(() => ({}));
    const storageField = mapToStorageField(body.field);
    if (storageField === null) {
      return jsonError(c, 400, "VALIDATION_ERROR", "Invalid field");
    }

    const draftOptions = parseDraftOptions(body, true);
    if (!draftOptions) {
      return jsonError(c, 400, "VALIDATION_ERROR", "Invalid draft options");
    }

    let result;
    try {
      const { word } = await services.words.getWordBySlug(slug);
      result = await services.l2content.generateDraft(
        {
          lemma: word.lemma,
          pos: word.pos,
          semanticField: word.semanticField ?? "",
          shortDefinition: word.shortDefinition,
          cefrTarget: word.cefr || "雅思",
        },
        storageField,
        draftOptions,
      );
    } catch (err) {
      // Style profile scope mismatch (B4) surfaces as a ValidationError from
      // the service → 400. Other thrown errors fall through to 500.
      if (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "ValidationError") {
        return jsonError(c, 400, "VALIDATION_ERROR", (err as Error).message);
      }
      throw err;
    }

    if (result.error === "OVER_BUDGET") {
      return jsonError(c, 503, "OVER_BUDGET", "LLM usage budget exceeded");
    }
    if (result.error === "L2_CONTENT_UNAVAILABLE") {
      return jsonError(c, 503, "L2_CONTENT_UNAVAILABLE", result.message ?? "LLM provider not configured");
    }
    if (result.error === "NO_DICTIONARY_CANDIDATES") {
      // B3: dictionary had no candidates — the LLM was never called. This is a
      // recoverable "no data" state rather than a server error, so 422 fits
      // better than 503 (the service is available, it just has no source).
      return jsonError(
        c,
        422,
        "NO_DICTIONARY_CANDIDATES",
        result.warning ?? "No dictionary candidates available",
        undefined,
        { warning: result.warning },
      );
    }
    if (result.error) {
      return jsonError(c, 500, result.error, result.error);
    }

    return c.json({
      draft: result.draft,
      ...(result.sourceMode ? { sourceMode: result.sourceMode } : {}),
    });
  });

  // POST /:slug/external-prompt (B5) — assemble a prompt for an external chat
  // tool WITHOUT calling the LLM or consuming usage budget. Works even when no
  // LLM provider is configured. The operator pastes the returned `prompt` into
  // an external tool, then confirms the result via /confirm.
  //
  // B3: `collocation` is dictionary-grounded here too — the service looks up
  // candidates before composing the prompt. No provider / throwing provider /
  // empty candidates → 422 NO_DICTIONARY_CANDIDATES (the LLM is never
  // consulted). With candidates the prompt carries them so an external tool is
  // constrained to the same dictionary candidates as the internal flow.
  app.post("/:slug/external-prompt", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json().catch(() => ({}));

    const requestField = typeof body.field === "string" ? body.field : "";
    const storageField = mapToStorageField(requestField);
    if (storageField === null) {
      return jsonError(c, 400, "VALIDATION_ERROR", "Invalid field");
    }

    const options = parseDraftOptions(body, false);
    if (!options) {
      return jsonError(c, 400, "VALIDATION_ERROR", "Invalid prompt options");
    }

    try {
      const { word } = await services.words.getWordBySlug(slug);
      const result = await services.l2content.buildExternalPrompt(
        {
          lemma: word.lemma,
          pos: word.pos,
          semanticField: word.semanticField ?? "",
          shortDefinition: word.shortDefinition,
          cefrTarget: word.cefr || "雅思",
        },
        storageField,
        options,
      );
      // B3/B5: collocation dictionary-grounding — no candidates means the LLM
      // was never consulted. This is a recoverable "no data" state (the service
      // is available, it just has no source), so 422 fits better than 503.
      if (result.error === "NO_DICTIONARY_CANDIDATES") {
        return jsonError(c, 422, "NO_DICTIONARY_CANDIDATES", result.warning ?? "No dictionary candidates available", undefined, { warning: result.warning });
      }
      // Echo the composer-facing field name (e.g. `example`) so the caller can
      // correlate the response with their request, alongside the canonical
      // storage field used internally.
      return c.json({
        field: requestField,
        storageField: result.storageField,
        styleProfileId: result.styleProfileId,
        promptVersion: result.promptVersion,
        promptHash: result.promptHash,
        prompt: result.prompt,
        expectedJsonSchema: result.expectedJsonSchema,
      });
    } catch (err) {
      // Style profile scope mismatch surfaces as a ValidationError → 400.
      if (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "ValidationError") {
        return jsonError(c, 400, "VALIDATION_ERROR", (err as Error).message);
      }
      throw err;
    }
  });

  // POST /:slug/confirm — persist an approved draft + cascade L2 cache/recheck.
  // confirmDraft is a pure DB cascade (insert → refreshL2Cache → markL2Stale)
  // and does NOT require an LLM provider, so this route never 503s for a
  // missing provider.
  //
  // Body compatibility (B6): three accepted shapes, normalized here so the
  // service always receives a canonical content value:
  //   1. legacy: { field, content, source } — `content` is a bare JSON array
  //   2. items:  { field, items, source, sourceRef? } — wrapped into a v1 doc
  //   3. document: { field, document, source, sourceRef? } — `document` is a
  //      v1 wrapper (`{ schemaVersion: "l2-content-v1", field, items }`)
  // `document` wins over `items` wins over `content`. `field=example` maps to
  // `corpus`. `sourceRef` reaches `word_l2_content.source_ref`.
  app.post("/:slug/confirm", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json().catch(() => ({}));

    const storageField = mapToStorageField(body.field);
    if (storageField === null) {
      return jsonError(c, 400, "VALIDATION_ERROR", "Invalid field");
    }

    // Normalize the content payload into a single canonical value.
    // document > items > content.
    let content: unknown;
    if (body.document !== undefined && body.document !== null) {
      content = body.document;
    } else if (body.items !== undefined && body.items !== null) {
      // Wrap the items array into a v1 document. The wrapper `field` uses the
      // composer-facing name; parseL2Content maps `example` → `corpus` and
      // verifies the wrapper field matches the requested storage field.
      content = {
        schemaVersion: "l2-content-v1",
        field: body.field,
        items: body.items,
      };
    } else {
      content = body.content;
    }

    // Field-specific content validation: each L2 field has a strict Zod schema
    // (see src/schemas/service). Reject malformed structures with 400 before
    // they reach the service layer / DB. Validated against the canonical
    // storage field name (e.g. `corpus` even when the request sent `example`).
    if (!isValidL2Content(storageField, content)) {
      return jsonError(c, 400, "VALIDATION_ERROR", `Invalid content for field "${storageField}"`);
    }

    const confirmOptions: Record<string, unknown> = {
      source: typeof body.source === "string" ? body.source : "manual", actorId: c.get("userId"),
    };
    if (typeof body.sourceRef === "string") {
      confirmOptions.sourceRef = body.sourceRef;
    } else if (body.sourceRef === null) {
      confirmOptions.sourceRef = null;
    }

    const { word } = await services.words.getWordBySlug(slug);
    await services.l2content.confirmDraft(
      word.id,
      storageField,
      content,
      confirmOptions,
    );
    return c.json({ ok: true });
  });

  return app;
}
