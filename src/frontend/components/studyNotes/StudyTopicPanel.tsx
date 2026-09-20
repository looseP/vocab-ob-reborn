/**
 * 专题面板（Task 08，展示型组件；写操作经页面 → 专题协调器串行通道）。
 *
 * 展示：专题列表（标题 / 成员数 / 版本 / 选中态）、未整理入口、新建、重命名、刷新、
 * 冲突提示（409 后需显式刷新才恢复写）。
 */
import { useEffect, useState } from "react";
import type { StudyTopicDto } from "@/domain/l3-study-notes";
import { Button } from "@/frontend/components/ui/Button";
import type { StudyTopicsState } from "@/frontend/state/studyTopicCoordinator";

export interface StudyTopicPanelProps {
  topics: StudyTopicDto[];
  state: StudyTopicsState;
  error: string | null;
  selectedTopicId: string | null;
  unfiledActive: boolean;
  conflictTopicId: string | null;
  onSelectTopic: (topicId: string) => void;
  onUnfiledToggle: () => void;
  onRefresh: () => void;
  create: {
    pending: boolean;
    error: string | null;
    onSubmit: (title: string) => void;
  };
  rename:
    | {
        pending: boolean;
        error: string | null;
        onSubmit: (title: string) => void;
      }
    | null;
}

export function StudyTopicPanel(props: StudyTopicPanelProps) {
  const [createTitle, setCreateTitle] = useState("");
  const [renameTitle, setRenameTitle] = useState("");

  const selected = props.topics.find((topic) => topic.id === props.selectedTopicId) ?? null;

  // 选中专题变化时同步重命名输入框
  useEffect(() => {
    setRenameTitle(selected?.title ?? "");
  }, [selected?.id, selected?.title]);

  const conflict = selected !== null && props.conflictTopicId === selected.id;

  return (
    <aside className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3" data-testid="topic-panel">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-[var(--color-ink-soft)]">专题</h3>
        <Button size="sm" variant="ghost" onClick={props.onRefresh} data-testid="topic-refresh-button">
          刷新
        </Button>
      </div>

      {props.state === "loading" && (
        <p className="text-xs text-[var(--color-ink-soft)]" role="status">
          正在加载专题…
        </p>
      )}
      {props.state === "error" && (
        <p className="text-xs text-[var(--color-accent-2)]" role="alert" data-testid="topic-error">
          {props.error ?? "专题加载失败。"}
        </p>
      )}

      <div className="space-y-1">
        <button
          type="button"
          className={`w-full rounded-lg border px-2 py-1.5 text-left text-xs ${
            props.unfiledActive ? "border-[var(--color-accent)] text-[var(--color-ink)]" : "border-[var(--color-border)] text-[var(--color-ink-soft)]"
          }`}
          onClick={props.onUnfiledToggle}
          data-testid="topic-unfiled-button"
        >
          未整理（未加入任何专题）
        </button>
        {props.topics.map((topic) => (
          <button
            key={topic.id}
            type="button"
            className={`w-full rounded-lg border px-2 py-1.5 text-left text-xs ${
              topic.id === props.selectedTopicId ? "border-[var(--color-accent)] text-[var(--color-ink)]" : "border-[var(--color-border)] text-[var(--color-ink-soft)]"
            }`}
            onClick={() => props.onSelectTopic(topic.id)}
            data-testid="topic-item"
            data-topic-id={topic.id}
          >
            <span className="block truncate">{topic.title}</span>
            <span className="mt-0.5 block text-[10px] text-[var(--color-ink-soft)]">
              {topic.memberCount} 篇 · v{topic.version}
            </span>
          </button>
        ))}
        {props.state === "ready" && props.topics.length === 0 && (
          <p className="text-[11px] text-[var(--color-ink-soft)]">还没有专题。创建后可将笔记归入其中。</p>
        )}
      </div>

      {/* 新建专题 */}
      <div className="space-y-1 border-t border-[var(--color-border)] pt-2">
        <div className="flex items-center gap-1">
          <input
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
            placeholder="新专题名称"
            value={createTitle}
            onChange={(event) => setCreateTitle(event.target.value)}
            disabled={props.create.pending}
            data-testid="topic-create-input"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={props.create.pending || createTitle.trim().length === 0}
            onClick={() => props.create.onSubmit(createTitle)}
            data-testid="topic-create-submit"
          >
            {props.create.pending ? "创建中…" : "新建专题"}
          </Button>
        </div>
        {props.create.error && (
          <p className="text-[11px] text-[var(--color-accent-2)]" role="alert" data-testid="topic-create-error">
            {props.create.error}
          </p>
        )}
      </div>

      {/* 选中专题：重命名 / 冲突提示 */}
      {selected && props.rename && (
        <div className="space-y-1 border-t border-[var(--color-border)] pt-2" data-testid="topic-selected">
          <p className="text-[10px] text-[var(--color-ink-soft)]" data-testid="topic-version">
            当前专题 v{selected.version} · {selected.memberCount} 篇
          </p>
          <div className="flex items-center gap-1">
            <input
              className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
              value={renameTitle}
              onChange={(event) => setRenameTitle(event.target.value)}
              disabled={props.rename.pending || conflict}
              aria-label="专题名称"
              data-testid="topic-rename-input"
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={props.rename.pending || conflict || renameTitle.trim().length === 0 || renameTitle === selected.title}
              onClick={() => props.rename!.onSubmit(renameTitle)}
              data-testid="topic-rename-submit"
            >
              重命名
            </Button>
          </div>
          {conflict && (
            <p className="text-[11px] text-[var(--color-accent-2)]" role="alert" data-testid="topic-conflict">
              该专题已被其他位置修改：请先点「刷新」对齐后继续。
            </p>
          )}
          {props.rename.error && !conflict && (
            <p className="text-[11px] text-[var(--color-accent-2)]" role="alert" data-testid="topic-rename-error">
              {props.rename.error}
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
