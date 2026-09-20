/**
 * 学习笔记空间页（Task 08）——/l3?section=study-notes 的唯一落地组件。
 *
 * 纪律（对齐执行台账 §1）：
 *  - 创建纪律：唯一 POST 入口 = 显式「新建笔记」（requestId 在创建及重试间稳定；双击守卫）；
 *    GET / F5 / 历史 / 深链 / 翻页 / 筛选一律零创建；
 *  - 深链：先 GET 完成身份/所有权校验（含 venue ∈ note.venues）才挂载编辑器；
 *    非法组合 = 无效入口空态（不创建、不静默纠偏）；404/无权 = 不泄露内容的空态；
 *  - 列表：studyNoteListModel（筛选变化清 cursor / 分页去重 / 搜索防抖 + 序号守卫）；
 *  - 专题：studyTopicCoordinator（串行写 + 服务端版本 + 409 停写待刷新）；
 *  - 离页：站内导航统一经编辑器注册的导航屏障（flush 成功才执行）；
 *    浏览器前进/后退经 useStudyNoteHistoryGuard（同一屏障）；
 *  - 状态：venue/topicId/noteId/refId 在 URL（唯一真源）；q/status/unfiled 为本地筛选态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { L3_QUESTION_TYPES, L3_QUESTION_TYPE_LABELS } from "@/domain/l3-question-types";
import {
  normalizeStudyUuid,
  type StudyNoteDto,
  type StudyNoteStatus,
  type StudyNoteSummary,
} from "@/domain/l3-study-notes";
import { studyNotesClient, type StudyNotesClient } from "@/frontend/api/studyNotesClient";
import { Button } from "@/frontend/components/ui/Button";
import { StudyNoteEditor, type StudyNoteLeaveBarrier } from "@/frontend/components/studyNotes/StudyNoteEditor";
import { StudyNoteList } from "@/frontend/components/studyNotes/StudyNoteList";
import { StudyTopicPanel } from "@/frontend/components/studyNotes/StudyTopicPanel";
import { useStudyNoteHistoryGuard } from "@/frontend/hooks/useStudyNoteHistoryGuard";
import {
  createStudyNoteListModel,
  type StudyNoteListModel,
  type StudyNoteListSnapshot,
} from "@/frontend/state/studyNoteListModel";
import {
  createStudyTopicCoordinator,
  type StudyTopicCoordinator,
  type StudyTopicsSnapshot,
} from "@/frontend/state/studyTopicCoordinator";
import {
  buildStudyNoteUrl,
  parseStudyNoteNavigation,
} from "@/frontend/viewModels/studyNoteNavigation";

export type { StudyNoteLeaveBarrier };

export interface L3StudyNotesPageProps {
  /** 注入客户端（测试/宿主）；默认单例。 */
  client?: StudyNotesClient;
  /** Task 08：把页面级离开屏障注册给宿主（L3Page shell 导航复用）。 */
  onRegisterLeaveBarrier?: (barrier: StudyNoteLeaveBarrier | null) => void;
}

type NotePaneState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; note: StudyNoteDto }
  | { status: "invalid-entry" }
  | { status: "error"; message: string; retryable: boolean };

function createUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function describeNoteError(error: unknown): string {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (status === 404 || status === 403) return "笔记不存在或无权访问。";
    if (status === 401) return "登录状态已失效，请重新登录。";
  }
  return "加载笔记失败，请重试。";
}

function describeOpError(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (status === 409) return "已被其他位置修改：请刷新后重试。";
    if (status === 422) return "操作被拒绝（内容不合法或超出限制）。";
    if (status === 403 || status === 404) return "对象不存在或无权访问。";
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return `${fallback}：${message}`;
  }
  return fallback;
}

