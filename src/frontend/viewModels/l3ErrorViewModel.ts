import type { NormalizedL3Error } from "@/l3/frontend/contract";

export interface L3ErrorUxContract {
  title: string;
  retryHint: NormalizedL3Error["retryHint"];
  preservesInput: true;
  isEmptyState: false;
}

export function formatL3ErrorDetails(error: NormalizedL3Error): string | null {
  // not_found 的 details 只是资源描述符（resourceType/identifier），message 已含 id，
  // 再渲染原始 JSON 对用户无意义（P3-9 深链无效 id 场景暴露）。
  if (error.kind === "not_found") return null;
  if (error.fieldErrors || error.itemErrors || error.details === undefined || error.details === null) return null;
  if (typeof error.details === "string") return error.details;
  try {
    return JSON.stringify(error.details);
  } catch {
    return "Additional details could not be displayed.";
  }
}

export function l3ErrorUxContract(error: NormalizedL3Error): L3ErrorUxContract {
  const titleByKind: Record<NormalizedL3Error["kind"], string> = {
    bad_request: "Request needs local input changes.",
    not_found: "Requested L3 record was not found.",
    conflict: "L3 state changed; refresh before retrying.",
    validation: "L3 business validation failed.",
    unexpected: "Unexpected L3 service error.",
    network: "Network request failed.",
    aborted: "Request was cancelled.",
  };

  return {
    title: titleByKind[error.kind],
    retryHint: error.retryHint,
    preservesInput: true,
    isEmptyState: false,
  };
}
