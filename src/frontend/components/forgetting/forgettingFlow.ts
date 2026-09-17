/**
 * 一键遗忘确认流（ADR-0020 / T12）· 前端数据层。
 *
 * 契约边界（不改 service / 契约，缺口只报告）：
 * - preview 响应只含 `anchors: string[]`（wordId）与 L1 `suspendCount`；
 *   锚点词面需借既有 /words 读端点按书分页解析（解析不到时回退为编号缩写）。
 * - 逐锚点「命中规则」与 L2 影响条数在冻结契约中不可得：前者不展示（缺口报告），
 *   后者在执行（apply）后由响应给出。
 *
 * 本模块不持有组件状态；默认词书缓存的生命周期由调用组件持有。
 */
import { apiFetch } from "@/frontend/api/client";

/** GET /api/wordbooks/default 响应子集（wordbookDefaultResponseSchema）。 */
export interface DefaultWordbook {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
}

/** GET /api/forgetting/preview 响应（forgettingPreviewResponseSchema）。 */
export interface ForgettingPreview {
  anchors: string[];
  suspendCount: number;
}

/** POST /api/forgetting/apply 响应（forgettingApplyResponseSchema）。 */
export interface ForgettingApplyResult {
  batchId: string;
  suspendedCount: number;
  pausedCount: number;
  anchors: string[];
}

/** POST /api/forgetting/restore 响应（forgettingRestoreResponseSchema）。 */
export interface ForgettingRestoreResult {
  restoredCount: number;
  unpausedCount: number;
}

/** GET /api/words 分页响应子集（wordListResponseSchema）。 */
interface WordLookupPage {
  items: Array<{ id: string; lemma: string; title: string }>;
  hasMore: boolean;
}

/** 锚点词面解析的页大小（wordsQuerySchema limit 上限 100）。 */
export const ANCHOR_LOOKUP_PAGE_SIZE = 100;
/** 锚点词面解析的分页上限（超限的锚点回退为编号缩写，不阻塞主流程）。 */
export const ANCHOR_LOOKUP_MAX_PAGES = 5;

export function fetchDefaultWordbook(): Promise<DefaultWordbook> {
  return apiFetch<DefaultWordbook>("/wordbooks/default");
}

export function fetchForgettingPreview(bookId: string): Promise<ForgettingPreview> {
  return apiFetch<ForgettingPreview>(`/forgetting/preview?bookId=${encodeURIComponent(bookId)}`);
}

export function applyForgetting(bookId: string, confirmedAnchorIds: string[]): Promise<ForgettingApplyResult> {
  return apiFetch<ForgettingApplyResult>("/forgetting/apply", {
    method: "POST",
    body: JSON.stringify({ bookId, confirmedAnchorIds }),
  });
}

export function restoreForgetting(bookId: string, batchId: string): Promise<ForgettingRestoreResult> {
  return apiFetch<ForgettingRestoreResult>("/forgetting/restore", {
    method: "POST",
    body: JSON.stringify({ bookId, batchId }),
  });
}

/**
 * 取消勾选锚点后的 L1 影响数：preview.suspendCount 按「保留全部锚点」计算，
 * 每个被取消的锚点 wordId 必然对应一条可挂起行（锚点候选本就排除
 * suspended/new），故计数 = 基准 + 取消勾选数。上限为全书可挂起行数 + 锚点数。
 */
export function deriveL1ImpactCount(preview: ForgettingPreview, selectedCount: number): number {
  const deselected = Math.max(0, preview.anchors.length - selectedCount);
  return preview.suspendCount + deselected;
}

/** 词面解析失败时的回退标签：词条编号缩写（uuid 前 8 位）。 */
export function shortenWordId(wordId: string): string {
  return `#${wordId.slice(0, 8)}`;
}

/**
 * 按书解析锚点词面：`/words?wordbookId=&review=tracked=` 顺序翻页，
 * 全部解析完成或到达分页上限即停。任何请求失败都返回已解析部分——
 * 词面只是展示层增强，绝不阻塞确认流。
 */
export async function resolveAnchorLabels(bookId: string, anchorIds: string[]): Promise<Record<string, string>> {
  const remaining = new Set(anchorIds);
  const labels: Record<string, string> = {};
  for (let page = 0; page < ANCHOR_LOOKUP_MAX_PAGES && remaining.size > 0; page++) {
    const offset = page * ANCHOR_LOOKUP_PAGE_SIZE;
    let result: WordLookupPage;
    try {
      result = await apiFetch<WordLookupPage>(
        `/words?wordbookId=${encodeURIComponent(bookId)}&review=tracked&limit=${ANCHOR_LOOKUP_PAGE_SIZE}&offset=${offset}`,
      );
    } catch {
      break;
    }
    for (const item of result.items) {
      if (!remaining.delete(item.id)) continue;
      const label = item.lemma.trim() || item.title.trim();
      if (label) labels[item.id] = label;
    }
    if (!result.hasMore || result.items.length === 0) break;
  }
  return labels;
}
