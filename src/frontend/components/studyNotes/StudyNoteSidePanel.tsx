/**
 * Task 09B · 卷面内学习笔记侧栏（宿主）。
 *
 * 职责：在**不卸载卷面**的前提下，提供「选择/搜索/分页笔记 → 显式创建 → 编辑保存」的侧栏。
 * 与 `L3StudyNotesPage`（子空间页面）的区别：本组件是**卷面宿主**，不参与路由切换，
 * 不持有题纸任何状态，也不重写编辑器保存实现。
 *
 * 复用（不新建第二套）：
 *  - 列表/搜索/分页：`createStudyNoteListModel`（Task 08 模型，原样复用）；
 *  - 编辑与保存：`StudyNoteEditor` + `useStudyNoteEditor`（Task 07 合同）；
 *  - 归属筛选：`L3_QUESTION_TYPES` / 归属校验沿用 domain；
 *  - 离页屏障：编辑器经 `onRegisterLeaveBarrier` 注册，宿主把「吞错型」`requestNavigation`
 *    适配成 `NoteLeaveBarrier` 的显式结果（见 `toNoteLeaveBarrier`），交给卷面合成。
 *
 * 纪律（任务书 §3 不变量 + §1 产品交互）：
 *  - 浏览/搜索/预览/取消**零创建**；只有显式「新建笔记」才 POST；
 *  - 空态显示，**绝不自动创建**；
 *  - 关闭/切换笔记先确认当前笔记：失败、冲突、IME 期间保留编辑器与本地输入；
 *  - 不新增 URL 持久化参数（本批范围）；`lastNoteId` 由卷面宿主用内存状态记住，
 *    以便关闭后重开可重新读取最后选择的笔记。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { L3QuestionType } from "@/domain/l3-question-types";
import { L3_QUESTION_TYPES, L3_QUESTION_TYPE_LABELS } from "@/domain/l3-question-types";
import type { ReferenceTarget, StudyNoteSummary } from "@/domain/l3-study-notes";import { studyNotesClient, type StudyNotesClient } from "@/frontend/api/studyNotesClient";
import { Button } from "@/frontend/components/ui/Button";
import { StudyNoteEditor, type StudyNoteLeaveBarrier } from "@/frontend/components/studyNotes/StudyNoteEditor";
import { StudyNoteList } from "@/frontend/components/studyNotes/StudyNoteList";
import type { NoteLeaveBarrier } from "@/frontend/state/sheetLeaveBarrier";
import { createStudyNoteListModel, type StudyNoteListModel, type StudyNoteListSnapshot } from "@/frontend/state/studyNoteListModel";

export interface StudyNoteSidePanelProps {
  /** 注入客户端（测试/联调）；默认单例。 */
  client?: StudyNotesClient;
  /** 卷面当前题型（用于列表筛选默认值；不写回笔记归属）。 */
  venue?: L3QuestionType | null;
  /**
   * 关闭侧栏。经**确认过的**关闭才调用（脏笔记保存成功后才请求关闭）；
   * 宿主负责在此刻卸载编辑器。
   */
  onRequestClose: () => void;
  /** 把笔记屏障注册给卷面宿主（卷面用于与题纸屏障合成）。卸载时以 null 解除。 */
  onRegisterNoteBarrier?: (barrier: NoteLeaveBarrier | null) => void;
  /** 打开时恢复上次选择的笔记（关闭后重开可重读最后选择；本批不落 URL）。 */
  initialNoteId?: string | null;
  /** 选择的笔记变化时通知卷面宿主（仅内存记忆，不入 URL）。 */
  onNoteSelected?: (noteId: string | null) => void;
  /**
   * 卷面「引用到笔记」发起的预置目标（当前题目/当前素材的真实身份）。
   * 经编辑器透传给引用面板做初始预览；插入仍须用户显式点击。
   * `nonce` 变化表示发起了一次新请求（同一目标重复发起也应重新对准）。
   */
  presetReference?: { target: ReferenceTarget; nonce: number } | null;
}

