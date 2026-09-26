/**
 * 学习笔记可靠保存控制器（Task 07）——完整快照、单在途、A/B 交错、冲突停写。
 *
 * 职责（与 `writingSaveController.ts` 同一协议经验，但不抽象重写既有控制器）：
 *  - 编辑载荷 T = {title, bodyMd, venues, pinned, status, references}（完整状态快照；
 *    正文/归属/置顶/归档**只经这一条保存通道**，不存在逐字段独立 PUT）；
 *  - 同一时刻至多一个 PUT 在途；edit 只覆盖「待发送快照」并推进 editSeq；
 *    发送时冻结 payload/requestId/expectedVersion（调用方后续修改原对象不影响发送）；
 *  - 响应只确认其「发送序号」：旧响应不覆盖之后的本地输入、不把新输入标为已保存；
 *  - 失败按「服务端确定拒绝 / 结果不明 / 身份失败」分流（R1 补修）：
 *    · rejected（可信业务拒绝：400/404/422 等，本次尝试未提交）→ **不保留**旧载荷的
 *      原样重试权；用户修正后显式 retry 以「最新完整快照 + 新 requestId + 最近已确认
 *      expectedVersion」提交（旧载荷已不可成功，禁止永久保留）；
 *    · unknown（断网/超时/5xx 耗尽/429 耗尽/成功响应格式非法）→ **保留**原 payload/
 *      requestId/expectedVersion，自动退避 1/2/4s 至多 3 次，耗尽后显式 retry 原样重发
 *      （服务端幂等去重；重放遇到他端新写入的 409 属正常冲突路径）；
 *    · auth（401/403）→ 不盲重试、保留未确认请求（身份恢复语义，UI 给登录恢复引导）；
 *    · 409 → 立即停止自动写进入 conflict（保留本地输入）；**不猜测服务器版本继续覆盖**；
 *  - error 态快照携带 errorKind（rejected/unknown/auth）与可读 lastErrorMessage，
 *    面板据此给出正确恢复指引（不把确定拒绝一律写成「网络或服务异常」）；
 *  - flush() 等待「调用时刻 editSeq」被确认才 resolve；失败/冲突/dispose 一律 reject，
 *    不留永远 pending；回执 {version, editSeq, lastSavedAt}，lastSavedAt 来自成功 DTO.updatedAt；
 *  - 订阅在「释放 inFlight 后」的稳定终态帧必发；dispose 后不再通知，旧回包被丢弃；
 *    **不承诺 dispose/abort 可撤销服务端提交**（响应丢失的请求可能已提交）。
 *
 * 控制器自身不发网络请求（save 由调用方注入）；不读 React/DOM/localStorage。
 */
import type {
  ReferencePreview,
  ReferenceTarget,
  ReferenceWrite,
  StudyNoteDto,
  StudyNoteStatus,
} from "@/domain/l3-study-notes";
import type { L3QuestionType } from "@/domain/l3-question-types";

// ── 状态与快照模型 ──────────────────────────────────────────────────────────

export type StudyNoteSaveState = "idle" | "dirty" | "saving" | "retrying" | "error" | "conflict" | "invalid";

/**
 * error 态失败分类（R1）：
 * - `rejected`：服务端确定拒绝本次写入（可信业务 4xx，本次尝试未提交）→ 修正后重试最新快照；
 * - `unknown`：提交结果不明（网络/超时/5xx/429/成功响应格式非法）→ 原样重试（幂等语义）；
 * - `auth`：身份/权限失败（401/403）→ 保留请求，待身份恢复后重试。
 */
export type StudyNoteSaveErrorKind = "rejected" | "unknown" | "auth";

/** precheck 结果：ok=false 时阻止发送（不 PUT），reason 供 UI 展示恢复指引。 */
export type StudyNoteSavePrecheckResult = { ok: true } | { ok: false; reason: string };

/** 编辑载荷（SaveNoteInput 去掉 expectedVersion/requestId）。 */
export interface StudyNoteEditSnapshot {
  title: string;
  bodyMd: string;
  venues: L3QuestionType[];
  pinned: boolean;
  status: StudyNoteStatus;
  references: ReferenceWrite[];
}

