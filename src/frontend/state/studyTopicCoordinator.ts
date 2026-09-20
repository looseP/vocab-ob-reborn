/**
 * 学习笔记专题协调器（Task 08）——专题元数据与成员的串行写通道（纯 TS，不读 React/DOM）。
 *
 * 纪律（§3.4）：
 *  - 同一时刻**至多一个写操作在途**（串行队列；跨专题亦串行，天然满足「同专题至多一个」）；
 *  - `expectedVersion` 在**执行时**读取「本地最近服务端版本」；每个响应即更新本地记录
 *    （版本一律来自服务端返回，不在前端推测顺序或版本）；
 *  - 409 → 停止自动写（本协调器从不自动重试）+ 标记冲突；显式刷新（load/refresh）前，
 *    该专题的后续写操作被拒绝（`StudyTopicWriteConflictError`，不发请求）；
 *  - 创建：requestId 在同一标题的重试间复用；双击守卫（在途时复用同一承诺）；
 *  - 成员加入/移动透传 `beforeNoteId`（null = 移到末尾）；移出不删除笔记（服务端保证）。
 */
import type { L3QuestionType } from "@/domain/l3-question-types";
import type { StudyTopicDto, StudyTopicStatus } from "@/domain/l3-study-notes";
import type { StudyNotesClient } from "@/frontend/api/studyNotesClient";

export class StudyTopicWriteConflictError extends Error {
  readonly topicId: string;

  constructor(topicId: string, message = "专题已被其他位置修改：请先刷新专题后重试。") {
    super(message);
    this.name = "StudyTopicWriteConflictError";
    this.topicId = topicId;
  }
}

export type StudyTopicsState = "idle" | "loading" | "ready" | "error";

export interface StudyTopicsSnapshot {
  topics: StudyTopicDto[];
  state: StudyTopicsState;
  error: string | null;
  /** 409 后需显式刷新才恢复写。 */
  conflictTopicId: string | null;
  createPending: boolean;
  createError: string | null;
  /** 当前在途写操作的 topicId（null = 无）。 */
  writePendingTopicId: string | null;
  /** 服务端过滤口径下的专题总数（R1 分页）。 */
  total: number;
  /** 服务端 nextCursor（null = 已取尽）。 */
  nextCursor: string | null;
  /** 专题续取在途（loadMore）。 */
  loadingMoreTopics: boolean;
}

export interface StudyTopicCoordinatorOptions {
  client: Pick<
    StudyNotesClient,
    "listTopics" | "createTopic" | "saveTopic" | "moveTopicMember" | "removeTopicMember"
  >;
  generateRequestId?: () => string;
}

export interface StudyTopicCoordinator {
  load(venue: L3QuestionType): Promise<void>;
  refresh(): Promise<void>;
  /** 续取专题下一页（R1：cursor 合同；取尽或未 ready 时为 no-op）。 */
  loadMore(): Promise<void>;
  createTopic(title: string): Promise<StudyTopicDto>;
  saveTopic(topicId: string, input: { title: string; status: StudyTopicStatus }): Promise<StudyTopicDto>;
  moveMember(topicId: string, noteId: string, beforeNoteId: string | null): Promise<StudyTopicDto>;
  removeMember(topicId: string, noteId: string): Promise<StudyTopicDto>;
  getSnapshot(): StudyTopicsSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
  isDisposed(): boolean;
}

function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (status === 409) return "已被其他位置修改：请刷新后重试。";
    if (status === 422) return "操作被拒绝（内容不合法或超出限制）。";
    if (status === 404) return "专题不存在或已被移除。";
  }
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.trim()) return message;
  return "操作失败，请重试。";
}

function isConflictError(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 409;
}