function describeOpError(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (status === 401) return "登录状态已失效，请重新登录后重试。";
    if (status === 403) return "没有权限执行该操作。";
    if (typeof status === "number" && status >= 500) return "服务暂时不可用，请稍后重试。";
  }
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.trim()) return message;
  return fallback;
}

function createUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * 把编辑器注册的「吞错型」屏障（`requestNavigation` 只把失败写进 `navigationError`）
 * 适配为 `NoteLeaveBarrier` 的**显式结果**形态：合成器据此判定成败并归因。
 *
 * 成败判定：不依赖 try/catch（该函数从不 reject），而是看传给屏障的 action 是否被真正执行
 * （失败路径绝不执行 action → 我们传入的探针保持未触发）。
 *
 * 原因来源：优先读屏障上挂的 `getNavigationError()`（**ref 同步镜像**，当次即可读）；
 * 缺失时回落到宿主上报的最近原因，最后才是通用文案。不能只读 React 状态——状态传播
 * 晚于 `await` 结算，会把 IME/冲突等具体原因误报成通用文案。
 */
export function toNoteLeaveBarrier(
  barrier: StudyNoteLeaveBarrier,
  readNavigationError: () => string | null,
): NoteLeaveBarrier {
  return async (action) => {
    let navigated = false;
    await barrier(() => {
      navigated = true;
    });
    if (!navigated) {
      const sync = (barrier as StudyNoteLeaveBarrier & { getNavigationError?: () => string | null })
        .getNavigationError;
      const reason = (sync ? sync() : null) ?? readNavigationError() ?? "笔记保存未完成，暂不能离开。";
      return { ok: false, reason };
    }
    // 笔记侧已确认：执行调用方给的 action（合成器传 no-op；真实导航由合成器统一执行）。
    await action();
    return { ok: true };
  };
}

