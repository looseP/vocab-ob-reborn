import type {
  L3ContextLinkTargetType,
  L3ContextLinkType,
  L3ContextType,
  L3SourceType,
} from "@/domain";
import {
  normalizeL3Error,
  type L3ManualContextCreateInput,
  type L3ManualContextLinkCreateInput,
  type L3ManualOccurrenceCreateInput,
  type L3ManualSourceCreateInput,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";
import { navigationAction, type L3NavigationAction } from "./l3NavigationViewModel";

export const manualSourceTypes: L3SourceType[] = ["manual", "article", "book", "video", "audio", "chat", "web", "other"];
export const manualContextTypes: L3ContextType[] = ["sentence", "paragraph", "excerpt", "dialogue", "note"];
export const manualLinkTypes: L3ContextLinkType[] = [
  "manual_link",
  "supports",
  "illustrates",
  "contrasts",
  "collocates_with",
  "synonym_of",
  "antonym_of",
  "derived_from",
  "topic_related",
];
export const manualTargetTypes: L3ContextLinkTargetType[] = ["word", "context", "source", "l2_item", "topic", "external"];

export type ManualCreateStatus = "editing" | "submitting" | "created" | "failed";

export interface SurfaceMatchCandidate {
  startOffset: number;
  endOffset: number;
  preview: string;
}

export interface SurfaceMatchResult {
  status: "zero" | "one" | "multiple";
  candidates: SurfaceMatchCandidate[];
}

export interface ManualSourceFormState {
  sourceType: L3SourceType;
  title: string;
  wordbookId: string;
  author: string;
  url: string;
  language: string;
  metadataJson: string;
}

export interface ManualContextFormState {
  sourceId: string;
  contextType: L3ContextType;
  text: string;
  normalizedText: string;
  language: string;
  positionJson: string;
  metadataJson: string;
}

export interface ManualOccurrenceFormState {
  contextId: string;
  wordId: string;
  slug: string;
  surface: string;
  contextText: string;
  lemma: string;
  startOffset: string;
  endOffset: string;
  confidence: string;
  evidenceJson: string;
}

export interface ManualContextLinkFormState {
  contextId: string;
  wordId: string;
  linkType: L3ContextLinkType;
  targetType: L3ContextLinkTargetType;
  targetId: string;
  targetRefJson: string;
  confidence: string;
  provenanceJson: string;
}

export function initialManualSourceFormState(): ManualSourceFormState {
  return {
    sourceType: "manual",
    title: "",
    wordbookId: "",
    author: "",
    url: "",
    language: "en",
    metadataJson: "{}",
  };
}

export function initialManualContextFormState(sourceId = ""): ManualContextFormState {
  return {
    sourceId,
    contextType: "sentence",
    text: "",
    normalizedText: "",
    language: "en",
    positionJson: "{}",
    metadataJson: "{}",
  };
}

export function initialManualOccurrenceFormState(contextId = ""): ManualOccurrenceFormState {
  return {
    contextId,
    wordId: "",
    slug: "",
    surface: "",
    contextText: "",
    lemma: "",
    startOffset: "",
    endOffset: "",
    confidence: "",
    evidenceJson: "{}",
  };
}

export function initialManualContextLinkFormState(contextId = ""): ManualContextLinkFormState {
  return {
    contextId,
    wordId: "",
    linkType: "manual_link",
    targetType: "context",
    targetId: "",
    targetRefJson: "{}",
    confidence: "",
    provenanceJson: "{\"source\":\"manual\"}",
  };
}

function manualFormError(fieldErrors: Record<string, string[]>): NormalizedL3Error {
  return normalizeL3Error(400, {
    code: "FRONTEND_VALIDATION_ERROR",
    message: "Request validation failed.",
    details: { fieldErrors },
  });
}

function requireTrimmed(value: string, field: string, fieldErrors: Record<string, string[]>): string {
  const trimmed = value.trim();
  if (!trimmed) fieldErrors[field] = [`${field} cannot be empty.`];
  return trimmed;
}

function optionalTrimmed(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  return field !== null && typeof field === "object" && !Array.isArray(field) ? field as Record<string, unknown> : {};
}

function firstTrimmedString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function manualMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    ...metadata,
    provenance: {
      ...objectField(metadata, "provenance"),
      source: "manual",
    },
  };
}

function manualEvidence(evidence: Record<string, unknown>, slug: string | null): Record<string, unknown> {
  return {
    ...evidence,
    ...(slug ? { slug } : {}),
    method: "manual",
    source: "manual",
  };
}

function manualProvenance(provenance: Record<string, unknown>): Record<string, unknown> {
  return {
    ...provenance,
    source: "manual",
  };
}

function parseOptionalNumber(value: string, field: string, fieldErrors: Record<string, string[]>): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    fieldErrors[field] = [`${field} must be a number.`];
    return null;
  }
  return parsed;
}