export interface StudyNoteSaveSnapshot {
  noteId: string;
  state: StudyNoteSaveState;
  inFlight: boolean;
  editSeq: number;
  savedSeq: number;
  /** 最近服务端确认版本。 */
  version: number;
  /** 来自真实确认（成功 DTO.updatedAt）；基线的初始值可来自 GET 已保存版本。 */
  lastSavedAt: string | null;
  /** 仅 conflict 态非 null；409 未携带 currentVersion 时为 null（不猜数值）。 */
  conflictCurrentVersion: number | null;
  /**
   * 仅 error 态非 null：失败分类（rejected/unknown/auth）。
   * UI 据此给出正确恢复指引（rejected=修正后重试；unknown=原样重试；auth=重新登录）。
   */
  errorKind: StudyNoteSaveErrorKind | null;
  /** 仅 error 态非 null：可读错误消息（服务端 message 优先；技术性兜底不展示）。 */
  lastErrorMessage: string | null;
  /** 仅 invalid 态非 null：保存前预检（marker 集合一致性）未通过的原因。 */
  invalidReason: string | null;
  /** 当前 IME 组合状态（导航守卫与状态呈现使用；组合中不发送新的编辑快照）。 */
  composing: boolean;
  /** 当前编辑快照（受控 UI 的渲染真源；含尚未确认的本地输入）。 */
  edit: StudyNoteEditSnapshot;
}

export interface StudyNoteFlushReceipt {
  /** 与实际确认快照绑定的版本（同一次确认；不是等待目标意义上的版本）。 */
  version: number;
  /**
   * **实际被确认的快照序号**（savedSeq，R5）——不混用「等待目标序号」；
   * 等待目标仅在内部作为 resolve 条件（waiter.targetSeq <= savedSeq）。
   */
  editSeq: number;
  /** 同一次确认的服务端时间（成功 DTO.updatedAt）。 */
  lastSavedAt: string | null;
}

export interface StudyNoteSaveRequest {
  noteId: string;
  requestId: string;
  expectedVersion: number;
  snapshot: StudyNoteEditSnapshot;
}

export interface StudyNoteSaveResult {
  /** 服务端确认后的版本。 */
  version: number;
  /** 服务端确认时间（DTO.updatedAt）——lastSavedAt 的唯一来源。 */
  updatedAt: string;
  /**
   * 服务端确认的引用元数据（成功 DTO.references，R2）——调用方据此把「已确认」的
   * 正式快照（displaySnapshot/capturedAt/status/liveTitle/target）回填到 UI。
   * 旧实现只回传 version/updatedAt，导致确认后的正式快照被丢弃、未确认预览冒充已保存内容。
   */
  references?: ReferencePreview[];
}

export interface CreateStudyNoteSaveControllerOptions {
  noteId: string;
  /** 基线版本（GET 已保存版本 / 新建回执）。 */
  version: number;
  /** 基线编辑快照（GET 已保存内容映射；references 一律 keep）。 */
  baseline: StudyNoteEditSnapshot;
  /** 基线时间（GET 已保存版本 updatedAt）——仅用于展示，不据此确认本地 dirty 内容。 */
  lastSavedAt?: string | null;
  save: (input: StudyNoteSaveRequest) => Promise<StudyNoteSaveResult>;
  /** 注入以便测试控制防抖与退避；默认 setTimeout/clearTimeout。 */
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 注入以便测试确定 requestId；默认 crypto.randomUUID()。 */
  generateRequestId?: () => string;
  /**
   * 保存前本地预检（每次发送前调用，含重试）：不通过则**阻止 PUT**进入 invalid，
   * 保留本地输入；内容修复（edit 后重检通过）自动回到 dirty。不做自动修正。
   */
  precheck?: (snapshot: StudyNoteEditSnapshot) => StudyNoteSavePrecheckResult;
  /**
   * 每次「真实成功确认」后回调（R1/R2）：载荷为**本次被确认的冻结快照**与**该次确认
   * 携带的服务端引用元数据**。调用方据此把已确认的 capture 转为 keep、并按引用身份
   * 回填正式快照。仅在服务端确认成功后触发——未知结果/重试/409/401 一律不触发。
   */
  onConfirmed?: (confirmed: StudyNoteConfirmedSnapshot) => void;
}

