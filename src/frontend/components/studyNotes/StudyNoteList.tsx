/**
 * 学习笔记列表（Task 08，展示型组件；数据与操作经 props 注入）。
 *
 * 展示：标题 / 归属题型 / 状态（已归档 · 置顶）/ 更新时间；当前打开笔记高亮（data-active）。
 * 行为入口：打开、加载更多、重试、归档/恢复（经页面保存通道）、专题成员操作（上移/下移/移出）、
 * 未整理视图的「加入专题」。
 */
import { useState } from "react";
import { L3_QUESTION_TYPE_LABELS } from "@/domain/l3-question-types";
import type { StudyNoteSummary, StudyTopicDto } from "@/domain/l3-study-notes";
import { Button } from "@/frontend/components/ui/Button";
import type { StudyNoteListState } from "@/frontend/state/studyNoteListModel";

export interface StudyNoteListMemberActions {
  busy: boolean;
  canMoveUp: (index: number) => boolean;
  canMoveDown: (index: number) => boolean;
  onMoveUp: (row: StudyNoteSummary, index: number) => void;
  onMoveDown: (row: StudyNoteSummary, index: number) => void;
  onRemove: (row: StudyNoteSummary) => void;
}

export interface StudyNoteListJoinActions {
  topics: StudyTopicDto[];
  busy: boolean;
  onJoin: (row: StudyNoteSummary, topicId: string) => void;
}

export interface StudyNoteListProps {
  items: StudyNoteSummary[];
  total: number;
  state: StudyNoteListState;
  error: string | null;
  loadingMore: boolean;
  nextCursor: string | null;
  activeNoteId: string | null;
  onOpen: (row: StudyNoteSummary) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onArchiveToggle: (row: StudyNoteSummary) => void;
  rowBusyId: string | null;
  rowError: string | null;
  member?: StudyNoteListMemberActions;
  join?: StudyNoteListJoinActions;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function JoinTopicControl({
  row,
  topics,
  busy,
  onJoin,
}: {
  row: StudyNoteSummary;
  topics: StudyTopicDto[];
  busy: boolean;
  onJoin: (row: StudyNoteSummary, topicId: string) => void;
}) {
  const [topicId, setTopicId] = useState("");
  if (topics.length === 0) return null;
  return (
    <span className="flex items-center gap-1">
      <select
        className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[11px] text-[var(--color-ink)]"
        value={topicId}
        onChange={(event) => setTopicId(event.target.value)}
        disabled={busy}
        aria-label="选择专题"
        data-testid="row-topic-select"
      >
        <option value="">选择专题…</option>
        {topics.map((topic) => (
          <option key={topic.id} value={topic.id}>
            {topic.title}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || !topicId}
        onClick={() => {
          if (topicId) onJoin(row, topicId);
        }}
        data-testid="row-join-submit"
      >
        加入专题
      </Button>
    </span>
  );
}

export function StudyNoteList(props: StudyNoteListProps) {
  const { items, state, error, loadingMore, nextCursor } = props;

  return (
    <div className="space-y-2" data-testid="study-note-list">
      <div className="flex items-center justify-between text-xs text-[var(--color-ink-soft)]">
        <span data-testid="list-total">共 {props.total} 篇</span>
        {props.rowError && (
          <span className="text-[var(--color-accent-2)]" role="alert" data-testid="row-error">
            {props.rowError}
          </span>
        )}
      </div>

      {state === "loading" && (
        <p className="text-sm text-[var(--color-ink-soft)]" role="status">
          正在加载…
        </p>
      )}

      {state === "error" && (
        <div className="space-y-2 text-sm text-[var(--color-ink-soft)]" role="alert" data-testid="list-error">
          <p>{error ?? "加载失败。"}</p>
          <Button size="sm" variant="secondary" onClick={props.onRetry}>
            重试
          </Button>
        </div>
      )}

      {state === "ready" && items.length === 0 && (
        <p
          className="rounded-xl border border-dashed border-[var(--color-border)] p-4 text-sm text-[var(--color-ink-soft)]"
          data-testid="list-empty"
        >
          这里还没有笔记。点「新建笔记」写下第一条。
        </p>
      )}

      {items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((row, index) => {
            const active = row.id === props.activeNoteId;
            const busy = props.rowBusyId === row.id;
            return (
              <li
                key={row.id}
                data-testid="study-note-row"
                data-note-id={row.id}
                data-active={active ? "true" : undefined}
                className={`rounded-lg border px-3 py-2 ${
                  active ? "border-[var(--color-accent)] bg-[var(--color-accent-soft,var(--color-surface))]" : "border-[var(--color-border)]"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => props.onOpen(row)}
                    data-testid="row-open"
                  >
                    <span className="block truncate text-sm text-[var(--color-ink)]">
                      {row.title.trim() ? row.title : "（无标题笔记）"}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-[var(--color-ink-soft)]">
                      {row.venues.map((venue) => L3_QUESTION_TYPE_LABELS[venue] ?? venue).join(" · ")}
                      {" · "}
                      {formatUpdatedAt(row.updatedAt)}
                      {row.status === "archived" ? " · 已归档" : ""}
                      {row.pinned ? " · 置顶" : ""}
                    </span>
                  </button>
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    {props.member && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={props.member.busy || !props.member.canMoveUp(index)}
                          onClick={() => props.member!.onMoveUp(row, index)}
                          data-testid="row-move-up"
                          aria-label="上移"
                        >
                          上移
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={props.member.busy || !props.member.canMoveDown(index)}
                          onClick={() => props.member!.onMoveDown(row, index)}
                          data-testid="row-move-down"
                          aria-label="下移"
                        >
                          下移
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={props.member.busy}
                          onClick={() => props.member!.onRemove(row)}
                          data-testid="row-remove-topic"
                        >
                          移出专题
                        </Button>
                      </>
                    )}
                    {props.join && (
                      <JoinTopicControl row={row} topics={props.join.topics} busy={props.join.busy} onJoin={props.join.onJoin} />
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => props.onArchiveToggle(row)}
                      data-testid={row.status === "active" ? "row-archive" : "row-restore"}
                    >
                      {busy ? "处理中…" : row.status === "active" ? "归档" : "恢复"}
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {nextCursor !== null && (
        <Button size="sm" variant="secondary" onClick={props.onLoadMore} disabled={loadingMore} data-testid="load-more-button">
          {loadingMore ? "加载中…" : "加载更多"}
        </Button>
      )}
    </div>
  );
}
