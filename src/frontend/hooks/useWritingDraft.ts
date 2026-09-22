/**
 * useWritingDraft（W4）：把保存控制器接入 React。
 *
 * 职责：
 *  - 暴露受控的 text/version/state/inFlight；
 *  - 绑定 IME 合成事件（onCompositionStart / onCompositionEnd），交给 <textarea> 展开；
 *  - 导航保护：beforeunload（刷新/关闭）+ 站内守卫 navigationBlocked（以 dirty/inFlight 为准，不只看 timer）；
 *  - 卸载时清理监听器并 dispose 控制器；清理**可逆**——React StrictMode 的模拟卸载后自动重建
 *    （dispose 是终态：不重建会让 dev 下输入/保存永久失效，B 批真环境实测）。
 *
 * 不引入 localStorage / IndexedDB。提交锁由 W7 UI 持有，不在此处。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createWritingSaveController,
  type CreateWritingSaveControllerOptions,
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

function toControllerOptions(options: UseWritingDraftOptions): CreateWritingSaveControllerOptions {
  return {
    text: options.initialText,
    version: options.initialVersion,
    save: options.save,
    load: options.load,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export function useWritingDraft(options: UseWritingDraftOptions): UseWritingDraftResult {
  // 选项经 ref 传递：控制器重建（StrictMode 模拟卸载之后）取最新选项，不引入重建循环。
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [controller, setController] = useState<WritingSaveController>(() =>
    createWritingSaveController(toControllerOptions(optionsRef.current)),
  );

  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());

  // 订阅 + 可逆清理。
  // 🔴 React StrictMode（dev）在挂载后会「模拟卸载→再挂载」：cleanup 会对本控制器 dispose，
  // 若 setup 时不重建，输入/保存将永久失效（B 批真环境实测：textarea 可聚焦但 setText 全部
  // no-op、零保存请求）。dispose 的终态语义只应作用于真实卸载——真实卸载后不会再 setup，
  // 故重建不会泄漏。
  useEffect(() => {
    if (controller.isDisposed()) {
      setController(createWritingSaveController(toControllerOptions(optionsRef.current)));
      return;
    }
    const unsubscribe = controller.subscribe(() => {
      setSnapshot(controller.getSnapshot());
    });
    setSnapshot(controller.getSnapshot());
    return () => {
      unsubscribe();
      controller.dispose();
    };
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
