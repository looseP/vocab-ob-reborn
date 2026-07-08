import type { NormalizedL3Error } from "@/l3/frontend/contract";

export function formatL3ErrorDetails(error: NormalizedL3Error): string | null {
  if (error.fieldErrors || error.itemErrors || error.details === undefined || error.details === null) return null;
  if (typeof error.details === "string") return error.details;
  try {
    return JSON.stringify(error.details);
  } catch {
    return "Additional details could not be displayed.";
  }
}
