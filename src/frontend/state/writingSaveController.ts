/**
 * 作文草稿可靠保存控制器（W4）。
 *
 * 职责：把"用户输入"与"服务端确认"解耦，保证：
 *  - 客户端同一时刻只有一个 PATCH 在途（S§4 单在途）；
 *  - 响应只确认其"发送序号"，旧响应绝不覆盖之后的本地输入（序号纪律）；
 *  - flush() 等待"调用时刻的输入序号"被服务端确认才 resolve，失败 reject；
 *  - 800ms 防抖、IME 合成期间不发、合成结束后按防抖补发；
 *  - 仅网络/429/5xx 自动重试（退避 1/2/4 秒共 3 次），401/409/400/422 不自动重试；
 *  - 网络超时/失败后 GET 当前草稿（load）做"确认成功或进入冲突语义"的恢复；
 *  - dispose 清理 timer/listener，不伪造保存成功，在途响应被丢弃。
 *
 * 控制器本身不发网络请求：save/load 由调用方注入。
 * 不引用 localStorage / IndexedDB。
 */

export type SaveState = "clean" | "dirty" | "saving" | "retrying" | "error" | "conflict";

export interface WritingSaveControllerSnapshot {
  text: string;
  version: number;
  state: SaveState;
  inFlight: boolean;
}

