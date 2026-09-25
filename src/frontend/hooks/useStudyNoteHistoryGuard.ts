/**
 * useStudyNoteHistoryGuard（Task 08）——把前进/后退 flush 屏障接入浏览器与路由。
 *
 * cancelTo 采用「路由感知恢复」：先经 React Router `navigate(editorUrl)` 压入同 URL 条目
 * （保证 RR 内部 location 与浏览器 URL 一致、编辑器不卸载），再把 marker 合并进
 * history.state（保证后续落在该条目上时按「原位」处理）。raw pushState 会导致 RR
 * 与 URL 不一致（RR 不监听 pushState），因此必须走 navigate。
 */
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  StudyNoteHistoryGuard,
  STUDY_NOTES_GUARD_MARKER,
  type StudyNoteHistoryAdapter,
} from "@/frontend/state/studyNoteHistoryGuard";

export interface UseStudyNoteHistoryGuardOptions {
  /** 编辑器视图就绪时为 true（含深链校验通过）。 */
  enabled: boolean;
  /** noteId 变化时重新激活（吸收新位置并更新屏障）。 */
  noteKey: string | null;
  /** 屏障：flush 成功才执行 action（= hook 的 requestNavigation）。 */
  attemptLeave: (proceed: () => void) => void | Promise<void>;
}

function createWindowAdapter(): StudyNoteHistoryAdapter {
  return {
    getState: () => {
      const state = window.history.state;
      return state && typeof state === "object" ? (state as Record<string, unknown>) : null;
    },
    pushState: (state, url) => {
      window.history.pushState(state, "", url);
    },
    getHref: () => window.location.href,
    go: (delta) => {
      window.history.go(delta);
    },
    addPopStateListener: (listener) => {
      window.addEventListener("popstate", listener);
      return () => window.removeEventListener("popstate", listener);
    },
  };
}

export function useStudyNoteHistoryGuard(options: UseStudyNoteHistoryGuardOptions): void {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const attemptRef = useRef(options.attemptLeave);
  attemptRef.current = options.attemptLeave;

  const guardRef = useRef<StudyNoteHistoryGuard | null>(null);
  if (guardRef.current === null && typeof window !== "undefined") {
    guardRef.current = new StudyNoteHistoryGuard(createWindowAdapter(), {
      cancelTo: (editorUrl) => {
        // 路由感知恢复：RR 同步 push 编辑 URL（同 URL），补 marker（不动 RR 的 usr/key/idx）
        navigateRef.current(editorUrl);
        const state = window.history.state;
        const merged: Record<string, unknown> =
          state && typeof state === "object"
            ? { ...(state as Record<string, unknown>), [STUDY_NOTES_GUARD_MARKER]: true }
            : { [STUDY_NOTES_GUARD_MARKER]: true };
        window.history.replaceState(merged, "");
      },
    });
  }

  useEffect(() => {
    if (!options.enabled) return;
    const guard = guardRef.current;
    if (!guard) return;
    return guard.activate(window.location.href, (proceed) => attemptRef.current(proceed));
    // noteKey 变化时重新激活：在新位置重新吸收一次后退
    // eslint-disable-next-line react-hooks/exhaustive-deps -- enabled/noteKey 为激活条件
  }, [options.enabled, options.noteKey]);
}
