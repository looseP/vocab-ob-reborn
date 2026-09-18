/**
 * 作文子空间宿主页（W7，S§2/§6/§10）——/l3?section=writing 的唯一落地组件。
 *
 * 数据纪律：只经 writingClient（作文专用 typed client）访问；GET 零创建（查看稿不 openSheet、
 * 不建 draft）；新稿只由显式操作（开始写作 / 开始修改）创建；任务 A→B 切换以
 * cancelled 标记 + 编辑器 key 重挂隔离在途请求与保存状态（A 的响应不会落到 B）。
 *
 * 导航纪律：未保存内容 → guardedNavigate 先确认（可复制正文备份）；提交成功后
 * replace 为规范 URL（含明确 sheetId）；对照 compareTo 需要两稿均 sealed。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { WritingSheetDetail, WritingTaskDetail } from "@/domain";
import { writingClient } from "@/frontend/api/writingClient";
import { Button } from "@/frontend/components/ui/Button";
import { WritingComparison } from "@/frontend/components/writing/WritingComparison";
import { WritingEditor } from "@/frontend/components/writing/WritingEditor";
import { WritingFeedbackPanel } from "@/frontend/components/writing/WritingFeedbackPanel";
import { WritingRevisionList } from "@/frontend/components/writing/WritingRevisionList";
import { WritingReviewInstruction } from "@/frontend/components/writing/WritingReviewInstruction";
import { WritingStartDialog } from "@/frontend/components/writing/WritingStartDialog";
import { WritingTaskList } from "@/frontend/components/writing/WritingTaskList";
import {
  buildWritingUrl,
  parseWritingSearch,
  revisionLabel,
  writingKindLabel,
} from "@/frontend/viewModels/writingNavigation";

type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string };

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error != null && "status" in error) {
    const status = (error as { status: number }).status;
    if (status === 404) return "不存在或无权访问。";
    if (status === 409) return "当前状态不允许此操作（可能已提交或已清理）。";
  }
  return "读取失败，请重试。";
}

export function L3WritingPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useMemo(() => parseWritingSearch(searchParams), [searchParams]);

  const [tasks, setTasks] = useState<LoadState<WritingTaskDetail>>({ status: "idle" });
  const [sheet, setSheet] = useState<LoadState<WritingSheetDetail>>({ status: "idle" });
  const [startOpen, setStartOpen] = useState(false);
  const [editorNonce, setEditorNonce] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"prompt" | "write" | "feedback">("write");
  const dirtyRef = useRef(false);

  const taskId = location.taskId;
  const sheetId = location.sheetId;
  const compareTo = location.compareTo;

  const loadTask = useCallback(async (id: string) => {
    setTasks({ status: "loading" });
    try {
      setTasks({ status: "ready", data: await writingClient.getTask(id) });
    } catch (error) {
      setTasks({ status: "error", message: errorMessage(error) });
    }
  }, []);

  const loadSheet = useCallback(async (tid: string, sid: string) => {
    setSheet({ status: "loading" });
    try {
      setSheet({ status: "ready", data: await writingClient.getSheet(tid, sid) });
    } catch (error) {
      setSheet({ status: "error", message: errorMessage(error) });
    }
  }, []);

  // 任务/稿件装载（cancelled 标记：任务 A→B 切换时旧响应不落地）。
  useEffect(() => {
    if (!taskId) {
      setTasks({ status: "idle" });
      return;
    }
    let cancelled = false;
    setTasks({ status: "loading" });
    writingClient
      .getTask(taskId)
      .then((data) => { if (!cancelled) setTasks({ status: "ready", data }); })
      .catch((error) => { if (!cancelled) setTasks({ status: "error", message: errorMessage(error) }); });
    return () => { cancelled = true; };
  }, [taskId]);

  useEffect(() => {
    if (!taskId || !sheetId) {
      setSheet({ status: "idle" });
      return;
    }
    let cancelled = false;
    setSheet({ status: "loading" });
    writingClient
      .getSheet(taskId, sheetId)
      .then((data) => { if (!cancelled) setSheet({ status: "ready", data }); })
      .catch((error) => { if (!cancelled) setSheet({ status: "error", message: errorMessage(error) }); });
    return () => { cancelled = true; };
  }, [taskId, sheetId, editorNonce]);

  // 任务视图（无 sheet 参数）：有草稿 → replace 到草稿规范 URL（GET 零创建，不做任何 POST）。
  useEffect(() => {
    if (!taskId || sheetId || tasks.status !== "ready") return;
    const draft = tasks.data.draftSummary;
    if (draft) {
      navigate(buildWritingUrl({ taskId, sheetId: draft.id }), { replace: true });
    }
  }, [taskId, sheetId, tasks, navigate]);

  const guardedNavigate = useCallback((url: string, replace = false) => {
    if (dirtyRef.current) {
      const confirmed = window.confirm("有未保存的修改，离开将丢失（可先「复制正文」备份）。确定离开？");
      if (!confirmed) return;
    }
    navigate(url, { replace });
  }, [navigate]);

  const goList = () => guardedNavigate("/l3?section=writing");

  const openSheet = (targetSheetId: string) =>
    guardedNavigate(buildWritingUrl({ taskId, sheetId: targetSheetId }));

  const startRevisionFrom = async (parentSheetId: string) => {
    if (!taskId) return;
    setNotice(null);
    try {
      const result = await writingClient.createDraft(taskId, { parentSheetId, seed: "copy" });
      navigate(buildWritingUrl({ taskId, sheetId: result.sheet.id }), { replace: true });
    } catch (error) {
      const details = (error as { details?: { code?: string; draftSheetId?: string } }).details;
      if ((error as { status?: number }).status === 409 && details?.code === "ACTIVE_DRAFT_EXISTS" && details.draftSheetId) {
        setNotice("已有基于其他稿的草稿，未自动覆盖；已带你前往现有草稿。");
        navigate(buildWritingUrl({ taskId, sheetId: details.draftSheetId }), { replace: true });
        return;
      }
      setNotice("创建修改稿失败，请重试。");
    }
  };

  // ── 视图 A：任务列表（无 taskId）────────────────────────────────────────
  if (!taskId) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-[var(--color-ink)]">作文</h2>
            <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">写作 → 提交 → 反馈 → 第二稿：从一段你想表达的话开始。</p>
          </div>
          <Button onClick={() => setStartOpen(true)}>开始写作</Button>
        </div>
        {notice && <p className="text-xs text-[var(--color-accent-2)]">{notice}</p>}
        <WritingTaskList
          onOpenTask={(tid, sid) => guardedNavigate(buildWritingUrl({ taskId: tid, sheetId: sid ?? null }))}
        />        <WritingStartDialog
          open={startOpen}
          onClose={() => setStartOpen(false)}
          onCreated={(result) => {
            setStartOpen(false);
            navigate(buildWritingUrl({ taskId: result.task.id, sheetId: result.draft?.id ?? null }), { replace: true });
          }}
        />
      </div>
    );
  }

  // ── 装载/错误态（idle 视作装载中；完成前不读取 data）────────────────────
  const taskLoading = tasks.status === "idle" || tasks.status === "loading";
  const sheetLoading = sheetId != null && (sheet.status === "idle" || sheet.status === "loading");
  if (taskLoading || sheetLoading) {
    return <p className="text-sm text-[var(--color-ink-soft)]">加载中…</p>;
  }
  if (tasks.status === "error") {
    return (
      <div className="space-y-2 text-sm text-[var(--color-ink-soft)]" role="alert">
        <p>{tasks.message}</p>
        <Button size="sm" variant="secondary" onClick={goList}>返回写作列表</Button>
      </div>
    );
  }
  if (sheetId != null && sheet.status === "error") {
    return (
      <div className="space-y-2 text-sm text-[var(--color-ink-soft)]" role="alert">
        <p>{sheet.message}</p>
        <Button size="sm" variant="secondary" onClick={goList}>返回写作列表</Button>
      </div>
    );
  }
  if (tasks.status !== "ready") return null; // 类型收口（不可达）

  const task = tasks.data.task;
  const revisionList = (
    <WritingRevisionList
      task={task}
      currentSheetId={sheetId}
      currentSheetSealed={sheet.status === "ready" && sheet.data.sheet.status === "sealed"}
      onOpenSheet={openSheet}
      onCompareWith={(otherId) => {
        if (!sheetId) return;
        guardedNavigate(buildWritingUrl({ taskId, sheetId, compareTo: otherId }));
      }}
      onCleared={async () => { if (sheetId) await loadSheet(taskId, sheetId); }}
    />
  );

  // ── 视图 B：任务视图（无 sheet 参数且无草稿——已提交、待第二稿）──────────
  if (!sheetId) {
    const latest = tasks.data.latestSubmittedSheetId;
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-[var(--color-ink)]">{task.title}</h2>
            <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">
              {writingKindLabel(task.kind)} · {task.direction} · 已提交 {tasks.data.revisionCount} 稿（无进行中草稿）
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={goList}>返回列表</Button>
            {latest && <Button size="sm" onClick={() => void startRevisionFrom(latest)}>开始修改（第二稿）</Button>}
          </div>
        </div>
        {notice && <p className="text-xs text-[var(--color-accent-2)]">{notice}</p>}
        {revisionList}
      </div>
    );
  }

  if (sheet.status !== "ready") return null; // 类型收口：sheetId 存在且已加载（不可达）
  const detail = sheet.data;
  const sealed = detail.sheet.status === "sealed";

  // ── 视图 C：对照模式（两稿均 sealed）────────────────────────────────────
  if (compareTo) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-[var(--color-ink)]">{task.title}</h2>
          <Button size="sm" variant="secondary" onClick={() => guardedNavigate(buildWritingUrl({ taskId, sheetId }))}>
            返回稿件
          </Button>
        </div>
        <WritingComparison
          taskId={taskId}
          leftSheetId={sheetId}
          rightSheetId={compareTo}
          onClose={() => guardedNavigate(buildWritingUrl({ taskId, sheetId }))}
        />
      </div>
    );
  }

  // ── 视图 D：稿件工作区（编辑/回看 + 反馈 + 稿次）────────────────────────
  const editor = (
    <WritingEditor
      key={`${detail.sheet.id}:${editorNonce}`}
      task={task}
      detail={detail}
      onSubmitted={async () => {
        await loadSheet(taskId, sheetId);
        await loadTask(taskId);
        navigate(buildWritingUrl({ taskId, sheetId }), { replace: true });
      }}
      onLoadServerVersion={async () => {
        await loadSheet(taskId, sheetId);
        setEditorNonce((nonce) => nonce + 1);
      }}
      onDirtyChange={(dirty) => { dirtyRef.current = dirty; }}
    />
  );

  const promptPanel = (
    <div className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <h3 className="text-xs font-semibold text-[var(--color-ink-soft)]">题目</h3>
      <p className="whitespace-pre-wrap text-sm text-[var(--color-ink)]">{task.prompt}</p>
      <div className="text-[11px] text-[var(--color-ink-soft)]">
        {revisionLabel(detail.sheet)} · {writingKindLabel(task.kind)} · {task.direction}
      </div>
    </div>
  );

  const feedbackPanel = sealed ? (
    <div className="space-y-3">
      <WritingFeedbackPanel task={task} detail={detail} onRefresh={() => loadSheet(taskId, sheetId)} />
      <details className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <summary className="cursor-pointer text-xs font-semibold text-[var(--color-ink-soft)]">本地评阅助手</summary>
        <div className="mt-2">
          <WritingReviewInstruction taskId={taskId} sheetId={sheetId} />
        </div>
      </details>
    </div>
  ) : (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-ink-soft)]">
      提交后即可获取反馈（本地评阅助手按本稿评阅）。
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-[var(--color-ink)]">{task.title}</h2>
          <p className="mt-0.5 text-[11px] text-[var(--color-ink-soft)]">
            {writingKindLabel(task.kind)} · {task.direction} · {revisionLabel(detail.sheet)}
            {sealed ? "（已提交，只读）" : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={goList}>返回列表</Button>
          {sealed && (
            <Button size="sm" onClick={() => void startRevisionFrom(detail.sheet.id)}>开始修改（第二稿）</Button>
          )}
        </div>
      </div>

      {notice && <p className="text-xs text-[var(--color-accent-2)]">{notice}</p>}

      {/* 手机页签（切页签不卸载：以 hidden 控制显隐，编辑状态保留） */}
      <div className="flex gap-1 md:hidden" role="tablist" aria-label="写作视图切换">
        {([["prompt", "题目"], ["write", "写作"], ["feedback", "反馈"]] as const).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={mobileTab === key}
            className={`rounded-full px-3 py-1 text-xs ${mobileTab === key ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-ink-soft)]"}`}
            onClick={() => setMobileTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_380px]">
        {/* 手机：页签切换（hidden 控制显隐，组件保持挂载不卸载）；桌面：双栏固定。 */}
        <div className={mobileTab === "write" ? "block" : "hidden md:block"}>{editor}</div>
        <aside className="space-y-3">
          <div className={mobileTab === "prompt" ? "block" : "hidden md:block"}>{promptPanel}</div>
          <div className={mobileTab === "feedback" ? "block" : "hidden md:block"}>{feedbackPanel}</div>
          <div className={mobileTab === "feedback" ? "block" : "hidden md:block"}>{revisionList}</div>
        </aside>
      </div>
    </div>
  );
}
