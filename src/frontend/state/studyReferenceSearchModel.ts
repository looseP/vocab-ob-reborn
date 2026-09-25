/**
 * Task 09A · 引用目标搜索模型（纯 TS、可注入计时器；不读 React/DOM）。
 *
 * 已冻结协议（frontend-tasks §4.3）：
 *  - R1 切 kind → 清 cursor 立即请求；
 *  - R2 q 变化 → 立即失效旧代际 + 清 cursor，防抖后请求；
 *  - R3 venue 变化（question kind）→ 清 cursor 立即请求；source kind 下仅记录筛选（随后切 question 时携带）；
 *  - R4 仅 limit 变化 → cursor 可保留（从当前 cursor 重取）；
 *  - R5 旧 cursor 400 → 可见提示（不静默），refresh 重发无 cursor；
 *  - 分页去重、序号守卫（旧响应丢弃）、取尽 no-op；构造即发起首页（kind=source）。
 */
import type { L3QuestionType } from "@/domain/l3-question-types";
import type { StudyPage } from "@/domain/l3-study-notes";
import type { ReferenceTargetSearchQuery, StudyTargetItem } from "@/frontend/api/studyNotesClient";

export type ReferenceSearchKind = "source" | "question";
export type ReferenceSearchState = "idle" | "loading" | "ready" | "error";

export interface ReferenceSearchSnapshot {
  filters: { kind: ReferenceSearchKind; q: string | null; venue: L3QuestionType | null; limit: number | undefined };
  candidates: StudyTargetItem[];
  total: number;
  nextCursor: string | null;
  state: ReferenceSearchState;
  loadingMore: boolean;
  error: string | null;
}

export interface ReferenceSearchModelOptions {
  search(query: ReferenceTargetSearchQuery): Promise<StudyPage<StudyTargetItem>>;
  debounceMs?: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface ReferenceSearchModel {
  setKind(kind: ReferenceSearchKind): void;
  setQuery(q: string): void;
  setVenue(venue: L3QuestionType | null): void;
  /** R4：仅 limit 变化，cursor 保留。 */
  setLimit(limit: number | undefined): void;
  loadMore(): Promise<void>;
  refresh(): void;
  getSnapshot(): ReferenceSearchSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
  isDisposed(): boolean;
}

function describeSearchError(error: unknown): string {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (status === 400) return "筛选条件已变化（游标失效）：请刷新后重试。";
    if (status === 401) return "登录状态已失效，请重新登录后重试。";
    if (typeof status === "number" && status >= 500) return "服务暂时不可用，请稍后重试。";
  }
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.trim()) return message;
  return "搜索失败，请重试。";
}

const DEFAULT_DEBOUNCE_MS = 300;

export function createStudyReferenceSearchModel(options: ReferenceSearchModelOptions): ReferenceSearchModel {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let kind: ReferenceSearchKind = "source";
  let q: string | null = null;
  let venue: L3QuestionType | null = null;
  let limit: number | undefined;

  let candidates: StudyTargetItem[] = [];
  let total = 0;
  let nextCursor: string | null = null;
  let state: ReferenceSearchState = "idle";
  let loadingMore = false;
  let error: string | null = null;

  let requestSeq = 0;
  let debounceHandle: unknown = null;
  let disposed = false;
  const subscribers = new Set<() => void>();

  function notify(): void {
    for (const listener of [...subscribers]) listener();
  }

  function cancelDebounce(): void {
    if (debounceHandle !== null) {
      options.clearTimer(debounceHandle);
      debounceHandle = null;
    }
  }

  function buildQuery(cursor: string | null): ReferenceTargetSearchQuery {
    const query: ReferenceTargetSearchQuery = { kind };
    if (q) query.q = q;
    if (kind === "question" && venue) query.venue = venue;
    if (limit !== undefined) query.limit = limit;
    if (cursor) query.cursor = cursor;
    return query;
  }

  /** 重取（首页或保留 cursor 的续取起点）。 */
  function restart(preserveCursor: boolean): void {
    const seq = ++requestSeq;
    const cursor = preserveCursor ? nextCursor : null;
    loadingMore = false;
    state = "loading";
    error = null;
    notify();
    void options
      .search(buildQuery(cursor))
      .then((page) => {
        if (disposed || seq !== requestSeq) return;
        candidates = page.items;
        total = page.total;
        nextCursor = page.nextCursor;
        state = "ready";
      })
      .catch((caught) => {
        if (disposed || seq !== requestSeq) return;
        state = "error";
        error = describeSearchError(caught);
      })
      .finally(() => {
        if (!disposed && seq === requestSeq) notify();
      });
  }

  function setKind(next: ReferenceSearchKind): void {
    if (disposed || next === kind) return;
    kind = next;
    cancelDebounce();
    restart(false);
  }

  function setQuery(value: string): void {
    if (disposed) return;
    const normalized = value.trim().length > 0 ? value.trim() : null;
    if (normalized === q) return;
    q = normalized;
    cancelDebounce();
    // 立即失效旧代际与旧游标（防抖期内旧回包不得覆盖新筛选态）
    requestSeq += 1;
    nextCursor = null;
    loadingMore = false;
    debounceHandle = options.setTimer(() => {
      debounceHandle = null;
      restart(false);
    }, debounceMs);
    notify();
  }

  function setVenue(next: L3QuestionType | null): void {
    if (disposed || next === venue) return;
    venue = next;
    cancelDebounce();
    if (kind !== "question") {
      // venue 仅对 question kind 生效（buildQuery 只在 question 携带 venue）：
      // source 视图下仅记录筛选待用，避免与请求结果无关的重复请求；切入 question 时随首屏携带。
      notify();
      return;
    }
    restart(false);
  }

  function setLimit(next: number | undefined): void {
    if (disposed || next === limit) return;
    limit = next;
    cancelDebounce();
    restart(true); // R4：仅 limit 变化 → cursor 保留
  }

  async function loadMore(): Promise<void> {
    if (disposed || state !== "ready" || loadingMore || nextCursor === null) return;
    const cursor = nextCursor;
    const seq = ++requestSeq;
    loadingMore = true;
    notify();
    try {
      const page = await options.search(buildQuery(cursor));
      if (disposed || seq !== requestSeq) return;
      const seen = new Set(candidates.map((item) => item.id));
      const merged = [...candidates];
      for (const item of page.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          merged.push(item);
        }
      }
      candidates = merged;
      total = page.total;
      nextCursor = page.nextCursor;
      loadingMore = false;
    } catch (caught) {
      if (disposed || seq !== requestSeq) return;
      loadingMore = false;
      error = describeSearchError(caught);
    }
    notify();
  }

  function refresh(): void {
    if (disposed) return;
    cancelDebounce();
    restart(false);
  }

  function getSnapshot(): ReferenceSearchSnapshot {
    return {
      filters: { kind, q, venue, limit },
      candidates: [...candidates],
      total,
      nextCursor,
      state,
      loadingMore,
      error,
    };
  }

  function subscribe(listener: () => void): () => void {
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  }

  function dispose(): void {
    disposed = true;
    cancelDebounce();
    subscribers.clear();
    requestSeq += 1; // 在途响应全部失效
    loadingMore = false;
  }

  // 构造即发起首页（面板打开即可见 source 候选）
  restart(false);

  return {
    setKind,
    setQuery,
    setVenue,
    setLimit,
    loadMore,
    refresh,
    getSnapshot,
    subscribe,
    dispose,
    isDisposed: () => disposed,
  };
}
