/**
 * 学习笔记列表模型（Task 08）——纯 TS、可注入计时器（不读 React/DOM）。
 *
 * 纪律（§3.3）：
 *  - 加载/翻页只经 `fetchPage`（消费方绑定为 studyNotesClient.list；浏览零 POST）；
 *  - 任何筛选变化（venue/topicId/unfiled/status/pinned/q）→ **清 cursor 重新起翻**；
 *  - `topicId` 与 `unfiled` 互斥（本模型兜底，UI 亦禁止同选）；
 *  - 搜索防抖 300ms；请求序号守卫（旧响应丢弃，防覆盖新结果）；
 *  - 跨页按 id 去重；`total` 原样透传（服务端过滤口径）；
 *  - `refresh()`（归档/成员变更后）保留旧列表直至新数据到达，不闪空。
 */
import type { L3QuestionType } from "@/domain/l3-question-types";
import type { StudyNoteStatus, StudyNoteSummary, StudyPage } from "@/domain/l3-study-notes";

export type StudyNoteListState = "idle" | "loading" | "ready" | "error";

export interface StudyNoteListFilters {
  venue: L3QuestionType | null;
  q: string | null;
  status: StudyNoteStatus | null;
  pinned: boolean | null;
  unfiled: boolean;
  topicId: string | null;
}

export interface StudyNoteListPageQuery {
  venue: L3QuestionType;
  q?: string;
  status?: StudyNoteStatus;
  pinned?: boolean;
  unfiled?: boolean;
  topicId?: string;
  cursor?: string;
  limit?: number;
}

export interface StudyNoteListSnapshot {
  filters: StudyNoteListFilters;
  items: StudyNoteSummary[];
  total: number;
  nextCursor: string | null;
  state: StudyNoteListState;
  loadingMore: boolean;
  error: string | null;
}

export interface StudyNoteListModelOptions {
  fetchPage(query: StudyNoteListPageQuery): Promise<StudyPage<StudyNoteSummary>>;
  pageSize?: number;
  debounceMs?: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface StudyNoteListModel {
  /** 原子应用路由（venue/topicId 同源，避免双请求）。 */
  setRoute(venue: L3QuestionType | null, topicId: string | null): void;
  setVenue(venue: L3QuestionType | null): void;
  setTopic(topicId: string | null): void;
  setUnfiled(unfiled: boolean): void;
  setQuery(q: string): void;
  setStatus(status: StudyNoteStatus | null): void;
  setPinned(pinned: boolean | null): void;
  loadMore(): Promise<void>;
  refresh(): Promise<void>;
  getSnapshot(): StudyNoteListSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
  isDisposed(): boolean;
}

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_DEBOUNCE_MS = 300;

function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (status === 401) return "登录状态已失效，请重新登录后重试。";
    if (typeof status === "number" && status >= 500) return "服务暂时不可用，请稍后重试。";
  }
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.trim()) return message;
  return "加载失败，请重试。";
}