/** 一次真实成功确认的内容（成功 DTO + 被确认的冻结快照）。 */
export interface StudyNoteConfirmedSnapshot {
  /** 被确认的载荷（发送时冻结；与本次 PUT 逐字节一致）。 */
  snapshot: StudyNoteEditSnapshot;
  /** 确认版本（DTO.version）。 */
  version: number;
  /** 确认时间（DTO.updatedAt）。 */
  updatedAt: string;
  /** 确认引用的正式元数据（DTO.references；缺失时为空数组——调用方不得据此删除本地引用）。 */
  references: ReferencePreview[];
}

export interface StudyNoteSaveController {
  /** 每次输入变更，覆盖待发送快照并推进 editSeq（无变化时不推进、不发送）。 */
  edit(snapshot: StudyNoteEditSnapshot): void;
  /**
   * 把「本次服务端确认过的 capture」在**本地待发送快照**里标记为 confirmed id
   * （R1）——这些引用已落库，不再需要 capture。**不推进 editSeq、不调度发送**：
   * 服务端内容已经正确，无需为「本地簿记」多打一次 PUT。
   *
   * 仅对 `ids` 中列出的、且当前仍为 capture 的引用生效；已移除/未确认的引用不受影响。
   * 若本地已有更新的编辑（editSeq > savedSeq）仍照常发送，只把动作改为 keep。
   */
  markConfirmed(ids: readonly string[]): void;
  /** IME 合成标记：composing 期间不发送；compositionend 后按防抖补发。 */
  setComposing(value: boolean): void;
  /**
   * 等待「调用时刻 editSeq（目标）」被确认覆盖后 resolve（R5）：
   * 回执 editSeq=**实际确认的快照序号**（savedSeq），version/lastSavedAt 与同一次确认绑定；
   * 失败/冲突/dispose 一律 reject，不留永远 pending。
   */
  flush(): Promise<StudyNoteFlushReceipt>;
  /**
   * 显式重试：error 态继续**同一未确认请求**（同 payload/requestId/expectedVersion）；
   * conflict 态 reject（须先复制本地内容或载入服务器版本，见任务书 §2.4）。
   */
  retry(): Promise<void>;
  /** 冲突恢复唯一入口：以服务器快照（显式载入结果）重建编辑基线。 */
  adoptServerSnapshot(dto: StudyNoteDto): void;
  getSnapshot(): StudyNoteSaveSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
  isDisposed(): boolean;
}

// ── 错误 ────────────────────────────────────────────────────────────────────

/** 版本冲突（409）：停止自动写，保留本地输入，等待用户显式处理。 */
export class StudyNoteConflictError extends Error {
  readonly currentVersion: number | null;

  constructor(message = "笔记已被其他窗口更新，需显式处理冲突", currentVersion: number | null = null) {
    super(message);
    this.name = "StudyNoteConflictError";
    this.currentVersion = currentVersion;
  }
}

/** 保存前预检未通过（如引用标记与引用清单不一致）：阻止 PUT，需修复内容。 */
export class StudyNotePrecheckError extends Error {
  constructor(message = "内容未通过保存前预检") {
    super(message);
    this.name = "StudyNotePrecheckError";
  }
}

/** 保存失败（自动重试耗尽或确定性失败）；cause 保留原始错误。 */
export class StudyNoteSaveFailedError extends Error {
  readonly cause?: unknown;

  constructor(message = "笔记保存失败", cause?: unknown) {
    super(message);
    this.name = "StudyNoteSaveFailedError";
    this.cause = cause;
  }
}

/** 控制器已被 dispose，无法再保存/等待。 */
export class StudyNoteDisposedError extends Error {
  constructor(message = "保存控制器已释放") {
    super(message);
    this.name = "StudyNoteDisposedError";
  }
}

// ── 常量 ────────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 800;
/** 退避 1/2/4 秒，共 3 次自动重试（结果不明的请求原样重发）。 */
const BACKOFF_MS = [1000, 2000, 4000] as const;
const MAX_AUTO_RETRIES = BACKOFF_MS.length;

// ── 工具 ────────────────────────────────────────────────────────────────────

type TimerHandle = unknown;

