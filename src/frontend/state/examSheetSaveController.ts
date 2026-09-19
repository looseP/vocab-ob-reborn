/**
 * 题纸作答可靠保存控制器（Task B + Q，2026-09-19）。
 *
 * 与作文 text 控制器（writingSaveController）同构但**不复用**：题纸是「逐题答案
 * 映射」语义，PATCH 为题目键级整体替换 + 版本 CAS；作文是单字符串正文 + 版本 CAS。
 *
 * 职责（任务书 S/V/Q 合同）：
 *  - 客户端同一时刻只有一个 PATCH 在途（单在途写队列）；
 *  - **逐题脏键**：每次编辑记录 {seq, answer}；成功确认后只清除「仍是同一发送
 *    序号」的键——在途期间再次编辑的题保留，决不夹带/清除错键（Q1 保存后只改
 *    Q2，下一请求不含旧 Q1）；
 *  - 请求载荷在**发送时刻冻结**（structuredClone），后续本地改动不污染已发请求；
 *  - 单批最多 200 个题目键：超限按序号分批发，前一批确认后才发下一批（不并发在途）；
 *  - 自动重试（网络/429/5xx，退避 1/2/4 秒共 3 次）沿用**同一载荷与版本**，期间
 *    新编辑留到下一批；401/400/422/409 不自动重试；
 *  - **expectedVersion**：每次请求携带客户端确认版本；409 = 版本冲突/已在别处
 *    定格 → 进入 conflict（保留本地输入、停止自动写），恢复动作是
 *    `adoptServerBaseline`（明确载入服务器版本）而非盲试；
 *  - flush() 等待「调用时刻的输入序号」全部被服务端确认才 resolve（410 守卫），
 *    回执携带 {draftVersion,lastSavedAt}——定格/导出屏障的核对基线；
 *  - **订阅合同（S）**：终态帧必须反映 inFlight 已释放（clean/error/conflict 的
 *    最后快照 inFlight=false）；dispose 后不再发通知；订阅者在完成通知里重入
 *    （再次 setAnswer+flush）时由 finally 排出，不依赖防抖。
 *
 * 控制器本身不发网络请求：save 由调用方注入（封装 patchSheet + 本地 sheet 状态更新）。
 * 不引用 localStorage / IndexedDB。
 */

import type { SheetAnswer } from "@/domain/l3-sheets";

export type ExamSheetSaveState =
  | "clean"
  | "dirty"
  | "saving"
  | "retrying"
  | "error"
  | "conflict";

export interface ExamSheetSaveSnapshot {
  state: ExamSheetSaveState;
  inFlight: boolean;
  lastSavedAt: string | null;
}

/** flush 回执：本次 flush 确认后已落库的最新草稿版本（定格/导出屏障的核对基线）。 */
export interface ExamSheetSaveFlushReceipt {
  draftVersion: number;
  lastSavedAt: string | null;
}

