/**
 * 共享作文入口（I3 批 B）——题型空间 / 整卷 / 回看多处复用同一状态机组件：
 *  - 摘要由宿主的列表**批量读取**后下发（本组件零请求摘要；不让每个按钮自行拉整套）；
 *  - 「开始写作」= 显式 createTask（单次意图 requestId 跨未知结果重试保持；在途点击防重；
 *    后端同题复用为兜底）；「继续／查看」= 按已知 ID 只读导航（GET 零创建）；
 *  - 多记录 / 仅归档 → 记录选择（不替用户挑第一条；唯一活跃匹配时优先继续它，其他历史可展开）；
 *  - 全部导航 URL 经 origin 契约（buildWritingUrl）构造，返回目标不丢来源；
 *  - 进度一律标注「专项写作」，不冒充原卷答题状态。
 */
import { useRef, useState } from "react";
import type { WritingQuestionTaskSummary } from "@/domain";
import type { WritingDirection, WritingKind } from "@/domain/l3-writing";
import { writingClient } from "@/frontend/api/writingClient";
import { Button } from "@/frontend/components/ui/Button";
import { buildWritingUrl, type WritingOrigin } from "@/frontend/viewModels/writingNavigation";

export type WritingEntryState = "loading" | "ready" | "error";

export interface WritingQuestionEntryProps {
  questionId: string;
  kind: WritingKind;
  direction: WritingDirection;
  /** 来源导航上下文（返回原题与任务来源标识；参数不推断权限，服务端另行校验）。 */
  origin: WritingOrigin;
  /** 该题匹配的写作任务摘要（批量读取结果；可能为空）。 */
  tasks: WritingQuestionTaskSummary[];
  state: WritingEntryState;
  onRetry: () => void;
  /** 站内导航（宿主提供；组件只产出规范 URL，禁任意 returnUrl / history.back）。 */
  onNavigate: (url: string) => void;
}

/** 任务行状态文案（专项写作口径；归档额外前置标识）。 */
function summaryLabel(task: WritingQuestionTaskSummary, archived = false): string {
  const prefix = archived ? "已归档 · " : "";
  if (task.draftSheetId) return `${prefix}草稿未提交`;
  if (task.latestSubmittedSheetId) {
    const base = `已提交 ${task.revisionCount} 稿`;
    const feedback = task.feedbackState === "ready" ? "已有反馈"
      : task.feedbackState === "pending" ? "待反馈"
        : task.feedbackState === "unavailable" ? "正文已清理"
          : null;
    return `${prefix}${feedback ? `${base} · ${feedback}` : base}`;
  }
  return `${prefix}暂无进行中稿件`;
}

function recordActionLabel(task: WritingQuestionTaskSummary): string {
  if (task.draftSheetId) return "继续写作";
  if (task.latestSubmittedSheetId) return "查看本稿";
  return "查看写作记录";
}

export function WritingQuestionEntry({
  questionId,
  kind,
  direction,
  origin,
  tasks,
  state,
  onRetry,
  onNavigate,
}: WritingQuestionEntryProps) {
  const [createState, setCreateState] = useState<"idle" | "creating" | "error">("idle");
  /** 单次创建意图：结果未知（网络失败）沿用同一 requestId 重试；成功后不轮换（本实例即本意图）。 */
  const requestIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  const openRecord = (task: WritingQuestionTaskSummary) => {
    const sheetId = task.draftSheetId ?? task.latestSubmittedSheetId ?? null;
    onNavigate(buildWritingUrl({ taskId: task.taskId, sheetId, origin }));
  };

  const start = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    requestIdRef.current ??= crypto.randomUUID();
    setCreateState("creating");
    try {
      const result = await writingClient.createTask({
        requestId: requestIdRef.current,
        kind,
        direction,
        questionId,
      });
      onNavigate(buildWritingUrl({ taskId: result.task.id, sheetId: result.draft?.id ?? null, origin }));
    } catch {
      inFlightRef.current = false;
      setCreateState("error");
    }
  };

  if (state === "loading") {
    return (
      <p className="mt-1.5 text-xs text-[var(--color-ink-soft)]" data-testid="writing-entry">
        专项写作 · 读取进度…
      </p>
    );
  }

  if (state === "error") {
    return (
      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-soft)]" data-testid="writing-entry">
        专项写作 · 进度读取失败
        <Button size="sm" variant="ghost" onClick={onRetry}>重试</Button>
      </p>
    );
  }

  const active = tasks.filter((task) => task.taskStatus === "active");
  const archived = tasks.filter((task) => task.taskStatus !== "active");
  const needsChooser = active.length > 1 || (active.length === 0 && archived.length > 0);

  // 多记录 / 仅归档：记录选择（不替用户挑第一条；主动作由用户点选）。
  if (needsChooser) {
    const ordered = [...active, ...archived];
    return (
      <div className="mt-1.5 space-y-1" data-testid="writing-entry">
        <p className="text-xs text-[var(--color-ink-soft)]">专项写作 · 有多个写作记录，选择一个：</p>
        {ordered.map((task) => (
          <div
            key={task.taskId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5"
          >
            <span className="text-xs text-[var(--color-ink-soft)]">
              {summaryLabel(task, task.taskStatus !== "active")}
            </span>
            <Button size="sm" variant="ghost" onClick={() => openRecord(task)}>
              {recordActionLabel(task)}
            </Button>
          </div>
        ))}
        {active.length === 0 && (
          <Button size="sm" variant="secondary" disabled={createState === "creating"} onClick={() => void start()}>
            {createState === "creating" ? "进入中…" : createState === "error" ? "重试进入写作" : "开始新写作"}
          </Button>
        )}
        {createState === "error" && (
          <p className="text-xs text-[var(--color-accent-2)]" role="alert">进入失败，请重试</p>
        )}
      </div>
    );
  }

  // 尚未开始 / 唯一活跃记录：单按钮状态机。
  const unique = active[0] ?? null;
  return (
    <div className="mt-1.5 space-y-1" data-testid="writing-entry">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--color-ink-soft)]">
          {unique ? `专项写作 · ${summaryLabel(unique)}` : "专项写作 · 尚未开始"}
        </span>
        {unique ? (
          <Button size="sm" variant="secondary" onClick={() => openRecord(unique)}>
            {recordActionLabel(unique)}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={createState === "creating"} onClick={() => void start()}>
            {createState === "creating" ? "进入中…" : createState === "error" ? "重试进入写作" : "开始写作"}
          </Button>
        )}
      </div>
      {unique && archived.length > 0 && (
        <details className="w-full">
          <summary className="cursor-pointer text-xs text-[var(--color-ink-soft)]">历史记录（{archived.length}）</summary>
          <div className="mt-1 space-y-1">
            {archived.map((task) => (
              <div
                key={task.taskId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5"
              >
                <span className="text-xs text-[var(--color-ink-soft)]">{summaryLabel(task, true)}</span>
                <Button size="sm" variant="ghost" onClick={() => openRecord(task)}>
                  {recordActionLabel(task)}
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}
      {createState === "error" && (
        <p className="text-xs text-[var(--color-accent-2)]" role="alert">进入失败，请重试</p>
      )}
    </div>
  );
}
