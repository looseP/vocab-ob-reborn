import type { L3ProposalItemRow } from "@/domain";

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

export function summarizeProposalItem(item: L3ProposalItemRow): string {
  if (!item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) return JSON.stringify(item.payload);
  const payload = item.payload as Record<string, unknown>;
  if (item.item_type === "source") return previewText(payload.title ?? payload.sourceType ?? "source", 240);
  if (item.item_type === "context") return previewText(payload.text ?? payload.contextType ?? "context", 240);
  if (item.item_type === "occurrence") {
    const word = previewText(payload.slug ?? payload.wordId ?? "word", 80);
    const surface = previewText(payload.surface ?? "surface", 120);
    const offsets = payload.startOffset !== undefined || payload.endOffset !== undefined
      ? ` [${previewText(payload.startOffset, 20)}-${previewText(payload.endOffset, 20)}]`
      : "";
    return `${word}: ${surface}${offsets}`;
  }
  if (item.item_type === "context_link") return `${previewText(payload.linkType ?? "link", 80)} -> ${previewText(payload.targetType ?? "target", 80)}`;
  return previewText(payload, 240);
}

export function sortProposalItems(items: L3ProposalItemRow[]): L3ProposalItemRow[] {
  return [...items].sort((left, right) => left.ordinal - right.ordinal);
}

export function hasValidationErrors(item: L3ProposalItemRow): boolean {
  if (!item.validation_errors) return false;
  if (Array.isArray(item.validation_errors)) return item.validation_errors.length > 0;
  return typeof item.validation_errors === "object" && Object.keys(item.validation_errors).length > 0;
}