export function L3StudyNotesPage({ client, onRegisterLeaveBarrier }: L3StudyNotesPageProps) {
  const resolvedClient = client ?? studyNotesClient;
  const clientRef = useRef<StudyNotesClient>(resolvedClient);
  clientRef.current = resolvedClient;

  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const nav = useMemo(() => parseStudyNoteNavigation(searchParams), [searchParams]);

  // ── 模型（渲染期惰性创建 + StrictMode dispose 后重建）──────────────────────
  const listRef = useRef<StudyNoteListModel | null>(null);
  const topicsRef = useRef<StudyTopicCoordinator | null>(null);
  const [modelGen, setModelGen] = useState(0);

  const ensureModels = useCallback((): void => {
    if (!listRef.current || listRef.current.isDisposed()) {
      listRef.current = createStudyNoteListModel({
        fetchPage: (query) => clientRef.current.list(query),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      });
    }
    if (!topicsRef.current || topicsRef.current.isDisposed()) {
      topicsRef.current = createStudyTopicCoordinator({ client: clientRef.current });
    }
  }, []);
  ensureModels();

  const [listSnap, setListSnap] = useState<StudyNoteListSnapshot>(() => listRef.current!.getSnapshot());
  const [topicsSnap, setTopicsSnap] = useState<StudyTopicsSnapshot>(() => topicsRef.current!.getSnapshot());

  useEffect(() => {
    const recreated = listRef.current?.isDisposed() ?? true;
    ensureModels();
    const list = listRef.current!;
    const topics = topicsRef.current!;
    const unsubList = list.subscribe(() => setListSnap(list.getSnapshot()));
    const unsubTopics = topics.subscribe(() => setTopicsSnap(topics.getSnapshot()));
    setListSnap(list.getSnapshot());
    setTopicsSnap(topics.getSnapshot());
    if (recreated) setModelGen((value) => value + 1); // 重建后驱动路由/加载 effect 重跑
    return () => {
      unsubList();
      unsubTopics();
      list.dispose();
      topics.dispose();
    };
  }, [ensureModels]);

  // ── URL → 模型同步（venue/topicId 为 URL 真源；原子应用避免双请求）──────────
  useEffect(() => {
    const list = listRef.current;
    if (!list || !nav.venue) return;
    list.setRoute(nav.venue, nav.topicId);
  }, [nav.venue, nav.topicId, modelGen]);

  useEffect(() => {
    const topics = topicsRef.current;
    if (!topics || !nav.venue) return;
    void topics.load(nav.venue);
  }, [nav.venue, modelGen]);

  // ── 深链校验（GET-only；先身份/所有权，后挂载编辑器）───────────────────────
  const [pane, setPane] = useState<NotePaneState>({ status: "idle" });
  const [paneNonce, setPaneNonce] = useState(0);
  const paneGeneration = useRef(0);

  useEffect(() => {
    if (!nav.noteId) {
      setPane({ status: "idle" });
      return;
    }
    if (nav.invalidEntry) {
      setPane({ status: "invalid-entry" });
      return;
    }
    const venue = nav.venue;
    if (!venue) {
      setPane({ status: "invalid-entry" });
      return;
    }
    let cancelled = false;
    const generation = ++paneGeneration.current;
    setPane({ status: "loading" });
    clientRef.current
      .get(nav.noteId)
      .then(({ item }) => {
        if (cancelled || generation !== paneGeneration.current) return;
        if (normalizeStudyUuid(item.id) !== normalizeStudyUuid(nav.noteId!)) {
          setPane({ status: "error", message: "服务器返回的笔记与请求身份不符，已停止加载。", retryable: false });
          return;
        }
        if (!item.venues.includes(venue)) {
          setPane({ status: "invalid-entry" }); // 不静默纠偏、不创建替代
          return;
        }
        setPane({ status: "ready", note: item });
      })
      .catch((error: unknown) => {
        if (cancelled || generation !== paneGeneration.current) return;
        setPane({ status: "error", message: describeNoteError(error), retryable: true });
      });
    return () => {
      cancelled = true;
    };
  }, [nav.noteId, nav.venue, nav.invalidEntry, paneNonce]);

  // ── 导航屏障（编辑器注册 → history guard / 站内导航复用）────────────────────
  const leaveBarrierRef = useRef<StudyNoteLeaveBarrier | null>(null);
  const handleRegisterEditorBarrier = useCallback((barrier: StudyNoteLeaveBarrier | null) => {
    leaveBarrierRef.current = barrier;
  }, []);

  useEffect(() => {
    if (!onRegisterLeaveBarrier) return;
    const forwarder: StudyNoteLeaveBarrier = (action) => {
      const barrier = leaveBarrierRef.current;
      if (!barrier) return Promise.resolve().then(() => action()).then(() => undefined);
      return barrier(action);
    };
    onRegisterLeaveBarrier(forwarder);
    return () => onRegisterLeaveBarrier(null);
  }, [onRegisterLeaveBarrier]);

  // enabled 同时要求「URL 仍在笔记上」：后退到列表的那一次渲染里 pane 仍是 ready（effect 未跑），
  // 只按 pane 判定会在列表 URL 上迟到激活哨兵 → 截断前进栈。noteKey 直接用 nav.noteId，
  // 避免 pane ready 过渡产生一次多余重激活。
  useStudyNoteHistoryGuard({
    enabled: pane.status === "ready" && nav.noteId !== null,
    noteKey: nav.noteId,
    attemptLeave: (proceed) => {
      const barrier = leaveBarrierRef.current;
      if (barrier) return barrier(proceed);
      proceed();
      return undefined;
    },
  });

  /** 站内导航统一入口：有屏障走屏障（flush 成功才导航），无屏障直接导航。 */
  const guardedNavigate = useCallback(
    (url: string, options?: { replace?: boolean }) => {
      const action = () => navigate(url, options);
      const barrier = leaveBarrierRef.current;
      if (barrier) {
        void barrier(action);
        return;
      }
      void action();
    },
    [navigate],
  );

  // ── 显式创建（唯一 POST；requestId 重试间稳定；双击守卫）────────────────────
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createPendingRef = useRef(false);
  const createRequestIdRef = useRef<string | null>(null);

  const handleCreate = useCallback(async (): Promise<void> => {
    const venue = nav.venue;
    if (!venue || createPendingRef.current) return;
    createPendingRef.current = true;
    setCreatePending(true);
    setCreateError(null);
    const requestId = createRequestIdRef.current ?? createUuid();
    createRequestIdRef.current = requestId;
    try {
      const { item } = await clientRef.current.create({ requestId, venue });
      createRequestIdRef.current = null; // 成功：幂等键完成使命
      const url = buildStudyNoteUrl({ venue, topicId: nav.topicId, noteId: item.id });
      const action = (): void => {
        void navigate(url, { replace: true });
      };
      const barrier = leaveBarrierRef.current;
      if (barrier) void barrier(action);
      else action();
      void listRef.current?.refresh();
    } catch (error) {
      setCreateError(describeOpError(error, "创建失败")); // requestId 保留：重试同一幂等键
    } finally {
      createPendingRef.current = false;
      setCreatePending(false);
    }
  }, [nav.venue, nav.topicId, navigate]);

  // ── 列表动作 ───────────────────────────────────────────────────────────────
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const rowBusyRef = useRef<string | null>(null);

  const handleArchiveToggle = useCallback(async (row: StudyNoteSummary): Promise<void> => {
    if (rowBusyRef.current) return;
    rowBusyRef.current = row.id;
    setRowBusyId(row.id);
    setRowError(null);
    try {
      const { item } = await clientRef.current.get(row.id);
      const targetStatus = item.status === "active" ? "archived" : "active";
      // 归档/恢复经保存通道：完整快照 + expectedVersion（以最新 GET 为基线）
      await clientRef.current.save(row.id, {
        expectedVersion: item.version,
        requestId: createUuid(),
        title: item.title,
        bodyMd: item.bodyMd,
        venues: item.venues,
        pinned: item.pinned,
        status: targetStatus,
        references: item.references.map((reference) => ({ id: reference.id, action: "keep" as const })),
      });
      await listRef.current?.refresh();
    } catch (error) {
      setRowError(describeOpError(error, "操作失败"));
    } finally {
      rowBusyRef.current = null;
      setRowBusyId(null);
    }
  }, []);

  // ── 专题成员动作（经协调器串行通道；成员变更后刷新列表）────────────────────
  const [memberBusy, setMemberBusy] = useState(false);
  const memberBusyRef = useRef(false);

  const runMemberOp = useCallback(
    async (
      topicId: string | null,
      task: (coordinator: StudyTopicCoordinator, topicId: string) => Promise<unknown>,
    ): Promise<void> => {
      const coordinator = topicsRef.current;
      if (!topicId || !coordinator || memberBusyRef.current) return;
      memberBusyRef.current = true;
      setMemberBusy(true);
      setRowError(null);
      try {
        await task(coordinator, topicId);
        await listRef.current?.refresh();
      } catch (error) {
        setRowError(describeOpError(error, "操作失败"));
      } finally {
        memberBusyRef.current = false;
        setMemberBusy(false);
      }
    },
    [],
  );

  const handleMoveUp = useCallback(
    (row: StudyNoteSummary, index: number): void => {
      void runMemberOp(nav.topicId, async (coordinator, topicId) => {
        const members = listRef.current?.getSnapshot().items ?? [];
        const beforeNoteId = index >= 1 ? (members[index - 1]?.id ?? null) : null; // 目标前一个成员
        await coordinator.moveMember(topicId, row.id, beforeNoteId);
      });
    },
    [runMemberOp, nav.topicId],
  );

  const handleMoveDown = useCallback(
    (row: StudyNoteSummary, index: number): void => {
      void runMemberOp(nav.topicId, async (coordinator, topicId) => {
        const list = listRef.current;
        if (!list) return;
        let members = list.getSnapshot().items;
        // 跨页：目标位置不可见时先加载更多直至可见（不得用局部列表推断全量顺序）
        if (index + 2 >= members.length && list.getSnapshot().nextCursor !== null) {
          await list.loadMore();
          members = list.getSnapshot().items;
        }
        const beforeNoteId = members[index + 2]?.id ?? null; // 目标后一个成员之前（null=末尾）
        await coordinator.moveMember(topicId, row.id, beforeNoteId);
      });
    },
    [runMemberOp, nav.topicId],
  );

  const handleRemoveMember = useCallback(
    (row: StudyNoteSummary): void => {
      void runMemberOp(nav.topicId, async (coordinator, topicId) => {
        await coordinator.removeMember(topicId, row.id); // 移出不删除笔记（服务端保证）
      });
    },
    [runMemberOp, nav.topicId],
  );

  /** 未整理视图下 nav.topicId 为 null（URL 已清），加入目标以行内选择为准。 */
  const handleJoinTopic = useCallback(
    (row: StudyNoteSummary, topicId: string): void => {
      void runMemberOp(topicId, async (coordinator, joinedTopicId) => {
        await coordinator.moveMember(joinedTopicId, row.id, null); // 加入（移到末尾）
      });
    },
    [runMemberOp],
  );

  // ── 专题动作 ───────────────────────────────────────────────────────────────
  const [topicOpError, setTopicOpError] = useState<string | null>(null);

  const handleCreateTopic = useCallback(async (title: string): Promise<void> => {
    setTopicOpError(null);
    try {
      await topicsRef.current?.createTopic(title);
    } catch (error) {
      setTopicOpError(describeOpError(error, "创建专题失败"));
    }
  }, []);

  const handleRenameTopic = useCallback(
    async (title: string): Promise<void> => {
      const topicId = nav.topicId;
      const coordinator = topicsRef.current;
      if (!topicId || !coordinator) return;
      const topic = coordinator.getSnapshot().topics.find((item) => item.id === topicId);
      if (!topic) return;
      setTopicOpError(null);
      try {
        await coordinator.saveTopic(topicId, { title, status: topic.status });
      } catch (error) {
        setTopicOpError(describeOpError(error, "重命名失败"));
      }
    },
    [nav.topicId],
  );

  const handleSelectTopic = useCallback(
    (topicId: string): void => {
      if (!nav.venue) return;
      guardedNavigate(
        buildStudyNoteUrl({ venue: nav.venue, topicId, noteId: nav.noteId, refId: nav.refId }),
      );
    },
    [nav.venue, nav.noteId, nav.refId, guardedNavigate],
  );

  const handleUnfiledToggle = useCallback((): void => {
    const list = listRef.current;
    if (!list || !nav.venue) return;
    if (list.getSnapshot().filters.unfiled) {
      list.setUnfiled(false);
      return;
    }
    // 清 URL 的 topicId（与 unfiled 互斥），再进入未整理视图
    guardedNavigate(buildStudyNoteUrl({ venue: nav.venue, noteId: nav.noteId, refId: nav.refId }));
    list.setUnfiled(true);
  }, [nav.venue, nav.noteId, nav.refId, guardedNavigate]);

  // ── 列表筛选 UI ───────────────────────────────────────────────────────────
  const [searchText, setSearchText] = useState("");
  const handleSearchChange = useCallback((value: string): void => {
    setSearchText(value);
    listRef.current?.setQuery(value);
  }, []);

  // ── 视图 ───────────────────────────────────────────────────────────────────
  const content = (() => {
    if (nav.invalidEntry) {
      return (
        <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4" data-testid="invalid-entry">
          <p className="text-sm text-[var(--color-ink)]">这个入口无效：笔记参数不完整或不属于当前题型。</p>
          <p className="text-xs text-[var(--color-ink-soft)]">已停止加载（不会创建或替换任何笔记）。</p>
          <Button size="sm" variant="secondary" onClick={() => guardedNavigate(buildStudyNoteUrl({}))}>
            返回学习笔记
          </Button>
        </div>
      );
    }

    if (!nav.venue) {
      return (
        <div className="space-y-3" data-testid="venue-picker">
          <p className="text-sm text-[var(--color-ink-soft)]">选择题型开始：每个题型的笔记独立成册。</p>
          <div className="flex flex-wrap gap-1.5">
            {L3_QUESTION_TYPES.map((venue) => (
              <button
                key={venue}
                type="button"
                className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-ink-soft)] hover:border-[var(--color-accent)]"
                onClick={() => guardedNavigate(buildStudyNoteUrl({ venue }))}
                data-testid={`venue-${venue}`}
              >
                {L3_QUESTION_TYPE_LABELS[venue]}
              </button>
            ))}
          </div>
        </div>
      );
    }

    const venue = nav.venue;
    const selectedTopicId = nav.topicId;
    const conflict =
      selectedTopicId !== null && topicsSnap.conflictTopicId === selectedTopicId
        ? "该专题已被其他位置修改：请先刷新专题。"
        : null;

    return (
      <div className="space-y-3">
        {/* 题型切换 */}
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="题型">
          {L3_QUESTION_TYPES.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={item === venue}
              className={`rounded-full px-3 py-1 text-xs ${
                item === venue
                  ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast,var(--color-surface))]"
                  : "border border-[var(--color-border)] text-[var(--color-ink-soft)]"
              }`}
              onClick={() => guardedNavigate(buildStudyNoteUrl({ venue: item }))}
              data-testid={`venue-chip-${item}`}
            >
              {L3_QUESTION_TYPE_LABELS[item]}
            </button>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_420px]">
          {/* 左栏：专题 + 列表 */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-[var(--color-ink)]">学习笔记 · {L3_QUESTION_TYPE_LABELS[venue]}</h2>
              </div>
              <Button size="sm" onClick={() => void handleCreate()} disabled={createPending} data-testid="new-note-button">
                {createPending ? "创建中…" : "新建笔记"}
              </Button>
            </div>

            {createError && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-accent-2)]" role="alert" data-testid="create-error">
                <span>{createError}</span>
                <Button size="sm" variant="secondary" onClick={() => void handleCreate()} data-testid="new-note-retry">
                  重试新建
                </Button>
              </div>
            )}

            <StudyTopicPanel
              topics={topicsSnap.topics}
              state={topicsSnap.state}
              error={topicsSnap.error}
              selectedTopicId={selectedTopicId}
              unfiledActive={listSnap.filters.unfiled}
              conflictTopicId={topicsSnap.conflictTopicId}
              onSelectTopic={handleSelectTopic}
              onUnfiledToggle={handleUnfiledToggle}
              onRefresh={() => void topicsRef.current?.refresh()}
              total={topicsSnap.total}
              nextCursor={topicsSnap.nextCursor}
              loadingMoreTopics={topicsSnap.loadingMoreTopics}
              onLoadMoreTopics={() => void topicsRef.current?.loadMore()}
              create={{
                pending: topicsSnap.createPending,
                error: topicsSnap.createError ?? topicOpError,
                onSubmit: (title) => void handleCreateTopic(title),
              }}
              rename={
                selectedTopicId !== null
                  ? {
                      pending: topicsSnap.writePendingTopicId === selectedTopicId,
                      error: topicOpError,
                      onSubmit: (title) => void handleRenameTopic(title),
                    }
                  : null
              }
            />
            {conflict && (
              <p className="text-xs text-[var(--color-accent-2)]" role="alert" data-testid="topic-conflict-banner">
                {conflict}
              </p>
            )}

            {/* 筛选 */}
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
                placeholder="搜索标题…"
                value={searchText}
                onChange={(event) => handleSearchChange(event.target.value)}
                data-testid="search-input"
              />
              <select
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-ink)]"
                value={listSnap.filters.status ?? ""}
                onChange={(event) =>
                  listRef.current?.setStatus(event.target.value === "" ? null : (event.target.value as StudyNoteStatus))
                }
                data-testid="status-filter"
              >
                <option value="">全部</option>
                <option value="active">未归档</option>
                <option value="archived">已归档</option>
              </select>
            </div>

            <StudyNoteList
              items={listSnap.items}
              total={listSnap.total}
              state={listSnap.state}
              error={listSnap.error}
              loadingMore={listSnap.loadingMore}
              nextCursor={listSnap.nextCursor}
              activeNoteId={nav.noteId}
              onOpen={(row) =>
                guardedNavigate(
                  buildStudyNoteUrl({ venue, topicId: selectedTopicId, noteId: row.id }),
                )
              }
              onLoadMore={() => void listRef.current?.loadMore()}
              onRetry={() => void listRef.current?.refresh()}
              onArchiveToggle={(row) => void handleArchiveToggle(row)}
              rowBusyId={rowBusyId}
              rowError={rowError}
              member={
                selectedTopicId !== null
                  ? {
                      busy: memberBusy,
                      canMoveUp: (index) => index > 0,
                      canMoveDown: (index) => index < listSnap.items.length - 1 || listSnap.nextCursor !== null,
                      onMoveUp: handleMoveUp,
                      onMoveDown: handleMoveDown,
                      onRemove: handleRemoveMember,
                    }
                  : undefined
              }
              join={
                listSnap.filters.unfiled
                  ? {
                      topics: topicsSnap.topics.filter((topic) => topic.status === "active"),
                      busy: memberBusy,
                      onJoin: handleJoinTopic,
                    }
                  : undefined
              }
            />
          </section>

          {/* 右栏：笔记编辑器 / 空态 */}
          <section className="min-w-0" data-testid="note-pane">
            {pane.status === "idle" && (
              <p className="rounded-xl border border-dashed border-[var(--color-border)] p-4 text-sm text-[var(--color-ink-soft)]">
                打开左侧列表中的笔记，或点「新建笔记」开始写作。
              </p>
            )}
            {pane.status === "loading" && (
              <p className="text-sm text-[var(--color-ink-soft)]" role="status" data-testid="note-loading">
                正在加载笔记…
              </p>
            )}
            {pane.status === "invalid-entry" && (
              <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4" data-testid="invalid-entry">
                <p className="text-sm text-[var(--color-ink)]">这个入口无效：该笔记不属于当前题型。</p>
                <p className="text-xs text-[var(--color-ink-soft)]">已停止加载（不会创建或替换任何笔记）。</p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => guardedNavigate(buildStudyNoteUrl({ venue }))}
                >
                  返回列表
                </Button>
              </div>
            )}
            {pane.status === "error" && (
              <div className="space-y-2 rounded-xl border border-[var(--color-accent-2)] bg-[var(--color-surface)] p-4" role="alert" data-testid="note-error">
                <p className="text-sm text-[var(--color-ink)]">{pane.message}</p>
                {pane.retryable && (
                  <Button size="sm" variant="secondary" onClick={() => setPaneNonce((value) => value + 1)}>
                    重试
                  </Button>
                )}
              </div>
            )}
            {pane.status === "ready" && (
              <>
                {nav.refId && !pane.note.references.some((reference) => reference.id.toLowerCase() === nav.refId) && (
                  <p className="mb-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-ink-soft)]" data-testid="ref-missing-notice">
                    该引用已移除（笔记仍可正常打开）。
                  </p>
                )}
                <StudyNoteEditor
                  noteId={pane.note.id}
                  client={resolvedClient}
                  leaveAction={{
                    label: "返回列表",
                    onLeave: () => {
                      navigate(buildStudyNoteUrl({ venue, topicId: selectedTopicId }));
                    },
                  }}
                  onRegisterLeaveBarrier={handleRegisterEditorBarrier}
                />
              </>
            )}
          </section>
        </div>
      </div>
    );
  })();

  return (
    <div className="space-y-3" data-testid="study-notes-page">
      {content}
    </div>
  );
}
