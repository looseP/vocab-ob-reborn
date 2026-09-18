/**
 * useWritingDraft（W4）：把保存控制器接入 React。
 *
 * 职责：
 *  - 暴露受控的 text/version/state/inFlight；
 *  - 绑定 IME 合成事件（onCompositionStart / onCompositionEnd），交给 <textarea> 展开；
 *  - 导航保护：beforeunload（刷新/关闭）+ 站内守卫 navigationBlocked（以 dirty/inFlight 为准，不只看 timer）；
 *  - 卸载时清理所有监听器并 dispose 控制器。
 *
 * 不引入 localStorage / IndexedDB。提交锁由 W7 UI 持有，不在此处。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createWritingSaveController,
  type SaveState,
  type WritingSaveController,
  type WritingSaveControllerLoadResult,
  type WritingSaveControllerSaveInput,
  type WritingSaveControllerSaveResult,
  type WritingSaveFlushReceipt,
} from "@/frontend/state/writingSaveController";

export interface UseWritingDraftOptions {
  initialText: string;
  initialVersion: number;
  save: (input: WritingSaveControllerSaveInput) => Promise<WritingSaveControllerSaveResult>;
  load?: () => Promise<WritingSaveControllerLoadResult>;
}

export interface UseWritingDraftResult {
  text: string;
  version: number;
  state: SaveState;
  inFlight: boolean;
  setText: (text: string) => void;
  /** flush 回执：已确认正文+版本；提交屏障据此核对权威状态（不盲目采信 GET 最新值）。 */
  flush: () => Promise<WritingSaveFlushReceipt>;
  retry: () => Promise<void>;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  /** 以 dirty/inFlight 为准：站内离开前是否应阻止（刷新/关闭由 beforeunload 负责）。 */
  navigationBlocked: boolean;
}

export function useWritingDraft(options: UseWritingDraftOptions): UseWritingDraftResult {
  const controllerRef = useRef<WritingSaveController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createWritingSaveController({
      text: options.initialText,
      version: options.initialVersion,
      save: options.save,
      load: options.load,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
  }
  const controller = controllerRef.current;

  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());

  useEffect(() => {
    const unsubscribe = controller.subscribe(() => {
      setSnapshot(controller.getSnapshot());
    });
    return unsubscribe;
  }, [controller]);

  // beforeunload：刷新/关闭时若有未保存内容或在途请求，提示浏览器保留
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: Event): void => {
      const snap = controller.getSnapshot();
      if (snap.state !== "clean") {
        event.preventDefault();
        (event as unknown as { returnValue?: string }).returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [controller]);

  // 卸载：清理所有监听器并释放控制器（在途响应被丢弃，不伪造成功）
  useEffect(() => {
    return () => {
      controller.dispose();
    };
  }, [controller]);

  const setText = useCallback((next: string) => controller.setText(next), [controller]);
  const flush = useCallback(() => controller.flush(), [controller]);
  const retry = useCallback(() => controller.retry(), [controller]);
  const onCompositionStart = useCallback(() => controller.setComposing(true), [controller]);
  const onCompositionEnd = useCallback(() => controller.setComposing(false), [controller]);

  const navigationBlocked = snapshot.state !== "clean";

  return {
    text: snapshot.text,
    version: snapshot.version,
    state: snapshot.state,
    inFlight: snapshot.inFlight,
    setText,
    flush,
    retry,
    onCompositionStart,
    onCompositionEnd,
    navigationBlocked,
  };
}