function parseOptionalInteger(value: string, field: string, fieldErrors: Record<string, string[]>): number | null {
  const parsed = parseOptionalNumber(value, field, fieldErrors);
  if (parsed === null) return null;
  if (!Number.isInteger(parsed) || parsed < 0) {
    fieldErrors[field] = [`${field} must be a non-negative integer.`];
    return null;
  }
  return parsed;
}

export function parseJsonObjectField(value: string, field: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw manualFormError({ [field]: [`${field} must be valid JSON object.`] });
  }
}

export function findExactSurfaceMatches(contextText: string, surface: string): SurfaceMatchResult {
  if (!contextText || !surface) return { status: "zero", candidates: [] };
  const candidates: SurfaceMatchCandidate[] = [];
  let cursor = 0;
  while (cursor <= contextText.length) {
    const start = contextText.indexOf(surface, cursor);
    if (start === -1) break;
    const end = start + surface.length;
    candidates.push({
      startOffset: start,
      endOffset: end,
      preview: contextText.slice(Math.max(0, start - 24), Math.min(contextText.length, end + 24)),
    });
    cursor = start + 1;
  }
  if (candidates.length === 1) return { status: "one", candidates };
  if (candidates.length > 1) return { status: "multiple", candidates };
  return { status: "zero", candidates };
}

export function buildManualSourceCreateInput(form: ManualSourceFormState): L3ManualSourceCreateInput {
  const fieldErrors: Record<string, string[]> = {};
  const title = requireTrimmed(form.title, "title", fieldErrors);
  const metadata = parseJsonObjectField(form.metadataJson, "metadata");
  if (Object.keys(fieldErrors).length > 0) throw manualFormError(fieldErrors);
  return {
    sourceType: form.sourceType,
    title,
    ...(optionalTrimmed(form.wordbookId) ? { wordbookId: optionalTrimmed(form.wordbookId) } : {}),
    ...(optionalTrimmed(form.author) ? { author: optionalTrimmed(form.author) } : {}),
    ...(optionalTrimmed(form.url) ? { url: optionalTrimmed(form.url) } : {}),
    ...(optionalTrimmed(form.language) ? { language: optionalTrimmed(form.language) } : {}),
    metadata: manualMetadata(metadata),
  };
}

export function buildManualContextCreateInput(form: ManualContextFormState): L3ManualContextCreateInput {
  const fieldErrors: Record<string, string[]> = {};
  const sourceId = requireTrimmed(form.sourceId, "sourceId", fieldErrors);
  const text = requireTrimmed(form.text, "text", fieldErrors);
  const position = parseJsonObjectField(form.positionJson, "position");
  const metadata = parseJsonObjectField(form.metadataJson, "metadata");
  if (Object.keys(fieldErrors).length > 0) throw manualFormError(fieldErrors);
  return {
    sourceId,
    contextType: form.contextType,
    text,
    ...(optionalTrimmed(form.normalizedText) ? { normalizedText: optionalTrimmed(form.normalizedText) } : {}),
    ...(optionalTrimmed(form.language) ? { language: optionalTrimmed(form.language) } : {}),
    position,
    metadata: manualMetadata(metadata),
  };
}

export function buildManualOccurrenceCreateInput(form: ManualOccurrenceFormState): L3ManualOccurrenceCreateInput {
  const fieldErrors: Record<string, string[]> = {};
  const contextId = requireTrimmed(form.contextId, "contextId", fieldErrors);
  const surface = requireTrimmed(form.surface, "surface", fieldErrors);
  const wordId = optionalTrimmed(form.wordId);
  const slug = optionalTrimmed(form.slug);
  const startOffset = parseOptionalInteger(form.startOffset, "startOffset", fieldErrors);
  const endOffset = parseOptionalInteger(form.endOffset, "endOffset", fieldErrors);
  const confidence = parseOptionalNumber(form.confidence, "confidence", fieldErrors);
  const evidence = parseJsonObjectField(form.evidenceJson, "evidence");
  if (!wordId && !slug) fieldErrors.wordId = ["wordId or slug is required."];
  if ((startOffset === null) !== (endOffset === null)) {
    fieldErrors.startOffset = ["startOffset and endOffset must be supplied together."];
  }
  if (confidence !== null && (confidence < 0 || confidence > 1)) {
    fieldErrors.confidence = ["confidence must be between 0 and 1."];
  }
  if (Object.keys(fieldErrors).length > 0) throw manualFormError(fieldErrors);
  return {
    contextId,
    ...(wordId ? { wordId } : {}),
    ...(slug ? { slug } : {}),
    surface,
    ...(optionalTrimmed(form.lemma) ? { lemma: optionalTrimmed(form.lemma) } : {}),
    ...(startOffset === null ? {} : { startOffset }),
    ...(endOffset === null ? {} : { endOffset }),
    ...(confidence === null ? {} : { confidence }),
    evidence: manualEvidence(evidence, slug),
  };
}

