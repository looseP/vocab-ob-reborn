export const API_JSON_BODY_MAX_BYTES = 1024 * 1024;
export const JSON_RECORD_MAX_BYTES = 64 * 1024;
export const JSON_MAX_DEPTH = 10;
export const L2_CONTENT_MAX_BYTES = 512 * 1024;
export const L2_DRAFT_MAX_COUNT = 20;
export const L2_USER_INSTRUCTION_MAX_LENGTH = 4_000;
export const L2_OPTION_STRING_MAX_LENGTH = 500;
export const L3_PROPOSAL_MAX_ITEMS = 1_000;
export const L3_PROPOSAL_PAYLOAD_MAX_BYTES = 256 * 1024;
export const L3_PROPOSAL_TOTAL_PAYLOAD_MAX_BYTES = 1024 * 1024;

// Vocab-note import (P3): bounded so a single request stays well under the
// global 1 MiB API body limit; the frontend chunks large uploads itself.
export const VOCAB_IMPORT_MAX_FILES = 50;
export const VOCAB_IMPORT_PATH_MAX_LENGTH = 1_024;
export const VOCAB_IMPORT_CONTENT_MAX_BYTES = 200_000;

export interface JsonResourceBudget {
  maxBytes: number;
  maxDepth: number;
}

function assertJsonDepth(
  value: unknown,
  maxDepth: number,
  depth: number,
  ancestors: Set<object>,
): void {
  if (value === null || typeof value !== "object") return;
  if (depth > maxDepth) {
    throw new Error(`JSON value exceeds maximum depth of ${maxDepth}`);
  }
  if (ancestors.has(value)) {
    throw new Error("JSON value must not contain circular references");
  }

  ancestors.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    assertJsonDepth(child, maxDepth, depth + 1, ancestors);
  }
  ancestors.delete(value);
}

export function assertJsonResourceBudget(
  value: unknown,
  budget: JsonResourceBudget,
): number {
  assertJsonDepth(value, budget.maxDepth, 1, new Set<object>());

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Value must be JSON serializable");
  }
  if (serialized === undefined) {
    throw new Error("Value must be JSON serializable");
  }

  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > budget.maxBytes) {
    throw new Error(`JSON value exceeds maximum serialized size of ${budget.maxBytes} bytes`);
  }
  return bytes;
}