export function StudyNoteSidePanel({
  client,
  venue = null,
  onRequestClose,
  onRegisterNoteBarrier,
  initialNoteId = null,
  onNoteSelected,
  presetReference = null,
}: StudyNoteSidePanelProps) {
  const resolvedClient = client ?? studyNotesClient;
  const clientRef = useRef<StudyNotesClient>(resolvedClient);
  clientRef.current = resolvedClient;

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(initialNoteId);
  /**
   * 题型筛选（默认取卷面当前题型；用户可在侧栏内改）。
   *
   * 兜底：列表查询契约要求 `venue` 必填（`l3StudyNoteListQuerySchema`），若上游给 null
   * 会导致模型 `buildQuery` 返回 null → **永不取数**（空白面板，连空态都不出现）。
   * 这里回落到首个题型，保证侧栏始终能取到列表与空态；不改后端合同、不擅自给笔记加归属。
   */
  const [filterVenue, setFilterVenue] = useState<L3QuestionType | null>(venue ?? L3_QUESTION_TYPES[0] ?? null);
  const [snapshot, setSnapshot] = useState<StudyNoteListSnapshot | null>(null);
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createPendingRef = useRef(false);
  const createRequestIdRef = useRef<string | null>(null);

  /** 编辑器注册的原始屏障（用于「关闭/切换前先确认」）。 */
  const editorBarrierRef = useRef<StudyNoteLeaveBarrier | null>(null);
  /** 编辑器最近一次导航错误（适配层据此判定成败并给出**真实**原因）。 */
  const navigationErrorRef = useRef<string | null>(null);
  const handleNavigationBlocked = useCallback((reason: string | null) => {
    navigationErrorRef.current = reason;
  }, []);
  const handleRegisterEditorBarrier = useCallback((barrier: StudyNoteLeaveBarrier | null) => {
    editorBarrierRef.current = barrier;
    if (!barrier) navigationErrorRef.current = null; // 卸载即清：旧原因不得用于新身份
  }, []);

  // ── 列表模型（Task 08 原样复用；浏览/搜索/分页零创建）──────────────────────
  const listRef = useRef<StudyNoteListModel | null>(null);
  if (listRef.current === null) {
    listRef.current = createStudyNoteListModel({
      fetchPage: (query) => clientRef.current.list(query),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
  }
  const list = listRef.current;

  useEffect(() => {
    const unsubscribe = list.subscribe(() => setSnapshot(list.getSnapshot()));
    setSnapshot(list.getSnapshot());
    void list.refresh();
    return () => {
      unsubscribe();
    };
  }, [list]);

  useEffect(() => {
    // 题型筛选：只影响列表查询，**不**写回任何笔记归属。
    list.setVenue(filterVenue);
  }, [list, filterVenue]);

  // ── 关闭/切换前先确认当前笔记（干净零写；脏则保存成功后才放行）─────────────
  const [closing, setClosing] = useState(false);
  const confirmCurrent = useCallback(async (): Promise<boolean> => {
    const barrier = editorBarrierRef.current;
    if (!barrier) return true; // 无编辑器（未选笔记/已卸载）：无需确认
    let navigated = false;
    await barrier(() => {
      navigated = true;
    });
    return navigated; // 失败路径不会执行 action → false（保留编辑器与本地输入）
  }, []);

  const handleClose = useCallback(async (): Promise<void> => {
    if (closing) return;
    setClosing(true);
    try {
      const ok = await confirmCurrent();
      if (!ok) return; // 保存失败/冲突/IME：留在原位，编辑器与本地输入保留
      onRequestClose();
    } finally {
      setClosing(false);
    }
  }, [closing, confirmCurrent, onRequestClose]);

  const handleSelect = useCallback(
    async (noteId: string | null): Promise<void> => {
      if (noteId === selectedNoteId) return;
      const ok = await confirmCurrent();
      if (!ok) return; // 切笔记同样先确认；失败不换身份（不丢本地输入）
      setSelectedNoteId(noteId);
      onNoteSelected?.(noteId);
    },
    [selectedNoteId, confirmCurrent, onNoteSelected],
  );

  // ── 显式创建（唯一 POST；requestId 重试间稳定；双击守卫）───────────────────
  const handleCreate = useCallback(async (): Promise<void> => {
    if (createPendingRef.current) return;
    // 创建用**用户当前选择的筛选题型**（整卷混合题型时不得擅自决定归属）。
    const targetVenue = filterVenue ?? venue ?? L3_QUESTION_TYPES[0];
    if (!targetVenue) return;
    createPendingRef.current = true;
    setCreatePending(true);
    setCreateError(null);
    const requestId = createRequestIdRef.current ?? createUuid();
    createRequestIdRef.current = requestId;
    try {
      const { item } = await clientRef.current.create({ requestId, venue: targetVenue });
      createRequestIdRef.current = null; // 成功：幂等键完成使命
      // 新建后先确认当前笔记（若有脏内容），再换到新笔记。
      const ok = await confirmCurrent();
      if (!ok) return;
      setSelectedNoteId(item.id);
      onNoteSelected?.(item.id);
      void list.refresh();
    } catch (error) {
      setCreateError(describeOpError(error, "创建失败")); // requestId 保留：重试同一幂等键
    } finally {
      createPendingRef.current = false;
      setCreatePending(false);
    }
  }, [filterVenue, venue, confirmCurrent, onNoteSelected, list]);

  // ── 屏障上报：把「显式结果」形态交给卷面宿主合成 ─────────────────────────────
  useEffect(() => {
    if (!onRegisterNoteBarrier) return;
    const forwarder: NoteLeaveBarrier = async (action) => {
      const barrier = editorBarrierRef.current;
      if (!barrier) {
        await action();
        return { ok: true };
      }
      return toNoteLeaveBarrier(barrier, () => navigationErrorRef.current)(action);
    };
    onRegisterNoteBarrier(forwarder);
    return () => onRegisterNoteBarrier(null);
  }, [onRegisterNoteBarrier]);

  const items = snapshot?.items ?? [];
  const showEmpty = snapshot?.state === "ready" && items.length === 0;

  const body = useMemo(() => {
    if (selectedNoteId) {
      return (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Button size="sm" variant="ghost" onClick={() => void handleSelect(null)} disabled={closing} data-testid="study-note-panel-back">
              返回列表
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <StudyNoteEditor
              noteId={selectedNoteId}
              client={resolvedClient}
              onRegisterLeaveBarrier={handleRegisterEditorBarrier}
              presetReferenceTarget={presetReference?.target ?? null}
              onNavigationBlocked={handleNavigationBlocked}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="study-note-panel-venue">
            按题型筛选
          </label>
          {/*
            题型筛选：只改**列表查询**（model.setVenue），不写回任何笔记归属——
            不给现有笔记新增或移除归属，也不因此创建笔记。
            选项均为**真实题型**：列表查询契约要求 venue 必填（l3StudyNoteListQuerySchema），
            无后端语义的「全部题型」空值会让列表落入永不取数路径（假空态），故不提供；
            onChange 同样拒绝空值（防御：任何情况下不构造 null-venue 查询）。
          */}
          <select
            id="study-note-panel-venue"
            data-testid="study-note-panel-venue"
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-ink)]"
            value={filterVenue ?? ""}
            onChange={(event) => {
              const nextVenue = event.target.value;
              if (!nextVenue) return; // 契约：venue 必填；空值不得进入查询路径
              setFilterVenue(nextVenue as L3QuestionType);
            }}
          >
            {L3_QUESTION_TYPES.map((option) => (
              <option key={option} value={option}>
                {L3_QUESTION_TYPE_LABELS[option]}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={() => void handleCreate()} disabled={createPending} data-testid="study-note-panel-create">
            {createPending ? "创建中…" : "新建笔记"}
          </Button>
        </div>
        {createError && (
          <p className="text-xs text-[var(--color-accent-2)]" role="alert">
            {createError}
          </p>
        )}
        {showEmpty ? (
          <div
            className="rounded-xl border border-dashed border-[var(--color-border)] p-4 text-sm text-[var(--color-ink-soft)]"
            data-testid="study-note-panel-empty"
            role="status"
          >
            还没有学习笔记。点击「新建笔记」显式创建。
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <StudyNoteList
              items={items}
              total={snapshot?.total ?? 0}
              state={snapshot?.state ?? "loading"}
              error={snapshot?.error ?? null}
              loadingMore={snapshot?.loadingMore ?? false}
              nextCursor={snapshot?.nextCursor ?? null}
              activeNoteId={selectedNoteId}
              onOpen={(row: StudyNoteSummary) => void handleSelect(row.id)}
              onLoadMore={() => void list.loadMore()}
              onRetry={() => void list.refresh()}
              onArchiveToggle={() => {
                // 归档/恢复不在侧栏范围（列表只承担选择）；避免出现半实现入口。
              }}
              rowBusyId={null}
              rowError={null}
            />
          </div>
        )}
      </div>
    );
  }, [
    selectedNoteId,
    resolvedClient,
    filterVenue,
    createPending,
    createError,
    showEmpty,
    items,
    snapshot,
    list,
    handleSelect,
    handleCreate,
    handleRegisterEditorBarrier,
    handleNavigationBlocked,
    closing,
    presetReference,
  ]);

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col gap-2 border-l border-[var(--color-border)] bg-[var(--color-surface)] p-3"
      aria-label="学习笔记"
      data-testid="study-note-side-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-[var(--color-ink)]">学习笔记</h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void handleClose()}
          disabled={closing}
          data-testid="study-note-panel-close"
          aria-label="关闭学习笔记侧栏"
        >
          {closing ? "保存中…" : "关闭"}
        </Button>
      </div>
      {body}
    </aside>
  );
}
