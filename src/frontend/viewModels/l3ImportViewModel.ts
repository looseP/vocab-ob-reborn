import {
  normalizeL3Error,
  parseTargetWordInput,
  type L3RawTextImportInput,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function previewText(value: unknown, maxLength: number): string {
  if (typeof value === "string") return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}...` : serialized;
  } catch {
    return "Unserializable payload";
  }
}

function importItemPayloadSummary(itemType: string, payload: unknown): string {
  if (!isRecord(payload)) return previewText(payload, 180);
  if (itemType === "source") return previewText(payload.title ?? payload.sourceType ?? payload, 180);
  if (itemType === "context") return previewText(payload.text ?? payload.contextType ?? payload, 180);
  if (itemType === "occurrence") return previewText(payload.surface ?? payload.slug ?? payload.wordId ?? payload, 180);
  if (itemType === "context_link") return `${previewText(payload.linkType ?? "link", 80)} -> ${previewText(payload.targetType ?? "target", 80)}`;
  return previewText(payload, 180);
}

export function summarizeImportProposalItem(item: unknown, index: number): string {
  if (!isRecord(item)) return `#${index + 1} item: ${previewText(item, 180)}`;
  const itemType = String(item.item_type ?? item.itemType ?? "item");
  const ordinal = typeof item.ordinal === "number" ? item.ordinal : index + 1;
  return `#${ordinal} ${itemType}: ${importItemPayloadSummary(itemType, item.payload ?? item)}`;
}

function importFormError(fieldErrors: Record<string, string[]>): NormalizedL3Error {
  return normalizeL3Error(400, {
    code: "FRONTEND_VALIDATION_ERROR",
    message: "Request validation failed.",
    details: { fieldErrors },
  });
}

export function buildRawTextImportPayload(input: {
  sourceTitle: string;
  sourceType: L3RawTextImportInput["source"]["sourceType"];
  sourceLanguage: string;
  wordbookId: string;
  text: string;
  targetWords: string;
  contextType: "sentence" | "paragraph";
}): L3RawTextImportInput {
  const title = input.sourceTitle.trim();
  const fieldErrors: Record<string, string[]> = {};
  if (!title) fieldErrors["source.title"] = ["source.title cannot be empty."];
  if (!input.text.trim()) fieldErrors.text = ["text cannot be empty."];
  if (Object.keys(fieldErrors).length > 0) throw importFormError(fieldErrors);

  return {
    ...(input.wordbookId.trim() ? { wordbookId: input.wordbookId.trim() } : {}),
    source: {
      sourceType: input.sourceType,
      title,
      language: input.sourceLanguage.trim() || null,
    },
    text: input.text,
    targetWords: parseTargetWordInput(input.targetWords),
    options: { contextType: input.contextType },
    provenance: { frontendSurface: "phase_4c_raw_import" },
  };
}