export interface ExamSheetSaveController {
  /** 记录一次题级作答变更（answer=null 表示清除该题）。立即推进序号并防抖排发。 */
  setAnswer(questionId: string, answer: SheetAnswer | null): void;
  setComposing(value: boolean): void;
  /** 等待「调用时刻的输入序号」全部被服务端确认；失败 reject（阻断定格/导出）。 */
  flush(): Promise<ExamSheetSaveFlushReceipt>;
  /** 手动重试（error 后可用）；conflict 不得盲试——须先 adoptServerBaseline。 */
  retry(): Promise<void>;
  /** 注入服务端已确认的最新草稿版本（开纸装配后调用；未装配前不发送）。 */
  setDraftVersion(version: number): void;
  /** Q6 恢复动作：明确载入服务器版本——放弃本地未确认输入、重建编辑基线（离开 conflict）。 */
  adoptServerBaseline(version: number): void;
  /** 题纸进入终态后停止发送（只读期不触发任何 PATCH）。 */
  freeze(): void;
  /** 是否已释放（StrictMode 双挂载/重挂载守卫：已释放实例须重建）。 */
  isDisposed(): boolean;
  getSnapshot(): ExamSheetSaveSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface ExamSheetSaveControllerSaveInput {
  answers: Record<string, SheetAnswer | null>;
  /** V：客户端确认版本——服务端条件 UPDATE 的 CAS 基线。 */
  expectedVersion: number;
}

export interface ExamSheetSaveControllerSaveResult {
  draftVersion: number;
}

export interface CreateExamSheetSaveControllerOptions {
  sheetId: string;
  /** 初始草稿版本；缺省为「未装配」（null），不得缺省成 0 掩盖漏装配（Q 合同）。 */
  draftVersion?: number;
  save: (input: ExamSheetSaveControllerSaveInput) => Promise<ExamSheetSaveControllerSaveResult>;
  /** 注入以便测试控制防抖与退避；默认 setTimeout/clearTimeout。 */
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** 题纸已被他处定格/版本冲突（PATCH 返回 409）。不自动 last-wins。 */
export class ExamSheetSaveConflictError extends Error {
  constructor(message = "题纸保存冲突：可能已在另一处定格，需要人工确认") {
    super(message);
    this.name = "ExamSheetSaveConflictError";
  }
}

/** 控制器已被 dispose，无法保存。 */
export class ExamSheetSaveDisposedError extends Error {
  constructor(message = "题纸保存控制器已释放") {
    super(message);
    this.name = "ExamSheetSaveDisposedError";
  }
}

const DEBOUNCE_MS = 800;
const BACKOFF_MS = [1000, 2000, 4000] as const; // 退避 1/2/4 秒，共 3 次自动重试
const MAX_AUTO_RETRIES = BACKOFF_MS.length;
/** 单批题目键上限（对齐 PATCH answers ≤200 的服务端口径）。 */
const MAX_BATCH_KEYS = 200;

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

interface FlushWaiter {
  targetSeq: number;
  resolve: (receipt: ExamSheetSaveFlushReceipt) => void;
  reject: (err: unknown) => void;
}

/** 逐题脏键：seq=本地输入序号；answer=编辑时刻的快照（与调用方对象脱钩）。 */
interface DirtyEntry {
  seq: number;
  answer: SheetAnswer | null;
}

function cloneAnswer(answer: SheetAnswer | null): SheetAnswer | null {
  return answer == null ? null : structuredClone(answer);
}

export function createExamSheetSaveController(
  options: CreateExamSheetSaveControllerOptions,
): ExamSheetSaveController {
  const {
    sheetId,
    draftVersion: initialDraftVersion,
    save,
    setTimer = defaultSetTimer,
    clearTimer = defaultClearTimer,
  } = options;

  void sheetId; // 由调用方 save 闭包携带，控制器层仅作契约标识

  let draftVersion: number | null = initialDraftVersion ?? null;
  let state: ExamSheetSaveState = "clean";
  let lastSavedAt: string | null = null;

  let inputSeq = 0; // 本地输入序号；每次 setAnswer 自增
  let committedSeq = 0; // 已确认（或已由后续编辑取代并确认）的最大输入序号
  let disposed = false;
  let frozen = false; // 题纸进入终态（sealed/discarded）
  let inFlight = false;

  // 逐题脏键真源（仅 setAnswer / adoptServerBaseline 修改；旧响应绝不回写）。
  const dirty = new Map<string, DirtyEntry>();

  let composing = false;
  let pendingAfterCompose = false;
  let debounceTimer: TimerHandle | null = null;

  let backoffTimer: TimerHandle | null = null;
  let backoffResolve: (() => void) | null = null;

  const listeners = new Set<() => void>();
  let waiters: FlushWaiter[] = [];

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function setState(next: ExamSheetSaveState): void {
    if (state !== next) state = next;
  }

  function getSnapshot(): ExamSheetSaveSnapshot {
    return { state, inFlight, lastSavedAt };
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
      if (waiter.targetSeq <= committedSeq) {
        waiter.resolve({ draftVersion: draftVersion as number, lastSavedAt });
      } else {
        remaining.push(waiter);
      }
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

  function scheduleAutosave(): void {
    if (frozen || disposed) return;
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
    if (inFlight || disposed || frozen) return;
    if (composing) {
      pendingAfterCompose = true;
      return;
    }
    if (state === "conflict") return; // 冲突停发：恢复动作是 adoptServerBaseline
    if (dirty.size === 0) {
      if (state !== "clean" && state !== "error") {
        setState("clean");
        notify();
      }
      return;
    }
    if (draftVersion === null) return; // 未装配：等 setDraftVersion 排出（不以 0 掩盖）
    // 立即发送前取消仍在排队的防抖 timer，避免之后重复触发
    if (debounceTimer !== null) {
      clearTimer(debounceTimer);
      debounceTimer = null;
    }
    void runPipeline();
  }

  /** 取下一批（≤200 键，按 seq 升序——低序号先发，不遗漏不抢先）。 */
  function takeBatch(): Array<[string, DirtyEntry]> | null {
    if (dirty.size === 0) return null;
    const sorted = [...dirty.entries()].sort((a, b) => a[1].seq - b[1].seq).slice(0, MAX_BATCH_KEYS);
    return sorted;
  }

  /** 冻结请求载荷：发送时刻复制值（之后本地/入参的任何改动不影响本请求）。 */
  function materializeBatch(batch: Array<[string, DirtyEntry]>): Record<string, SheetAnswer | null> {
    const answers: Record<string, SheetAnswer | null> = {};
    for (const [id, entry] of batch) answers[id] = cloneAnswer(entry.answer);
    return answers;
  }

  async function runPipeline(): Promise<void> {
    if (inFlight || disposed || frozen) return;
    inFlight = true;
    try {
      while (!disposed && !frozen) {
        if (draftVersion === null) break; // 未装配：等待 setDraftVersion
        const batch = takeBatch();
        if (!batch) break;

        // 冻结本批请求：同一批的自动重试沿用同一载荷与版本（V2 合同——重试期间
        // 新编辑留到下一批，不混入重试，也不改动 expectedVersion）。
        const request: ExamSheetSaveControllerSaveInput = {
          answers: materializeBatch(batch),
          expectedVersion: draftVersion,
        };

        let retryCount = 0;
        let settled = false;
        while (!settled) {
          if (disposed || frozen) return;
          setState("saving");
          notify();
          try {
            const result = await save(request);
            if (disposed) return;
            draftVersion = result.draftVersion;
            lastSavedAt = new Date().toISOString();
            // 仅清除「仍是同一发送序号」的键：在途再编辑的题（新 seq）必留下发下一批。
            let maxCleared = 0;
            for (const [id, entry] of batch) {
              const current = dirty.get(id);
              if (current && current.seq === entry.seq) {
                dirty.delete(id);
                if (entry.seq > maxCleared) maxCleared = entry.seq;
              }
            }
            if (maxCleared > committedSeq) committedSeq = maxCleared;
            settled = true;
          } catch (err) {
            if (disposed) return;
            const status = errorStatus(err);
            if (isConflictStatus(status)) {
              setState("conflict");
              notify();
              rejectWaiters(new ExamSheetSaveConflictError(err instanceof Error ? err.message : "sheet conflict"));
              return;
            }
            const retryable = isRetryableStatus(status);
            if (retryable && retryCount < MAX_AUTO_RETRIES) {
              retryCount += 1;
              setState("retrying");
              notify();
              await delayTimer(BACKOFF_MS[retryCount - 1]);
              continue; // 同一 request 重发（载荷+版本冻结）
            }
            // 不可重试，或自动重试耗尽：落到 error（保留本地答案，不回写）。
            setState("error");
            notify();
            rejectWaiters(err instanceof Error ? err : new Error("题纸保存失败"));
            return;
          }
        }
      }
      if (!disposed && !frozen) {
        setState("clean");
      }
    } finally {
      inFlight = false;
      if (!disposed) {
        // S 订阅合同：终态帧必须反映 inFlight 已释放——clean/error/conflict 的
        // 最终快照不得被在途帧掩蔽；dispose 后不再发任何通知。
        if (state === "clean" && !frozen) resolveEligibleWaiters();
        notify();
        // 重入排出：订阅者在完成通知里再次 setAnswer+flush 时，新输入不能永远
        // 等待防抖——释放 inFlight 后立即排出；error/conflict 不自动重发。
        if (!frozen && state !== "error" && state !== "conflict" && !composing
          && draftVersion !== null && dirty.size > 0) {
          maybeSend();
        }
      }
    }
  }

  function setAnswer(questionId: string, answer: SheetAnswer | null): void {
    if (disposed || frozen) return;
    inputSeq += 1;
    dirty.set(questionId, { seq: inputSeq, answer: cloneAnswer(answer) });
    if (state !== "conflict") {
      // 409 后不得仅因新编辑恢复自动写（Q 合同）：保留 conflict，等明确载入服务器版本。
      setState("dirty");
      scheduleAutosave();
    }
    notify();
  }

  function setComposing(value: boolean): void {
    if (disposed) return;
    if (value === composing) return;
    composing = value;
    if (!composing) {
      pendingAfterCompose = false;
      if (dirty.size > 0) scheduleAutosave();
    }
  }

  function flush(): Promise<ExamSheetSaveFlushReceipt> {
    if (disposed) return Promise.reject(new ExamSheetSaveDisposedError());
    if (state === "conflict") {
      return Promise.reject(new ExamSheetSaveConflictError());
    }
    if (state === "error") {
      return Promise.reject(new Error("题纸保存失败，无法确认"));
    }
    if (draftVersion === null) {
      // 先装配才允许定格/导出（Q 合同）：不以 0 掩盖漏装配。
      return Promise.reject(new Error("题纸版本基线尚未装配，无法确认保存状态"));
    }
    const targetSeq = inputSeq;
    if (targetSeq <= committedSeq && !inFlight) {
      return Promise.resolve({ draftVersion, lastSavedAt });
    }
    // 先登记等待者再启动管道：即便 save 立即 settle，也不遗漏本等待者（S 重入合同）。
    const promise = new Promise<ExamSheetSaveFlushReceipt>((resolve, reject) => {
      waiters.push({ targetSeq, resolve, reject });
    });
    maybeSend();
    return promise;
  }

  function retry(): Promise<void> {
    if (disposed) return Promise.reject(new ExamSheetSaveDisposedError());
    if (frozen) return Promise.resolve();
    if (state === "conflict") {
      // 版本冲突盲试无意义：明确载入服务器版本（adoptServerBaseline）才重建基线。
      return Promise.reject(new ExamSheetSaveConflictError(
        "冲突需明确载入服务器版本后重建编辑基线，重试不会自行解决",
      ));
    }
    setState("dirty");
    maybeSend();
    // 复用 flush 的等待机制；retry 本身只关心成败。
    return flush().then(() => undefined);
  }

  function setDraftVersion(version: number): void {
    if (disposed) return;
    draftVersion = version;
    if (!frozen) maybeSend(); // 装配完成后排出装配前积累的输入
  }

  function adoptServerBaseline(version: number): void {
    if (disposed) return;
    // 明确恢复动作（Q6）：放弃本地未确认输入、接受服务器基线——此后必须重新
    // 显式编辑才会再发送；绝不 GET 新版后静默套用旧输入。
    draftVersion = version;
    dirty.clear();
    committedSeq = inputSeq;
    if (state !== "clean") {
      setState("clean");
    }
    notify();
  }

  function freeze(): void {
    frozen = true;
    if (debounceTimer !== null) {
      clearTimer(debounceTimer);
      debounceTimer = null;
    }
  }

  function isDisposed(): boolean {
    return disposed;
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
    rejectWaiters(new ExamSheetSaveDisposedError());
  }

  return {
    setAnswer,
    setComposing,
    flush,
    retry,
    setDraftVersion,
    adoptServerBaseline,
    freeze,
    isDisposed,
    getSnapshot,
    subscribe,
    dispose,
  };
}