export function validateL2ItemTargetRef(targetRef: Record<string, unknown>): boolean {
  const hasField = typeof targetRef.field === "string" && targetRef.field.trim().length > 0;
  const hasStableRef = ["contentId", "hash", "sourceRef"].some((key) => typeof targetRef[key] === "string" && String(targetRef[key]).trim().length > 0);
  return hasField && hasStableRef;
}

export function buildManualContextLinkCreateInput(form: ManualContextLinkFormState): L3ManualContextLinkCreateInput {
  const fieldErrors: Record<string, string[]> = {};
  const contextId = optionalTrimmed(form.contextId);
  const wordId = optionalTrimmed(form.wordId);
  const targetId = optionalTrimmed(form.targetId);
  const targetRef = parseJsonObjectField(form.targetRefJson, "targetRef");
  const provenance = parseJsonObjectField(form.provenanceJson, "provenance");
  const confidence = parseOptionalNumber(form.confidence, "confidence", fieldErrors);
  if (!contextId && !wordId) fieldErrors.contextId = ["contextId or wordId is required."];
  if (["word", "context", "source"].includes(form.targetType) && !targetId) {
    fieldErrors.targetId = [`targetId is required for ${form.targetType} targets.`];
  }
  if (form.targetType === "l2_item" && !validateL2ItemTargetRef(targetRef)) {
    fieldErrors.targetRef = ["l2_item targetRef requires field plus contentId, hash, or sourceRef."];
  }
  if (confidence !== null && (confidence < 0 || confidence > 1)) {
    fieldErrors.confidence = ["confidence must be between 0 and 1."];
  }
  if (Object.keys(fieldErrors).length > 0) throw manualFormError(fieldErrors);
  return {
    ...(contextId ? { contextId } : {}),
    ...(wordId ? { wordId } : {}),
    linkType: form.linkType,
    targetType: form.targetType,
    ...(targetId ? { targetId } : {}),
    targetRef,
    ...(confidence === null ? {} : { confidence }),
    provenance: manualProvenance(provenance),
  };
}

export function manualCreateSuccessActions(input: {
  sourceId?: string | null;
  contextId?: string | null;
  slug?: string | null;
  wordbookId?: string | null;
  linkTarget?: {
    targetType?: L3ContextLinkTargetType | null;
    targetId?: string | null;
    targetRef?: Record<string, unknown> | null;
  } | null;
}): L3NavigationAction[] {
  const targetRef = input.linkTarget?.targetRef ?? {};
  const targetAction = (() => {
    if (!input.linkTarget?.targetType) return null;
    if (input.linkTarget.targetType === "context") {
      return input.linkTarget.targetId
        ? navigationAction("Open Target Context", { target: "context", contextId: input.linkTarget.targetId })
        : navigationAction("Open Target Context", null, "No target context id available.");
    }
    if (input.linkTarget.targetType === "source") {
      return input.linkTarget.targetId
        ? navigationAction("Open Target Source", { target: "source", sourceId: input.linkTarget.targetId })
        : navigationAction("Open Target Source", null, "No target source id available.");
    }
    if (input.linkTarget.targetType === "word") {
      const slug = firstTrimmedString(targetRef.slug, targetRef.wordSlug, targetRef.targetSlug);
      const wordbookId = firstTrimmedString(targetRef.wordbookId, targetRef.wordbook_id);
      return slug
        ? navigationAction("Open Target Word Space", { target: "word", slug, ...(wordbookId ? { wordbookId } : {}) })
        : navigationAction("Open Target Word Space", null, "No explicit target slug available.");
    }
    return navigationAction("Open Link Target", null, `${input.linkTarget.targetType} targets are metadata-only in this phase.`);
  })();

  return [
    input.sourceId
      ? navigationAction("Open Source Space", { target: "source", sourceId: input.sourceId })
      : navigationAction("Open Source Space", null, "No source id available."),
    input.contextId
      ? navigationAction("Open Context", { target: "context", contextId: input.contextId })
      : navigationAction("Open Context", null, "No context id available."),
    ...(targetAction ? [targetAction] : []),
    input.slug
      ? navigationAction("Open Word Space", { target: "word", slug: input.slug, ...(input.wordbookId ? { wordbookId: input.wordbookId } : {}) })
      : navigationAction("Open Word Space", null, "No explicit slug available."),
    input.sourceId
      ? navigationAction("Open Graph", { target: "graph", query: { sourceId: input.sourceId } })
      : navigationAction("Open Graph", { target: "graph", query: {} }),
  ];
}

export function canSubmitManualCreate(status: ManualCreateStatus): boolean {
  return status === "editing" || status === "failed";
}