function defaultSetTimer(fn: () => void, delayMs: number): unknown {
  return setTimeout(fn, delayMs);
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function errorStatus(err: unknown): number | null {
  if (err && typeof err === "object") {
    const candidate = (err as { status?: unknown }).status;
    if (typeof candidate === "number") return candidate;
  }
  return null;
}

/** 结果不明：无 status（网络错误）或 0（超时 BrowserApiError）。 */
function isUnknownResultError(err: unknown): boolean {
  const status = errorStatus(err);
  return status === null || status === 0;
}

function isRetryableStatus(status: number | null): boolean {
  if (status === null || status === 0) return true;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isConflictStatus(status: number | null): boolean {
  return status === 409;
}

/** INVALID_RESPONSE：服务端 2xx 但成功响应与契约不符 → 提交结果不明（可能已提交）。 */
function isInvalidResponseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { code?: unknown }).code === "INVALID_RESPONSE";
}

/**
 * 「服务端确定拒绝本次写入」判定（R1）：
 * 可信业务 4xx（400/404/422 等，且本次尝试确定未提交）→ 清除旧载荷原样重试权；
 * 其余（结果不明/身份/暂态）不在此列：
 * - 网络/超时（无 status）→ unknown；
 * - 5xx/429/408/425（自动重试仍耗尽）→ unknown（保留原样重试）；
 * - INVALID_RESPONSE（2xx 响应非法，可能已提交）→ unknown（保守）；
 * - 401/403 → auth（身份恢复语义，同样保留未确认请求，UI 单独引导）。
 */
function classifyConfirmedRejection(error: unknown): "rejected" | "unknown" | "auth" {
  if (isInvalidResponseError(error)) return "unknown";
  const status = errorStatus(error);
  if (status === null || status === 0 || status >= 500) return "unknown";
  if (status === 408 || status === 425 || status === 429) return "unknown";
  if (status === 401 || status === 403) return "auth";
  return "rejected";
}

/** 可读错误消息：服务端 message 优先；技术性兜底（Request failed with status N）不展示。 */
function extractErrorMessage(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (!trimmed) return null;
  if (/^Request failed with status \d+$/i.test(trimmed)) return null;
  return trimmed;
}