export interface WritingSaveController {
  setText(text: string): void;
  setComposing(value: boolean): void;
  /** flush 回执携带「已确认正文 + 版本」——提交屏障的核对基线（S§4）。 */
  flush(): Promise<WritingSaveFlushReceipt>;
  retry(): Promise<void>;
  getSnapshot(): WritingSaveControllerSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface WritingSaveControllerSaveInput {
  text: string;
  expectedVersion: number;
}

export interface WritingSaveControllerSaveResult {
  draftVersion: number;
  textSha256: string;
}

export interface WritingSaveControllerLoadResult {
  text: string;
  version: number;
}

export interface CreateWritingSaveControllerOptions {
  text: string;
  version: number;
  save: (input: WritingSaveControllerSaveInput) => Promise<WritingSaveControllerSaveResult>;
  load?: () => Promise<WritingSaveControllerLoadResult>;
  /** 注入以便测试控制防抖与退避；默认 setTimeout/clearTimeout。 */
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** 版本冲突（409 或超时恢复无法确认成功）。不自动 last-wins。 */
export class SaveConflictError extends Error {
  constructor(message = "草稿版本冲突，需要人工确认") {
    super(message);
    this.name = "SaveConflictError";
  }
}

/** 控制器已被 dispose，无法进行保存。 */
export class SaveDisposedError extends Error {
  constructor(message = "保存控制器已释放") {
    super(message);
    this.name = "SaveDisposedError";
  }
}

const DEBOUNCE_MS = 800;
const BACKOFF_MS = [1000, 2000, 4000] as const; // 退避 1/2/4 秒，共 3 次自动重试
const MAX_AUTO_RETRIES = BACKOFF_MS.length;

function defaultSetTimer(fn: () => void, delayMs: number): unknown {
  return setTimeout(fn, delayMs);
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function errorStatus(err: unknown): number | null {
  if (err && typeof err === "object") {
    const candidate = (err as { status?: unknown; statusCode?: unknown }).status
      ?? (err as { status?: unknown; statusCode?: unknown }).statusCode;
    if (typeof candidate === "number") return candidate;
  }
  return null;
}

/** 无 status（网络错误 / 超时）视为可重试的网络故障。 */
function isNetworkError(err: unknown): boolean {
  return errorStatus(err) === null;
}

function isRetryableStatus(status: number | null): boolean {
  if (status === null) return true;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isConflictStatus(status: number | null): boolean {
  return status === 409;
}

type TimerHandle = unknown;

/**
 * flush 回执（提交屏障的基石）：**当代** 服务端已确认的正文与版本——
 * flush resolve 后调用方必须以此为准核对权威状态，不得改用"重新 GET 到的最新值"
 * 绕过冲突（S§4：提交正文必须等于本次用户确认提交的正文）。
 */
export interface WritingSaveFlushReceipt {
  text: string;
  version: number;
}

interface FlushWaiter {
  targetSeq: number;
  resolve: (receipt: WritingSaveFlushReceipt) => void;
  reject: (err: unknown) => void;
}

export function createWritingSaveController(
  options: CreateWritingSaveControllerOptions,
): WritingSaveController {
  const {
    text: initialText,
    version: initialVersion,
    save,
    load,
    setTimer = defaultSetTimer,
    clearTimer = defaultClearTimer,
  } = options;

  let text = initialText;
  let version = initialVersion;
  let state: SaveState = "clean";

  let inputSeq = 0; // 本地输入序号；每次 setText 自增
  let committedSeq = 0; // 服务端已确认的最新输入序号
  let confirmedText = initialText; // 与 committedSeq 同步的"已确认正文"（flush 回执用）
  let disposed = false;
  let inFlight = false;

  let composing = false;
  let pendingAfterCompose = false;
  let debounceTimer: TimerHandle | null = null;

  // 退避 timer 的可取消句柄
  let backoffTimer: TimerHandle | null = null;
  let backoffResolve: (() => void) | null = null;

  const listeners = new Set<() => void>();
  let waiters: FlushWaiter[] = [];

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function setState(next: SaveState): void {
    if (state !== next) {
      state = next;
    }
  }

  function getSnapshot(): WritingSaveControllerSnapshot {
    return { text, version, state, inFlight };
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function resolveEligibleWaiters(): void {
    if (waiters.length === 0) return;
    const remaining: FlushWaiter[] = [];
    for (const waiter of waiters) {
      if (waiter.targetSeq <= committedSeq) waiter.resolve({ text: confirmedText, version });
      else remaining.push(waiter);
    }
    waiters = remaining;
  }

  function rejectWaiters(err: unknown): void {
    const current = waiters;
    waiters = [];
    for (const waiter of current) waiter.reject(err);
  }

  function delayTimer(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      backoffResolve = resolve;
      backoffTimer = setTimer(() => {
        backoffTimer = null;
        backoffResolve = null;
        resolve();
      }, delayMs);
    });
  }

  /** 网络超时/失败后 GET 当前草稿，判断"其实已成功"还是"进入冲突语义"。 */
  async function reconcile(
    sentSeq: number,
    sentText: string,
    sentVersion: number,
  ): Promise<"success" | "conflict" | "unknown"> {
    if (!load || disposed) return "unknown";
    let loaded: WritingSaveControllerLoadResult;
    try {
      loaded = await load();
    } catch {
      return "unknown";
    }
    if (disposed) return "unknown";
    // 服务端内容等于刚发送内容且 version = 旧 + 1 → 可确认成功（不自动 last-wins）。
    if (loaded.text === sentText && loaded.version === sentVersion + 1) {
      version = loaded.version;
      committedSeq = sentSeq;
      confirmedText = sentText;
      return "success";
    }
    // 服务端仍是"我们上次确认的状态"（同版本、同已确认正文）→ 纯网络失败，未发生分歧：
    // 归入可重试的错误态（诚实显示"尚未保存"），不误报"另一处更新"。
    if (loaded.version === sentVersion && loaded.text === confirmedText) {
      return "unknown";
    }
    // 否则保留本地文本并进入冲突语义（不自动 last-wins）。
    return "conflict";
  }

  function scheduleAutosave(): void {
    if (debounceTimer !== null) clearTimer(debounceTimer);
    debounceTimer = setTimer(() => {
      debounceTimer = null;
      if (composing) {
        pendingAfterCompose = true;
        return;
      }
      maybeSend();
    }, DEBOUNCE_MS);
  }

  function maybeSend(): void {
    if (inFlight || disposed) return;
    if (composing) {
      pendingAfterCompose = true;
      return;
    }
    if (inputSeq === committedSeq) {
      if (state !== "clean") {
        setState("clean");
        notify();
      }
      return;
    }
    // 立即发送前取消仍在排队的防抖 timer，避免之后重复触发
    if (debounceTimer !== null) {
      clearTimer(debounceTimer);
      debounceTimer = null;
    }
    void runPipeline();
  }

  async function runPipeline(): Promise<void> {
    if (inFlight || disposed) return;
    inFlight = true;
    let retryCount = 0;
    try {
      while (!disposed) {
        if (inputSeq === committedSeq) break; // 没有需要发送的新输入

        const sentSeq = inputSeq;
        const sentText = text;
        const sentVersion = version;
        setState("saving");
        notify();

        try {
          const result = await save({ text: sentText, expectedVersion: sentVersion });
          if (disposed) return; // 在途响应被丢弃
          version = result.draftVersion;
          committedSeq = sentSeq;
          confirmedText = sentText; // 回执：该版本对应的正是本次发送的正文
          // 成功后若有更新的本地输入，循环继续补发（单在途 + 自动续发）。
        } catch (err) {
          if (disposed) return;
          const status = errorStatus(err);
          if (isConflictStatus(status)) {
            setState("conflict");
            notify();
            rejectWaiters(new SaveConflictError(err instanceof Error ? err.message : "draft conflict"));
            return;
          }
          const retryable = isRetryableStatus(status);
          if (retryable && retryCount < MAX_AUTO_RETRIES) {
            retryCount += 1;
            setState("retrying");
            notify();
            await delayTimer(BACKOFF_MS[retryCount - 1]);
            if (disposed) return;
            continue; // 退避后重发（取最新本地输入）
          }
          // 不可重试，或自动重试耗尽：网络故障尝试 load 恢复
          if (isNetworkError(err)) {
            const outcome = await reconcile(sentSeq, sentText, sentVersion);
            if (disposed) return;
            if (outcome === "success") continue;
            if (outcome === "conflict") {
              setState("conflict");
              notify();
              rejectWaiters(new SaveConflictError());
              return;
            }
            // outcome === "unknown" → 落到 error
          }
          setState("error");
          notify();
          rejectWaiters(err instanceof Error ? err : new Error("草稿保存失败"));
          return;
        }
      }
      if (!disposed) {
        setState("clean");
        notify();
        resolveEligibleWaiters();
      }
    } finally {
      inFlight = false;
    }
  }

  function setText(next: string): void {
    if (disposed) return;
    if (next === text) return;
    text = next;
    inputSeq += 1;
    setState("dirty");
    scheduleAutosave();
    // 🔴 本地输入必须立刻通知订阅者：React 受控 textarea（value=快照.text）在无状态
    // 更新时会由 ReactDOM 把值回滚到旧快照——不通知 = 用户输入直到下一个保存周期
    // （防抖/退避/完成 notify）才可见；IME 合成文本同理。
    notify();
  }

  function setComposing(value: boolean): void {
    if (disposed) return;
    if (value === composing) return;
    composing = value;
    if (!composing) {
      // compositionend 后按防抖排队补发
      pendingAfterCompose = false;
      if (inputSeq !== committedSeq) scheduleAutosave();
    }
  }

  function flush(): Promise<WritingSaveFlushReceipt> {
    if (disposed) return Promise.reject(new SaveDisposedError());
    const targetSeq = inputSeq;
    if (state === "conflict") {
      // 冲突态无法自动推进保存，必须人工确认（retry / 载入服务器稿）
      return Promise.reject(new SaveConflictError());
    }
    if (targetSeq <= committedSeq && !inFlight) {
      return Promise.resolve({ text: confirmedText, version });
    }
    maybeSend();
    return new Promise<WritingSaveFlushReceipt>((resolve, reject) => {
      waiters.push({ targetSeq, resolve, reject });
    });
  }

  function retry(): Promise<void> {
    if (disposed) return Promise.reject(new SaveDisposedError());
    // 清除 error/conflict，使管道可以重新尝试（即便仍是 409，也保持"手动重试可用"）
    setState("dirty");
    maybeSend();
    // 复用 flush 的等待机制（waiters 需携带回执签名）；retry 本身只关心成败。
    return flush().then(() => undefined);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (debounceTimer !== null) {
      clearTimer(debounceTimer);
      debounceTimer = null;
    }
    if (backoffTimer !== null) {
      clearTimer(backoffTimer);
      backoffTimer = null;
    }
    if (backoffResolve) {
      const resolve = backoffResolve;
      backoffResolve = null;
      resolve();
    }
    listeners.clear();
    // 未完成的 flush 不再可能成功，明确拒绝，避免调用方挂起
    rejectWaiters(new SaveDisposedError());
  }

  return {
    setText,
    setComposing,
    flush,
    retry,
    getSnapshot,
    subscribe,
    dispose,
  };
}
