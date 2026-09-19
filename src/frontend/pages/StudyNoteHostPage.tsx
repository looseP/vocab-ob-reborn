/**
 * 学习笔记编辑器 · 最小联调宿主（Task 07 专用；仅显式测试构建启用）。
 *
 * 用途：为 Task 07 提供可观察的编辑器闭环——显式新建 / 按 noteId 打开 / 编辑 /
 * 离开·重开；以真实 session/CSRF 访问真实后端（无认证旁路）。
 *
 * 这不是 Task 08 的正式笔记空间/导航：无列表、无专题、无分页；Task 08 负责产品接入。
 * 路由仅在 `VITE_N1_STUDY_NOTE_HOST=1` 构建时注册（生产构建不含本页与入口）。
 */
import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { studyNotesClient, type StudyNoteCreateResult } from "@/frontend/api/studyNotesClient";
import { StudyNoteEditor } from "@/frontend/components/studyNotes/StudyNoteEditor";
import { Button } from "@/frontend/components/ui/Button";

/** 宿主固定使用一个题型归属（Task 07 不做归属编辑 UI）。 */
const HOST_VENUE = "cloze";
const UUID_SHAPE = /^[0-9a-fA-F-]{36}$/;

export function StudyNoteHostPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const noteId = searchParams.get("noteId") ?? "";
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [manualNoteId, setManualNoteId] = useState("");
  const createRequestIdRef = useRef<string | null>(null);

  /** 显式创建：requestId 在同一次创建及重试中稳定；双击不并行创建。 */
  const createNote = async (): Promise<void> => {
    if (creating) return;
    createRequestIdRef.current ??= crypto.randomUUID();
    setCreating(true);
    setCreateError(null);
    try {
      const result: StudyNoteCreateResult = await studyNotesClient.create({
        requestId: createRequestIdRef.current,
        venue: HOST_VENUE,
      });
      createRequestIdRef.current = null; // 成功后才重置（失败重试沿用同一 requestId）
      setSearchParams({ noteId: result.item.id }, { replace: true });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <header className="space-y-1 border-b border-[var(--color-border)] pb-3">
        <h1 className="text-base font-semibold text-[var(--color-ink)]">N1 笔记编辑器 · 联调宿主（测试专用）</h1>
        <p className="text-xs text-[var(--color-ink-soft)]">
          仅用于 Task 07 联调验收；非 Task 08 正式笔记空间/导航。使用真实登录会话访问当前后端。
        </p>
      </header>

      {noteId ? (
        <section className="space-y-3" data-testid="host-editor-section">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-ink-soft)]">
            <span>
              当前笔记：<code data-testid="host-note-id">{noteId}</code>
            </span>
          </div>
          <StudyNoteEditor
            noteId={noteId}
            leaveAction={{ label: "离开（关闭当前笔记）", onLeave: () => setSearchParams({}) }}
          />
        </section>
      ) : (
        <section className="space-y-4" data-testid="host-launcher">
          <div className="space-y-2">
            <Button onClick={() => void createNote()} disabled={creating} data-testid="host-create">
              {creating ? "创建中…" : "新建笔记（显式创建）"}
            </Button>
            {createError && (
              <p className="text-xs text-[var(--color-accent-2)]" role="alert">
                创建失败：{createError}（可重试，requestId 已保持）
              </p>
            )}
          </div>
          <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
            <p className="text-xs text-[var(--color-ink)]">打开已有笔记（按 noteId）：</p>
            <div className="flex items-center gap-2">
              <input
                className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 font-mono text-xs text-[var(--color-ink)] outline-none"
                placeholder="noteId（UUID）"
                value={manualNoteId}
                onChange={(event) => setManualNoteId(event.target.value)}
                data-testid="host-open-input"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={!UUID_SHAPE.test(manualNoteId.trim())}
                onClick={() => setSearchParams({ noteId: manualNoteId.trim() })}
                data-testid="host-open"
              >
                打开
              </Button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