export function createStudyNoteListModel(options: StudyNoteListModelOptions): StudyNoteListModel {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const filters: StudyNoteListFilters = {
    venue: null,
    q: null,
    status: null,
    pinned: null,
    unfiled: false,
    topicId: null,
  };
  let items: StudyNoteSummary[] = [];
  let total = 0;
  let nextCursor: string | null = null;
  let state: StudyNoteListState = "idle";
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

  function buildQuery(cursor: string | null): StudyNoteListPageQuery | null {
    if (!filters.venue) return null;
    const query: StudyNoteListPageQuery = { venue: filters.venue, limit: pageSize };
    if (filters.q) query.q = filters.q;
    if (filters.status) query.status = filters.status;
    if (filters.pinned !== null) query.pinned = filters.pinned;
    if (filters.unfiled) query.unfiled = true;
    if (filters.topicId) query.topicId = filters.topicId;
    if (cursor) query.cursor = cursor;
    return query;
  }

  /** 重置（清 cursor/items）并立即取第一页。 */
  function resetAndFetch(): void {
    cancelDebounce();
    nextCursor = null;
    items = [];
    total = 0;
    loadingMore = false;
    error = null;
    state = "loading";
    notify();
    void fetchFirstPage();
  }

  async function fetchFirstPage(): Promise<void> {
    const query = buildQuery(null);
    if (!query) {
      state = "ready";
      notify();
      return;
    }
    const seq = ++requestSeq;
    try {
      const page = await options.fetchPage(query);
      if (disposed || seq !== requestSeq) return; // 序号守卫：旧响应丢弃
      items = page.items;
      total = page.total;
      nextCursor = page.nextCursor;
      state = "ready";
      error = null;
    } catch (caught) {
      if (disposed || seq !== requestSeq) return;
      state = "error";
      error = describeError(caught);
    }
    notify();
  }

  /** refresh：保留旧列表直至新数据到达（不闪空）。 */
  async function refresh(): Promise<void> {
    if (disposed) return;
    const query = buildQuery(null);
    if (!query) return;
    const seq = ++requestSeq;
    try {
      const page = await options.fetchPage(query);
      if (disposed || seq !== requestSeq) return;
      items = page.items;
      total = page.total;
      nextCursor = page.nextCursor;
      state = "ready";
      error = null;
    } catch (caught) {
      if (disposed || seq !== requestSeq) return;
      state = "error";
      error = describeError(caught);
    }
    notify();
  }

  async function loadMore(): Promise<void> {
    if (disposed || state !== "ready" || loadingMore || nextCursor === null) return;
    const query = buildQuery(nextCursor);
    if (!query) return;
    loadingMore = true;
    notify();
    const seq = ++requestSeq;
    try {
      const page = await options.fetchPage(query);
      if (disposed || seq !== requestSeq) return; // 筛选已变：丢弃
      const seen = new Set(items.map((item) => item.id));
      const merged = [...items];
      for (const item of page.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          merged.push(item);
        }
      }
      items = merged;
      total = page.total;
      nextCursor = page.nextCursor;
      loadingMore = false;
    } catch (caught) {
      if (disposed || seq !== requestSeq) return;
      loadingMore = false;
      error = describeError(caught); // 保留已有 items，仅提示
    }
    notify();
  }

  // ── 筛选入口 ──────────────────────────────────────────────────────────────

  /** 原子应用路由（venue 变化时清 topic/unfiled；避免 setVenue+setTopic 双请求）。 */
  function setRoute(venue: L3QuestionType | null, topicId: string | null): void {
    if (disposed) return;
    const venueChanged = venue !== filters.venue;
    const topicChanged = topicId !== filters.topicId;
    if (!venueChanged && !topicChanged) return;
    filters.venue = venue;
    filters.topicId = topicId;
    if (venueChanged || topicId !== null) filters.unfiled = false; // 与 unfiled 互斥
    resetAndFetch();
  }

  function setVenue(venue: L3QuestionType | null): void {
    if (disposed) return;
    if (venue === filters.venue) return;
    filters.venue = venue;
    filters.topicId = null; // 换题型重置专题
    filters.unfiled = false;
    resetAndFetch();
  }

  function setTopic(topicId: string | null): void {
    if (disposed || topicId === filters.topicId) return;
    filters.topicId = topicId;
    if (topicId !== null) filters.unfiled = false; // 与 unfiled 互斥
    resetAndFetch();
  }

  function setUnfiled(unfiled: boolean): void {
    if (disposed || unfiled === filters.unfiled) return;
    filters.unfiled = unfiled;
    if (unfiled) filters.topicId = null; // 与 topicId 互斥
    resetAndFetch();
  }

  function setQuery(q: string): void {
    if (disposed) return;
    const normalized = q.trim().length > 0 ? q.trim() : null;
    if (normalized === filters.q) return;
    filters.q = normalized;
    cancelDebounce();
    if (filters.venue) {
      debounceHandle = options.setTimer(() => {
        debounceHandle = null;
        resetAndFetch();
      }, debounceMs);
    }
    notify(); // q 立即反映（输入框受控），请求待防抖
  }

  function setStatus(status: StudyNoteStatus | null): void {
    if (disposed || status === filters.status) return;
    filters.status = status;
    resetAndFetch();
  }

  function setPinned(pinned: boolean | null): void {
    if (disposed || pinned === filters.pinned) return;
    filters.pinned = pinned;
    resetAndFetch();
  }

  // ── 快照 / 订阅 / 生命周期 ────────────────────────────────────────────────

  function getSnapshot(): StudyNoteListSnapshot {
    return {
      filters: { ...filters },
      items: [...items],
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
    requestSeq += 1; // 令在途响应全部失效
  }

  return {
    setRoute,
    setVenue,
    setTopic,
    setUnfiled,
    setQuery,
    setStatus,
    setPinned,
    loadMore,
    refresh,
    getSnapshot,
    subscribe,
    dispose,
    isDisposed: () => disposed,
  };
}