export function createStudyTopicCoordinator(options: StudyTopicCoordinatorOptions): StudyTopicCoordinator {
  const generateRequestId = options.generateRequestId ?? (() => crypto.randomUUID());

  let topics: StudyTopicDto[] = [];
  let state: StudyTopicsState = "idle";
  let error: string | null = null;
  let conflictTopicId: string | null = null;
  let createError: string | null = null;
  let writePendingTopicId: string | null = null;
  let venue: L3QuestionType | null = null;
  let total = 0;
  let nextCursor: string | null = null;
  let loadingMoreTopics = false;
  let pendingCreate: { requestId: string; title: string; venue: L3QuestionType } | null = null;
  /** 在途创建 flight（身份化记账：跨题型/跨标题不误复用、完成时只清自己）。 */
  let createFlight: { id: number; venue: L3QuestionType; promise: Promise<StudyTopicDto> } | null = null;
  let createKeySeq = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let loadSeq = 0;
  /** 在途 load 请求计数（F2a：用于在被写确认作废后判断是否仍有更新的请求接手结算）。 */
  let loadOutstanding = 0;
  /** 专题翻页代际：load(切题型/刷新) 推进后，在途续取回包整体丢弃（R1/R2）。 */
  let topicsPageSeq = 0;
  let disposed = false;
  const subscribers = new Set<() => void>();

  function notify(): void {
    for (const listener of [...subscribers]) listener();
  }

  function upsertTopic(item: StudyTopicDto): void {
    // F2b：venue 归属判定在推进读代际之前——旧题型的迟到写确认不得注入视图、
    // 也不得作废当前题型正在进行的有效读取。
    if (item.questionType !== venue) return;
    // R3：写确认即推进读代际——此前发起、仍在途的 load/refresh 回包整体失效，
    // 防止旧快照覆盖已确认的新版本；之后发起的新鲜刷新不受影响（仍采纳他端更高版本）。
    loadSeq += 1;
    const index = topics.findIndex((topic) => topic.id === item.id);
    if (index >= 0) {
      topics = topics.map((topic, i) => (i === index ? item : topic));
    } else {
      topics = [item, ...topics];
    }
    notify();
  }

  async function load(nextVenue: L3QuestionType): Promise<void> {
    if (disposed) return;
    venue = nextVenue;
    const seq = ++loadSeq;
    loadOutstanding += 1;
    topicsPageSeq += 1; // 切题型/刷新：失效在途专题续取（旧代回包不污染新列表）
    loadingMoreTopics = false; // F1：刷新/切题型取代翻页 → 终结旧翻页 pending（旧回包不得再动它）
    state = "loading";
    error = null;
    createError = null; // 切题型/刷新：旧视图的创建错误不带到新视图（R2）
    notify();
    try {
      const page = await options.client.listTopics({ venue: nextVenue });
      loadOutstanding -= 1;
      if (disposed || seq !== loadSeq) {
        settleSupersededLoad();
        return;
      }
      topics = page.items;
      total = page.total;
      nextCursor = page.nextCursor;
      // 显式刷新：若冲突专题出现在刷新结果中，视为已对齐，可恢复写
      if (conflictTopicId && topics.some((topic) => topic.id === conflictTopicId)) {
        conflictTopicId = null;
      }
      state = "ready";
    } catch (caught) {
      loadOutstanding -= 1;
      if (disposed || seq !== loadSeq) {
        settleSupersededLoad();
        return;
      }
      state = "error";
      error = describeError(caught);
    }
    notify();
  }

  /**
   * F2a：本读请求被写确认作废后，若没有更新的读请求接手（loadOutstanding===0），
   * 必须结算加载终态——数据保持写确认后的现状并转 ready；绝不允许永久 loading。
   * 注意：仅在仍有请求在途（新 load 会自行结算）或非 loading 态时不干预，
   * 避免把新请求的进行中状态误结算、或把正常失败伪报成功。
   */
  function settleSupersededLoad(): void {
    if (!disposed && loadOutstanding === 0 && state === "loading") {
      state = "ready";
      notify();
    }
  }

  /** 专题续取（R1）：cursor 合同；去重合并；失败保留旧列表与 cursor 可重试。 */
  async function loadMore(): Promise<void> {
    if (disposed || state !== "ready" || loadingMoreTopics || nextCursor === null || venue === null) return;
    const currentVenue = venue;
    const cursor = nextCursor;
    const seq = ++topicsPageSeq;
    loadingMoreTopics = true;
    notify();
    try {
      const page = await options.client.listTopics({ venue: currentVenue, cursor });
      if (disposed || seq !== topicsPageSeq) return; // 代际失效（切题型/刷新已发生）：整体丢弃
      const seen = new Set(topics.map((topic) => topic.id));
      const merged = [...topics];
      for (const item of page.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          merged.push(item);
        }
      }
      topics = merged;
      total = page.total;
      nextCursor = page.nextCursor;
      loadingMoreTopics = false;
      error = null;
    } catch (caught) {
      if (disposed || seq !== topicsPageSeq) return;
      loadingMoreTopics = false;
      error = describeError(caught); // 保留 topics/nextCursor，可重试
    }
    notify();
  }

  function refresh(): Promise<void> {
    if (venue === null) return Promise.resolve();
    return load(venue);
  }

  /** 串行队列：同一时刻至多一个写操作在途；执行时读取最新版本。 */
  function enqueue<T>(topicId: string, run: () => Promise<T>): Promise<T> {
    const task = chain.then(async () => {
      if (disposed) throw new Error("协调器已销毁。");
      if (conflictTopicId === topicId) throw new StudyTopicWriteConflictError(topicId);
      writePendingTopicId = topicId;
      notify();
      try {
        return await run();
      } finally {
        writePendingTopicId = null;
        notify();
      }
    });
    chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  function requireTopic(topicId: string): StudyTopicDto {
    const topic = topics.find((item) => item.id === topicId);
    if (!topic) throw new Error("专题不存在或尚未加载。");
    return topic;
  }

  /**
   * R1 后页深链：写操作目标不在本地（分页未加载）时，经 cursor 续取定位专题，
   * 结果并入列表后返回其最新版本；取尽仍无 → 显式报错（不静默成功、不发写请求）。
   * F3：定位纳入读取代际合同——发起题型/页代际在等待期间任一变化（切题型、刷新、
   * 手工翻页、dispose）即中止并显式拒绝，绝不改动当前视图的 topics/total/cursor。
   */
  async function ensureTopicLoaded(topicId: string): Promise<StudyTopicDto> {
    const known = topics.find((item) => item.id === topicId);
    if (known) return known;
    if (venue === null) throw new Error("专题不存在或尚未加载。");
    const walkVenue = venue;
    const walkSeq = topicsPageSeq;
    while (nextCursor !== null && !disposed) {
      const page = await options.client.listTopics({ venue: walkVenue, cursor: nextCursor });
      if (disposed) throw new Error("协调器已销毁。");
      // F3：读取代际核对（在合并之前）——上下文已切换则整体中止
      if (venue !== walkVenue || topicsPageSeq !== walkSeq) {
        throw new Error("专题上下文已切换，请重试。");
      }
      const seen = new Set(topics.map((topic) => topic.id));
      const merged = [...topics];
      for (const item of page.items) {
        if (!seen.has(item.id)) merged.push(item);
      }
      topics = merged;
      total = page.total;
      nextCursor = page.nextCursor;
      notify();
      const found = topics.find((item) => item.id === topicId);
      if (found) return found;
    }
    throw new Error("专题不存在或已被移除。");
  }

  function saveTopic(topicId: string, input: { title: string; status: StudyTopicStatus }): Promise<StudyTopicDto> {
    return enqueue(topicId, async () => {
      const topic = await ensureTopicLoaded(topicId); // 执行时取最新版本（后页深链经续取定位）
      try {
        const { item } = await options.client.saveTopic(topicId, {
          requestId: generateRequestId(),
          expectedVersion: topic.version,
          title: input.title,
          status: input.status,
        });
        if (disposed) throw new Error("协调器已销毁。");
        upsertTopic(item);
        return item;
      } catch (caught) {
        if (isConflictError(caught) && topic.questionType === venue) { // R2：跨题型迟到回包不标记当前视图冲突
          conflictTopicId = topicId;
          notify();
        }
        throw caught;
      }
    });
  }

  function moveMember(topicId: string, noteId: string, beforeNoteId: string | null): Promise<StudyTopicDto> {
    return enqueue(topicId, async () => {
      const topic = await ensureTopicLoaded(topicId);
      try {
        const { item } = await options.client.moveTopicMember(topicId, noteId, {
          requestId: generateRequestId(),
          expectedVersion: topic.version,
          beforeNoteId,
        });
        if (disposed) throw new Error("协调器已销毁。");
        upsertTopic(item);
        return item;
      } catch (caught) {
        if (isConflictError(caught) && topic.questionType === venue) { // R2：跨题型迟到回包不标记当前视图冲突
          conflictTopicId = topicId;
          notify();
        }
        throw caught;
      }
    });
  }

  function removeMember(topicId: string, noteId: string): Promise<StudyTopicDto> {
    return enqueue(topicId, async () => {
      const topic = await ensureTopicLoaded(topicId);
      try {
        const { item } = await options.client.removeTopicMember(topicId, noteId, {
          requestId: generateRequestId(),
          expectedVersion: topic.version,
        });
        if (disposed) throw new Error("协调器已销毁。");
        upsertTopic(item);
        return item;
      } catch (caught) {
        if (isConflictError(caught) && topic.questionType === venue) { // R2：跨题型迟到回包不标记当前视图冲突
          conflictTopicId = topicId;
          notify();
        }
        throw caught;
      }
    });
  }

  function createTopic(title: string): Promise<StudyTopicDto> {
    if (disposed) return Promise.reject(new Error("协调器已销毁。"));
    if (!venue) return Promise.reject(new Error("尚未加载专题（venue 未设置）。"));
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return Promise.reject(new Error("专题名称不能为空。"));

    const currentVenue = venue;
    // 双击守卫：同一题型、同一标题且在途 → 复用同一承诺（R2：跨题型/跨标题不复用）
    if (
      createFlight !== null &&
      createFlight.venue === currentVenue &&
      pendingCreate !== null &&
      pendingCreate.venue === currentVenue &&
      pendingCreate.title === trimmedTitle
    ) {
      return createFlight.promise;
    }
    // 失败重试：flight 已结束、幂等键仍在 → 复用同一 requestId（否则生成新键）
    const reuseKey =
      createFlight === null &&
      pendingCreate !== null &&
      pendingCreate.venue === currentVenue &&
      pendingCreate.title === trimmedTitle;
    const requestId = reuseKey && pendingCreate ? pendingCreate.requestId : generateRequestId();
    const keyId = ++createKeySeq;
    pendingCreate = { requestId, title: trimmedTitle, venue: currentVenue };

    createError = null; // 新发起：清当前视图错误
    notify();

    const flight = (async () => {
      try {
        const { item } = await options.client.createTopic({
          requestId,
          venue: currentVenue,
          title: trimmedTitle,
        });
        if (disposed) throw new Error("协调器已销毁。");
        upsertTopic(item); // venue 归属判定 + 读代际推进（R2/R3）
        if (
          pendingCreate !== null &&
          pendingCreate.venue === currentVenue &&
          pendingCreate.requestId === requestId
        ) {
          pendingCreate = null; // 幂等键完成使命（仅当仍属于本 flight）
        }
        return item;
      } catch (caught) {
        // R2：仅当仍在发起视图时显示错误；切题型后旧 flight 错误不注入新视图
        if (!disposed && venue === currentVenue) createError = describeError(caught);
        throw caught;
      } finally {
        if (createFlight !== null && createFlight.id === keyId) createFlight = null; // 身份化清理，不误清新 flight
        notify();
      }
    })();
    createFlight = { id: keyId, venue: currentVenue, promise: flight };
    return flight;
  }

  function getSnapshot(): StudyTopicsSnapshot {
    return {
      topics: [...topics],
      state,
      error,
      conflictTopicId,
      // R2：createPending 按视图归属推导——旧题型的在途创建不禁用新视图的创建按钮
      createPending:
        createFlight !== null && pendingCreate !== null && pendingCreate.venue === venue,
      createError,
      writePendingTopicId,
      total,
      nextCursor,
      loadingMoreTopics,
    };
  }

  function subscribe(listener: () => void): () => void {
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  }

  function dispose(): void {
    disposed = true;
    subscribers.clear();
    loadSeq += 1;
    topicsPageSeq += 1; // 在途专题续取一并失效
  }

  return {
    load,
    refresh,
    loadMore,
    createTopic,
    saveTopic,
    moveMember,
    removeMember,
    getSnapshot,
    subscribe,
    dispose,
    isDisposed: () => disposed,
  };
}