/** 409 的 meta.currentVersion（details.currentVersion）；缺失/非数字时 null（不猜）。 */
function extractCurrentVersion(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const details = (err as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const value = (details as Record<string, unknown>).currentVersion;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** 429 Retry-After（秒或 HTTP-date）→ 毫秒；缺失/非法时 null。 */
function retryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const headers = (err as { headers?: Headers }).headers;
  if (!headers || typeof headers.get !== "function") return null;
  const raw = headers.get("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function cloneTarget(target: ReferenceTarget): ReferenceTarget {
  switch (target.kind) {
    case "source":
      return { kind: "source", sourceId: target.sourceId };
    case "source_quote":
      return {
        kind: "source_quote",
        sourceId: target.sourceId,
        start: target.start,
        end: target.end,
        quote: target.quote,
      };
    case "question":
      return { kind: "question", questionId: target.questionId };
    case "stem_quote":
      return {
        kind: "stem_quote",
        questionId: target.questionId,
        start: target.start,
        end: target.end,
        quote: target.quote,
      };
    case "option_quote":
      return {
        kind: "option_quote",
        questionId: target.questionId,
        optionKey: target.optionKey,
        start: target.start,
        end: target.end,
        quote: target.quote,
      };
    case "assessment":
      return {
        kind: "assessment",
        questionId: target.questionId,
        assessmentId: target.assessmentId,
      };
    case "note":
      return { kind: "note", noteId: target.noteId };
    // N2 第三条链：仅做载荷克隆（本链不新增前端出口，见任务书 §3.3 R-2）。
    case "sheet":
      return { kind: "sheet", submissionId: target.submissionId, revisionNo: target.revisionNo ?? null };
    case "attempt":
      return { kind: "attempt", attemptId: target.attemptId };
    // N2 第四条链（ADR-0039 决策 2）：身份 = {sheetId, questionId}，无版本维度。
    case "grading":
      return { kind: "grading", sheetId: target.sheetId, questionId: target.questionId };
  }
}

/** 深拷贝（冻结）编辑快照：调用方后续修改原对象不影响发送。 */
function freezeSnapshot(source: StudyNoteEditSnapshot): StudyNoteEditSnapshot {
  return {
    title: source.title,
    bodyMd: source.bodyMd,
    venues: [...source.venues],
    pinned: source.pinned,
    status: source.status,
    references: source.references.map((ref) =>
      ref.action === "keep"
        ? { id: ref.id, action: "keep" as const }
        : { id: ref.id, action: "capture" as const, target: cloneTarget(ref.target) },
    ),
  };
}

function snapshotEquals(a: StudyNoteEditSnapshot, b: StudyNoteEditSnapshot): boolean {  if (a.title !== b.title || a.bodyMd !== b.bodyMd || a.pinned !== b.pinned || a.status !== b.status) {
    return false;
  }
  if (a.venues.length !== b.venues.length || a.venues.some((venue, index) => venue !== b.venues[index])) {
    return false;
  }
  if (a.references.length !== b.references.length) return false;
  for (let index = 0; index < a.references.length; index += 1) {
    const left = a.references[index]!;
    const right = b.references[index]!;
    if (left.id !== right.id || left.action !== right.action) return false;
    if (left.action === "capture" && right.action === "capture") {
      if (JSON.stringify(left.target) !== JSON.stringify(right.target)) return false;
    }
  }
  return true;
}

/** 交给 `onConfirmed` 的快照副本：调用方可能保留引用，故再克隆一层（防外部改动内部状态）。 */
function snapshotForCallback(source: StudyNoteEditSnapshot): StudyNoteEditSnapshot {
  return freezeSnapshot(source);
}

/** 服务器 DTO → 编辑快照（既有 references 一律 keep，不重 capture）。 */
function snapshotFromDto(dto: StudyNoteDto): StudyNoteEditSnapshot {
  return {
    title: dto.title,
    bodyMd: dto.bodyMd,
    venues: [...dto.venues],
    pinned: dto.pinned,
    status: dto.status,
    references: dto.references.map((reference) => ({ id: reference.id, action: "keep" as const })),
  };
}

// ── 控制器 ──────────────────────────────────────────────────────────────────

interface FlushWaiter {
  targetSeq: number;
  resolve: (receipt: StudyNoteFlushReceipt) => void;
  reject: (error: unknown) => void;
}

interface InFlightRequest {
  seq: number;
  requestId: string;
  expectedVersion: number;
  payload: StudyNoteEditSnapshot;
}

type SendOutcome =
  | { kind: "success"; version: number; updatedAt: string; references: ReferencePreview[] }
  | { kind: "conflict"; currentVersion: number | null }
  /** 服务端确定拒绝本次写入（可信业务 4xx，本次未提交）：不保留旧载荷原样重试权。 */
  | { kind: "rejected"; error: unknown }
  /** 结果不明（网络/超时/5xx/429/成功响应格式非法）：保留未确认请求，原样重试。 */
  | { kind: "unknown"; error: unknown }
  /** 身份/权限失败（401/403）：不盲重试、保留未确认请求（身份恢复语义）。 */
  | { kind: "auth"; error: unknown }
  | { kind: "aborted" };

export function createStudyNoteSaveController(
  options: CreateStudyNoteSaveControllerOptions,
): StudyNoteSaveController {
  const {
    noteId,
    baseline,
    save,
    precheck,
    onConfirmed,
    setTimer = defaultSetTimer,
    clearTimer = defaultClearTimer,
    generateRequestId = () => crypto.randomUUID(),
  } = options;

  let version = options.version;
  let lastSavedAt: string | null = options.lastSavedAt ?? null;
  let editSnapshot = freezeSnapshot(baseline);
  let state: StudyNoteSaveState = "idle";

  let editSeq = 0;
  let savedSeq = 0;
  let inFlight = false;
  let disposed = false;

  /** 结果不明的未确认请求（error 态保留；retry 原样重发）。仅 unknown/auth 类保留。 */
  let unconfirmed: InFlightRequest | null = null;
  let lastError: unknown = null;
  let errorKind: StudyNoteSaveErrorKind | null = null;
  let lastErrorMessage: string | null = null;
  let conflictCurrentVersion: number | null = null;
  let invalidReason: string | null = null;
  /** 代际：adopt 之外的旧回包丢弃依据（防污染新基线）。 */
  let epoch = 0;

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

  function setState(next: StudyNoteSaveState): void {
    state = next;
  }

  function getSnapshot(): StudyNoteSaveSnapshot {
    return {
      noteId,
      state,
      inFlight,
      editSeq,
      savedSeq,
      version,
      lastSavedAt,
      conflictCurrentVersion,
      errorKind,
      lastErrorMessage,
      invalidReason,
      composing,
      edit: freezeSnapshot(editSnapshot),
    };
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** 结算「目标序号已被确认」的等待者（R5）——回执 editSeq=**实际确认的快照序号**（savedSeq），
   *  version/lastSavedAt 来自同一次确认（调用点均在「确认已生效」之后）。 */
  function resolveEligibleWaiters(): void {
    if (waiters.length === 0) return;
    const remaining: FlushWaiter[] = [];
    for (const waiter of waiters) {
      if (waiter.targetSeq <= savedSeq) {
        waiter.resolve({ version, editSeq: savedSeq, lastSavedAt });
      } else {
        remaining.push(waiter);
      }
    }
    waiters = remaining;
  }

  function rejectWaiters(error: unknown): void {
    const current = waiters;
    waiters = [];
    for (const waiter of current) waiter.reject(error);
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

  /** 退避时长：429 尊重 Retry-After；否则 1/2/4s（attempt 从 1 起）。 */
  function retryDelayFor(error: unknown, attempt: number): number {
    const after = retryAfterMs(error);
    if (after !== null) return after;
    return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1]!;
  }

  /** 发送一个请求（含自动重试）；request 对象自创建后不被修改（冻结重发语义）。 */
  async function sendWithRetries(request: InFlightRequest, myEpoch: number): Promise<SendOutcome> {
    let retryCount = 0;
    for (;;) {
      try {
        const result = await save({
          noteId,
          requestId: request.requestId,
          expectedVersion: request.expectedVersion,
          snapshot: request.payload,
        });
        if (disposed || myEpoch !== epoch) return { kind: "aborted" };
        return {
          kind: "success",
          version: result.version,
          updatedAt: result.updatedAt,
          references: result.references ?? [],
        };
      } catch (error) {
        if (disposed || myEpoch !== epoch) return { kind: "aborted" };
        const status = errorStatus(error);
        if (isConflictStatus(status)) {
          return { kind: "conflict", currentVersion: extractCurrentVersion(error) };
        }
        if (!isRetryableStatus(status)) {
          // 确定失败（400/404/422…）或 2xx 响应非法（INVALID_RESPONSE）→ 先分类，不盲重试
          const kind = classifyConfirmedRejection(error);
          if (kind === "rejected") return { kind, error };
          if (kind === "auth") return { kind, error };
          return { kind: "unknown", error };
        }
        if (retryCount >= MAX_AUTO_RETRIES) {
          // 自动重试耗尽：结果不明，保持「未确认请求」，等待显式 retry 原样重发
          return { kind: "unknown", error };
        }
        retryCount += 1;
        setState("retrying");
        notify();
        await delayTimer(retryDelayFor(error, retryCount));
        if (disposed || myEpoch !== epoch) return { kind: "aborted" };
        // 继续循环：原样重发（同 payload/requestId/expectedVersion）
      }
    }
  }

  async function runPipeline(): Promise<void> {
    if (inFlight || disposed) return;
    inFlight = true;
    const myEpoch = epoch;
    try {
      while (!disposed && myEpoch === epoch) {
        let request: InFlightRequest;
        if (unconfirmed) {
          request = unconfirmed; // 显式 retry：继续同一未确认请求（冻结载荷，与组合无关）
        } else if (editSeq > savedSeq) {
          if (composing) {
            // R2：新的编辑快照可能处于输入法组合中（不完整）——停止管道，
            // 等 compositionend 后的防抖补发（setComposing(false) → scheduleAutosave）。
            break;
          }
          request = {
            seq: editSeq,
            requestId: generateRequestId(),
            expectedVersion: version,
            payload: freezeSnapshot(editSnapshot), // 发送时刻冻结
          };
        } else {
          break; // 没有待发送内容
        }
        // 发送前本地预检（每次发送前，含重试）：不通过则阻止 PUT，进入 invalid。
        const check = precheck ? precheck(request.payload) : ({ ok: true } as const);
        if (!check.ok) {
          unconfirmed = null; // 不为未通过预检的载荷保留重试权（等修复后的新编辑）
          invalidReason = check.reason;
          errorKind = null;
          lastErrorMessage = null;
          setState("invalid");
          rejectWaiters(new StudyNotePrecheckError(check.reason));
          notify();
          return;
        }

        setState("saving");
        notify();

        const outcome = await sendWithRetries(request, myEpoch);
        if (outcome.kind === "aborted") return;

        if (outcome.kind === "success") {
          unconfirmed = null;
          lastError = null;
          errorKind = null;
          lastErrorMessage = null;
          savedSeq = request.seq;
          version = outcome.version;
          lastSavedAt = outcome.updatedAt;
          // R1/R2：先让调用方消费本次确认（capture → keep、回填正式快照），再结算 waiter。
          // 回调内若产生编辑，editSeq > savedSeq，flush 循环会继续为最新内容收尾。
          if (onConfirmed) {
            onConfirmed({
              snapshot: snapshotForCallback(request.payload),
              version: outcome.version,
              updatedAt: outcome.updatedAt,
              references: outcome.references,
            });
          }
          // 立刻结算 eligible waiters：回执与「该序号确认时」的 version 绑定
          resolveEligibleWaiters();
          continue;
        }

        if (outcome.kind === "conflict") {
          unconfirmed = null;
          conflictCurrentVersion = outcome.currentVersion;
          setState("conflict");
          rejectWaiters(new StudyNoteConflictError(undefined, outcome.currentVersion));
          return;
        }

        // rejected/unknown/auth（R1 分流）：
        // rejected=服务端确定拒绝 → 清除旧载荷原样重试权（修正后以最新快照重发）；
        // unknown/auth → 保留未确认请求，显式 retry 原样重发（幂等 / 身份恢复）。
        if (outcome.kind === "rejected") {
          unconfirmed = null;
        } else {
          unconfirmed = request;
        }
        lastError = outcome.error;
        errorKind = outcome.kind;
        lastErrorMessage = extractErrorMessage(outcome.error);
        setState("error");
        rejectWaiters(outcome.error instanceof Error ? outcome.error : new StudyNoteSaveFailedError());
        return;
      }
    } finally {
      inFlight = false;
      if (!disposed && myEpoch === epoch) {
        if (state === "saving" || state === "retrying") {
          setState(editSeq > savedSeq ? "dirty" : "idle");
        }
        if (state === "idle") resolveEligibleWaiters();
        notify();
        // 重入排出：订阅者在完成通知里再次 edit+flush 时，新输入不能永远等防抖。
        if (
          state !== "error" &&
          state !== "conflict" &&
          state !== "invalid" &&
          !composing &&
          (unconfirmed !== null || editSeq > savedSeq)
        ) {
          pump();
        }
      }
    }
  }

  function pump(): void {
    if (inFlight || disposed) return;
    if (composing) {
      pendingAfterCompose = true;
      return;
    }
    if (state === "error" || state === "conflict" || state === "invalid") return; // 不自动发送，等显式动作
    if (!unconfirmed && editSeq === savedSeq) {
      if (state !== "idle") {
        setState("idle");
        notify();
      }
      return;
    }
    if (debounceTimer !== null) {
      clearTimer(debounceTimer);
      debounceTimer = null;
    }
    void runPipeline();
  }

  function scheduleAutosave(): void {
    if (debounceTimer !== null) clearTimer(debounceTimer);
    debounceTimer = setTimer(() => {
      debounceTimer = null;
      if (composing) {
        pendingAfterCompose = true;
        return;
      }
      pump();
    }, DEBOUNCE_MS);
  }

  function edit(next: StudyNoteEditSnapshot): void {
    if (disposed) return;
    const frozen = freezeSnapshot(next);
    if (snapshotEquals(frozen, editSnapshot)) return; // 无变化：不推进序号、不调度
    editSnapshot = frozen;
    editSeq += 1;
    if (state === "conflict" || state === "error") {
      // 冲突/失败期间：保留输入，不自动写（等显式载入/重试）
      notify();
      return;
    }
    if (state === "invalid") {
      // 预检阻止后：内容修复（重检通过）自动回到 dirty；未修复保持 invalid。
      const check = precheck ? precheck(frozen) : ({ ok: true } as const);
      if (check.ok) {
        invalidReason = null;
        setState("dirty");
        scheduleAutosave();
      } else {
        invalidReason = check.reason;
      }
      notify();
      return;
    }
    if (inFlight) {
      // 在途时只更新「待发送快照」；发送循环/重入排出会续发最新内容。
      notify();
      return;
    }
    setState("dirty");
    scheduleAutosave();
    // 本地输入必须立刻通知订阅者（受控组件回滚防护，与 writingSaveController 同因）。
    notify();
  }

  /**
   * 本地簿记：把已确认的 capture 标记为 keep。**不推进 editSeq、不触发新 PUT**
   * （服务端已持有正确内容；这只是让后续载荷不再重复采集）。
   */
  function markConfirmed(ids: readonly string[]): void {
    if (disposed || ids.length === 0) return;
    const target = new Set(ids.map((id) => id.toLowerCase()));
    let changed = false;
    const nextReferences = editSnapshot.references.map((write) => {
      if (write.action !== "capture" || !target.has(write.id.toLowerCase())) return write;
      changed = true;
      return { id: write.id, action: "keep" as const };
    });
    if (!changed) return;
    editSnapshot = { ...editSnapshot, references: nextReferences };
    notify();
  }

  function setComposing(value: boolean): void {
    if (disposed) return;
    if (value === composing) return;
    composing = value;
    if (!composing) {
      // compositionend 后按防抖补发（若仍有未保存内容且非 error/conflict）
      pendingAfterCompose = false;
      if (editSeq !== savedSeq && state !== "error" && state !== "conflict") {
        scheduleAutosave();
      }
    }
  }

  function flush(): Promise<StudyNoteFlushReceipt> {
    if (disposed) return Promise.reject(new StudyNoteDisposedError());
    if (state === "conflict") {
      return Promise.reject(
        new StudyNoteConflictError("当前为冲突状态，请先复制本地内容或载入服务器版本", conflictCurrentVersion),
      );
    }
    if (state === "error") {
      return Promise.reject(new StudyNoteSaveFailedError("上次保存失败，请先重试", lastError));
    }
    if (state === "invalid") {
      return Promise.reject(new StudyNotePrecheckError(invalidReason ?? undefined));
    }
    const targetSeq = editSeq;
    if (targetSeq <= savedSeq && !inFlight && unconfirmed === null) {
      // 已有确认：立即 resolve，回执指向实际确认序号（R5）
      return Promise.resolve({ version, editSeq: savedSeq, lastSavedAt });
    }
    // 先登记等待者再启动管道：即便 save 立即 settle，也不遗漏本等待者。
    const promise = new Promise<StudyNoteFlushReceipt>((resolve, reject) => {
      waiters.push({ targetSeq, resolve, reject });
    });
    pump();
    return promise;
  }

  function retry(): Promise<void> {
    if (disposed) return Promise.reject(new StudyNoteDisposedError());
    if (state === "conflict") {
      return Promise.reject(
        new StudyNoteConflictError("冲突状态不能自动重试：请先载入服务器版本", conflictCurrentVersion),
      );
    }
    if (state === "invalid") {
      return Promise.reject(new StudyNotePrecheckError(invalidReason ?? undefined));
    }
    // error 态：保留的未确认请求将被原样重发（unconfirmed !== null）；
    // 无未确认请求（异常路径）时按 dirty 处理，推进待发送快照。
    setState("dirty");
    pump();
    return flush().then(() => undefined);
  }

  function adoptServerSnapshot(dto: StudyNoteDto): void {
    if (disposed) return;
    if (dto.id !== noteId) return; // 身份检查：拒绝非本笔记快照（防御性）
    epoch += 1; // 旧代际回包全部作废
    editSnapshot = snapshotFromDto(dto);
    editSeq += 1;
    savedSeq = editSeq;
    version = dto.version;
    lastSavedAt = dto.updatedAt;
    unconfirmed = null;
    lastError = null;
    errorKind = null;
    lastErrorMessage = null;
    conflictCurrentVersion = null;
    invalidReason = null;
    if (debounceTimer !== null) {
      clearTimer(debounceTimer);
      debounceTimer = null;
    }
    setState("idle");
    notify();
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
    rejectWaiters(new StudyNoteDisposedError());
  }

  return {
    edit,
    markConfirmed,
    setComposing,
    flush,
    retry,
    adoptServerSnapshot,
    getSnapshot,
    subscribe,
    dispose,
    isDisposed: () => disposed,
  };
}
