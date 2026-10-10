/**
 * 每日捕获客户端（M2）—— 子空间与捕获窗共用的类型化 API 面。
 *
 * 与后端契约一一对应（src/http/daily-capture-response-contract.ts）；
 * `copyFileText` 取 text/markdown 原文（parseJson:false，同 fetchSheetExport 先例）。
 */
import { apiFetch } from "./client";

export type DailyCaptureEntryStatus = "raw" | "reviewed" | "absorbed" | "archived";

export type DailyCaptureAbsorbAction =
  | "bind_l3"
  | "add_word"
  | "enqueue_review"
  | "file_method"
  | "rewrite"
  | "none";

export interface DailyCaptureEntryMeta {
  meaning?: string;
  translation?: string;
  sourceUrl?: string;
  obsidianRef?: string;
  wordSlugs?: string[];
  important?: boolean;
}

export interface DailyCaptureAbsorptionReceipt {
  action: DailyCaptureAbsorbAction;
  target: string | null;
  id: string | null;
  at: string;
  word_slug: string | null;
  deduped?: boolean;
}

export interface DailyCaptureType {
  user_id: string;
  type_key: string;
  label: string;
  absorption_hint: string | null;
  sort: number;
  hidden: boolean;
  created_at: string;
}

export interface DailyCaptureEntry {
  id: string;
  user_id: string;
  entry_date: string;
  seq: number;
  entry_type: string;
  content: string;
  meta: DailyCaptureEntryMeta | null;
  status: DailyCaptureEntryStatus;
  absorption: DailyCaptureAbsorptionReceipt[] | null;
  created_at: string;
  hidden_at: string | null;
}

export interface DailyCaptureDay {
  date: string;
  types: DailyCaptureType[];
  entries: DailyCaptureEntry[];
}

export interface DailyCaptureDaySummary {
  date: string;
  total: number;
  raw: number;
  reviewed: number;
  absorbed: number;
}

export async function listDays(limit = 30): Promise<DailyCaptureDaySummary[]> {
  const body = await apiFetch<{ days: DailyCaptureDaySummary[] }>(`/daily-capture/days?limit=${limit}`);
  return body.days;
}

export async function getDay(date: string): Promise<DailyCaptureDay> {
  return apiFetch<DailyCaptureDay>(`/daily-capture/days/${encodeURIComponent(date)}`);
}

export async function listTypes(): Promise<DailyCaptureType[]> {
  const body = await apiFetch<{ types: DailyCaptureType[] }>("/daily-capture/types");
  return body.types;
}

export async function createType(input: {
  typeKey: string;
  label: string;
  absorptionHint?: string;
  sort?: number;
}): Promise<DailyCaptureType> {
  return apiFetch<DailyCaptureType>("/daily-capture/types", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function patchType(
  typeKey: string,
  input: { label?: string; absorptionHint?: string; sort?: number; hidden?: boolean },
): Promise<DailyCaptureType> {
  return apiFetch<DailyCaptureType>(`/daily-capture/types/${encodeURIComponent(typeKey)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function patchEntry(
  id: string,
  input: { status?: DailyCaptureEntryStatus; important?: boolean },
): Promise<DailyCaptureEntry> {
  return apiFetch<DailyCaptureEntry>(`/daily-capture/entries/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/** 当日文件投影原文（text/markdown；捕获窗与子空间「复制当日文件」共用）。 */
export async function copyFileText(date: string): Promise<string> {
  return apiFetch<string>(`/daily-capture/days/${encodeURIComponent(date)}/file`, { parseJson: false });
}

// ── M3 吸收侧：证据包导出（agent 唯一读面）+ 提案采纳 ────────────────────────

export interface DailyCaptureEvidenceWord {
  slug: string;
  title: string;
  lemma: string;
  ipa: string | null;
  short_definition: string | null;
  existing_context_count: number;
}

export interface DailyCaptureEvidenceEntry {
  seq: number;
  id: string;
  entry_type: string;
  label: string | null;
  absorption_hint: string | null;
  content: string;
  status: DailyCaptureEntryStatus;
  meta: DailyCaptureEntryMeta | null;
  created_at: string;
  words: DailyCaptureEvidenceWord[];
}

export interface DailyCaptureEvidencePack {
  version: 1;
  date: string;
  markdown: string;
  entries: DailyCaptureEvidenceEntry[];
}

export async function getEvidencePack(date: string): Promise<DailyCaptureEvidencePack> {
  return apiFetch<DailyCaptureEvidencePack>(`/daily-capture/days/${encodeURIComponent(date)}/export`);
}

/** 采纳一条提案：动作执行（bind_l3/add_word/enqueue_review/留档/归档）+ 回执落库。 */
export async function absorbEntry(
  id: string,
  input: {
    action: DailyCaptureAbsorbAction;
    wordSlug?: string;
    payload?: { contextText?: string; translation?: string; sourceUrl?: string };
    reason?: string;
    wordbookId?: string;
  },
): Promise<{ entry: DailyCaptureEntry; receipt: DailyCaptureAbsorptionReceipt }> {
  return apiFetch<{ entry: DailyCaptureEntry; receipt: DailyCaptureAbsorptionReceipt }>(
    `/daily-capture/entries/${encodeURIComponent(id)}/absorb`,
    { method: "POST", body: JSON.stringify(input) },
  );
}
