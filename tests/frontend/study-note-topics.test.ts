/**
 * Task 08 · 专题协调器测试（先红后绿）。
 *
 * 纪律（§3.4）：同一时刻至多一个写操作在途（串行队列）；expectedVersion 在执行时取
 * 本地最近服务端版本；每个响应更新本地版本；409 → 停止自动写 + 显式刷新前该专题写被拒绝；
 * 创建失败重试复用同一 requestId；成员移动透传 beforeNoteId。
 */
import { describe, expect, it, vi } from "vitest";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import type { StudyTopicDto } from "@/domain/l3-study-notes";
import {
  createStudyTopicCoordinator,
  StudyTopicWriteConflictError,
} from "@/frontend/state/studyTopicCoordinator";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const TOPIC_ID = "00000000-0000-4000-8000-000000000901";
const TOPIC2_ID = "00000000-0000-4000-8000-000000000902";
const NOTE_ID = "00000000-0000-4000-8000-000000000701";
const NOTE2_ID = "00000000-0000-4000-8000-000000000702";

function topicDto(overrides: Partial<StudyTopicDto> = {}): StudyTopicDto {
  return {
    id: TOPIC_ID,
    questionType: "cloze",
    title: "专题一",
    status: "active",
    version: 3,
    memberCount: 2,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

let reqSeq = 0;
function nextRequestId(): string {
  reqSeq += 1;
  return `00000000-0000-4000-8000-${String(reqSeq).padStart(12, "0")}`;
}

function makeClient() {
  return {
    listTopics: vi.fn(),
    createTopic: vi.fn(),
    saveTopic: vi.fn(),
    moveTopicMember: vi.fn(),
    removeTopicMember: vi.fn(),
  };
}

function setup() {
  const client = makeClient();
  const coordinator = createStudyTopicCoordinator({ client, generateRequestId: nextRequestId });
  return { client, coordinator };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("studyTopicCoordinator · 加载", () => {
  it("load：按 venue 拉取并替换本地列表（服务端版本原样）", async () => {
    const { client, coordinator } = setup();
    client.listTopics.mockResolvedValue({ items: [topicDto()], total: 1, nextCursor: null });
    await coordinator.load("cloze");
    expect(client.listTopics).toHaveBeenCalledWith(expect.objectContaining({ venue: "cloze" }));
    const snap = coordinator.getSnapshot();
    expect(snap.state).toBe("ready");
    expect(snap.topics.map((t) => t.id)).toEqual([TOPIC_ID]);
    expect(snap.topics[0]!.version).toBe(3);
  });
});

describe("studyTopicCoordinator · 创建", () => {
  it("创建成功：requestId 新生成、响应入列（服务端版本）、pending 清除", async () => {
    const { client, coordinator } = setup();
    client.listTopics.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    await coordinator.load("cloze");

    client.createTopic.mockResolvedValue({ item: topicDto({ version: 1 }), created: true });
    const created = await coordinator.createTopic("新专题");
    expect(client.createTopic).toHaveBeenCalledTimes(1);
    const input = client.createTopic.mock.calls[0]![0] as { requestId: string; venue: string; title: string };
    expect(input.venue).toBe("cloze");
    expect(input.title).toBe("新专题");
    expect(input.requestId).toBeTruthy();
    expect(created.version).toBe(1);
    expect(coordinator.getSnapshot().topics.map((t) => t.id)).toContain(TOPIC_ID);
    expect(coordinator.getSnapshot().createPending).toBe(false);
  });

  it("创建失败 → 重试复用同一 requestId；换标题用新 requestId", async () => {
    const { client, coordinator } = setup();
    client.listTopics.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    await coordinator.load("cloze");

    client.createTopic.mockRejectedValueOnce(new Error("net"));
    await expect(coordinator.createTopic("新专题")).rejects.toBeTruthy();
    expect(coordinator.getSnapshot().createError).toBeTruthy();
    const firstRequestId = (client.createTopic.mock.calls[0]![0] as { requestId: string }).requestId;

    client.createTopic.mockRejectedValueOnce(new Error("net again"));
    await expect(coordinator.createTopic("新专题")).rejects.toBeTruthy();
    const secondRequestId = (client.createTopic.mock.calls[1]![0] as { requestId: string }).requestId;
    expect(secondRequestId).toBe(firstRequestId); // 重试复用

    client.createTopic.mockResolvedValue({ item: topicDto({ version: 1 }), created: true });
    await coordinator.createTopic("新专题");
    expect((client.createTopic.mock.calls[2]![0] as { requestId: string }).requestId).toBe(firstRequestId);

    client.createTopic.mockResolvedValue({ item: topicDto({ title: "另一个" }), created: true });
    await coordinator.createTopic("另一个");
    const otherRequestId = (client.createTopic.mock.calls[3]![0] as { requestId: string }).requestId;
    expect(otherRequestId).not.toBe(firstRequestId);
  });

  it("双击守卫：创建在途时再次调用不发起第二次请求（返回同一承诺）", async () => {
    const { client, coordinator } = setup();
    client.listTopics.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    await coordinator.load("cloze");

    const d = defer<{ item: StudyTopicDto; created: boolean }>();
    client.createTopic.mockReturnValue(d.promise);
    const first = coordinator.createTopic("新专题");
    const second = coordinator.createTopic("新专题");
    expect(client.createTopic).toHaveBeenCalledTimes(1);
    d.resolve({ item: topicDto({ version: 1 }), created: true });
    await expect(first).resolves.toBeTruthy();
    await expect(second).resolves.toBeTruthy();
  });
});

describe("studyTopicCoordinator · 串行与版本", () => {
  it("写操作串行：第二个保存在第一个完成前不发起；第二个用第一个响应推进的版本", async () => {
    const { client, coordinator } = setup();
    client.listTopics.mockResolvedValue({ items: [topicDto({ version: 3 })], total: 1, nextCursor: null });
    await coordinator.load("cloze");

    const d1 = defer<{ item: StudyTopicDto }>();
    client.saveTopic
      .mockReturnValueOnce(d1.promise)
      .mockResolvedValueOnce({ item: topicDto({ version: 5, title: "改名二" }) });
    const save1 = coordinator.saveTopic(TOPIC_ID, { title: "改名一", status: "active" });
    const save2 = coordinator.saveTopic(TOPIC_ID, { title: "改名二", status: "active" });
    await flushMicrotasks();
    expect(client.saveTopic).toHaveBeenCalledTimes(1); // 串行：第二个未发起
    expect((client.saveTopic.mock.calls[0]![1] as { expectedVersion: number }).expectedVersion).toBe(3);

    d1.resolve({ item: topicDto({ version: 4, title: "改名一" }) });
    await save1;
    await flushMicrotasks();
    expect(client.saveTopic).toHaveBeenCalledTimes(2);
    expect((client.saveTopic.mock.calls[1]![1] as { expectedVersion: number }).expectedVersion).toBe(4); // 来自响应

    await save2;
    expect(coordinator.getSnapshot().topics[0]!.version).toBe(5);
    expect(coordinator.getSnapshot().writePendingTopicId).toBeNull();
  });

  it("moveMember：透传 beforeNoteId；响应更新版本", async () => {
    const { client, coordinator } = setup();
    client.listTopics.mockResolvedValue({ items: [topicDto({ version: 7 })], total: 1, nextCursor: null });
    await coordinator.load("cloze");

    client.moveTopicMember.mockResolvedValue({ item: topicDto({ version: 8 }) });
    await coordinator.moveMember(TOPIC_ID, NOTE_ID, NOTE2_ID);
    const [topicArg, noteArg, inputArg] = client.moveTopicMember.mock.calls[0]! as [string, string, Record<string, unknown>];
    expect(topicArg).toBe(TOPIC_ID);
    expect(noteArg).toBe(NOTE_ID);
    expect(inputArg).toEqual(expect.objectContaining({ expectedVersion: 7, beforeNoteId: NOTE2_ID }));
    expect(coordinator.getSnapshot().topics[0]!.version).toBe(8);

    client.moveTopicMember.mockResolvedValue({ item: topicDto({ version: 9 }) });
    await coordinator.moveMember(TOPIC_ID, NOTE_ID, null); // 移到末尾
    expect((client.moveTopicMember.mock.calls[1]![2] as Record<string, unknown>).beforeNoteId).toBeNull();
  });

  it("removeMember：经同一版本通道", async () => {
    const { client, coordinator } = setup();
    client.listTopics.mockResolvedValue({ items: [topicDto({ version: 2 })], total: 1, nextCursor: null });
    await coordinator.load("cloze");

    client.removeTopicMember.mockResolvedValue({ item: topicDto({ version: 3 }) });
    await coordinator.removeMember(TOPIC_ID, NOTE_ID);
    expect(client.removeTopicMember).toHaveBeenCalledWith(
      TOPIC_ID,
      NOTE_ID,
      expect.objectContaining({ expectedVersion: 2 }),
    );
    expect(coordinator.getSnapshot().topics[0]!.version).toBe(3);
  });
});

describe("studyTopicCoordinator · 409 冲突纪律", () => {
  it("409 → 标记冲突、不自动重试；该专题后续写被拒（不发请求）；刷新后恢复写", async () => {
    const { client, coordinator } = setup();
    client.listTopics.mockResolvedValue({ items: [topicDto({ version: 5 })], total: 1, nextCursor: null });
    await coordinator.load("cloze");

    client.saveTopic.mockRejectedValueOnce(new BrowserApiError(409, { code: "CONFLICT", message: "conflict" }));
    await expect(coordinator.saveTopic(TOPIC_ID, { title: "改名", status: "active" })).rejects.toBeTruthy();
    expect(coordinator.getSnapshot().conflictTopicId).toBe(TOPIC_ID);
    expect(client.saveTopic).toHaveBeenCalledTimes(1); // 不自动重试

    // 冲突未清除：后续写被拒且不发请求
    await expect(coordinator.moveMember(TOPIC_ID, NOTE_ID, null)).rejects.toBeInstanceOf(StudyTopicWriteConflictError);
    expect(client.moveTopicMember).not.toHaveBeenCalled();

    // 显式刷新（服务端版本推进到 9）后恢复写
    client.listTopics.mockResolvedValue({ items: [topicDto({ version: 9 })], total: 1, nextCursor: null });
    await coordinator.refresh();
    expect(coordinator.getSnapshot().conflictTopicId).toBeNull();

    client.saveTopic.mockResolvedValueOnce({ item: topicDto({ version: 10 }) });
    await coordinator.saveTopic(TOPIC_ID, { title: "改名", status: "active" });
    expect(client.saveTopic).toHaveBeenCalledTimes(2);
    expect((client.saveTopic.mock.calls[1]![1] as { expectedVersion: number }).expectedVersion).toBe(9);
  });

  it("409 仅影响对应专题：其他专题可继续写", async () => {
    const { client, coordinator } = setup();
    client.listTopics.mockResolvedValue({
      items: [topicDto({ version: 5 }), topicDto({ id: TOPIC2_ID, version: 2, title: "专题二" })],
      total: 2,
      nextCursor: null,
    });
    await coordinator.load("cloze");

    client.saveTopic.mockRejectedValueOnce(new BrowserApiError(409, { code: "CONFLICT", message: "conflict" }));
    await expect(coordinator.saveTopic(TOPIC_ID, { title: "x", status: "active" })).rejects.toBeTruthy();

    client.saveTopic.mockResolvedValueOnce({ item: topicDto({ id: TOPIC2_ID, version: 3 }) });
    await coordinator.saveTopic(TOPIC2_ID, { title: "y", status: "active" });
    expect(client.saveTopic).toHaveBeenCalledTimes(2);
  });
});

describe("studyTopicCoordinator · 生命周期", () => {
  it("dispose：在途响应丢弃、后续操作拒绝", async () => {
    const { client, coordinator } = setup();
    client.listTopics.mockResolvedValue({ items: [topicDto()], total: 1, nextCursor: null });
    await coordinator.load("cloze");

    const d = defer<{ item: StudyTopicDto }>();
    client.saveTopic.mockReturnValueOnce(d.promise);
    const pending = coordinator.saveTopic(TOPIC_ID, { title: "x", status: "active" });
    coordinator.dispose();
    d.resolve({ item: topicDto({ version: 99 }) });
    await expect(pending).rejects.toBeTruthy();
    expect(coordinator.getSnapshot().topics[0]!.version).toBe(3); // 未被污染

    await expect(coordinator.saveTopic(TOPIC_ID, { title: "y", status: "active" })).rejects.toBeTruthy();
  });
});

describe("studyTopicCoordinator · 专题分页（R1 补修）", () => {
  it("load：暴露服务端 total/nextCursor；loadMore 续取下一页并去重合并（探针1正式化）", async () => {
    const client = makeClient();
    const coordinator = createStudyTopicCoordinator({ client, generateRequestId: nextRequestId });
    client.listTopics
      .mockResolvedValueOnce({ items: [topicDto()], nextCursor: "cursor-page-2", total: 55 })
      .mockResolvedValueOnce({
        items: [topicDto({ id: TOPIC2_ID, title: "专题二", memberCount: 0 })],
        nextCursor: null,
        total: 55,
      });

    await coordinator.load("cloze");
    let snapshot = coordinator.getSnapshot();
    expect(snapshot.topics).toHaveLength(1);
    expect(snapshot.total).toBe(55);
    expect(snapshot.nextCursor).toBe("cursor-page-2");

    const more = coordinator.loadMore();
    expect(coordinator.getSnapshot().loadingMoreTopics).toBe(true);
    await more;
    snapshot = coordinator.getSnapshot();
    expect(client.listTopics).toHaveBeenLastCalledWith(
      expect.objectContaining({ venue: "cloze", cursor: "cursor-page-2" }),
    );
    expect(snapshot.topics.map((item) => item.id)).toEqual([TOPIC_ID, TOPIC2_ID]);
    expect(snapshot.total).toBe(55);
    expect(snapshot.nextCursor).toBe(null);
    expect(snapshot.loadingMoreTopics).toBe(false);

    // cursor 用尽后再 loadMore = no-op（不发请求）
    await coordinator.loadMore();
    expect(client.listTopics).toHaveBeenCalledTimes(2);
  });

  it("loadMore 失败：保留旧列表与 cursor、状态复位、可重试成功", async () => {
    const client = makeClient();
    const coordinator = createStudyTopicCoordinator({ client, generateRequestId: nextRequestId });
    client.listTopics
      .mockResolvedValueOnce({ items: [topicDto()], nextCursor: "cursor-page-2", total: 2 })
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({
        items: [topicDto({ id: TOPIC2_ID, title: "专题二", memberCount: 0 })],
        nextCursor: null,
        total: 2,
      });

    await coordinator.load("cloze");
    await coordinator.loadMore(); // 第一次：失败
    let snapshot = coordinator.getSnapshot();
    expect(snapshot.topics).toHaveLength(1); // 旧列表保留
    expect(snapshot.nextCursor).toBe("cursor-page-2"); // cursor 保留可重试
    expect(snapshot.loadingMoreTopics).toBe(false);
    expect(snapshot.error).toContain("network down");

    await coordinator.loadMore(); // 重试：成功
    snapshot = coordinator.getSnapshot();
    expect(snapshot.topics).toHaveLength(2);
    expect(snapshot.error).toBe(null);
    expect(snapshot.nextCursor).toBe(null);
  });

  it("切题型（load）失效在途 loadMore：迟到回包不污染新列表（也不释放/推进新代状态）", async () => {
    const client = makeClient();
    const coordinator = createStudyTopicCoordinator({ client, generateRequestId: nextRequestId });
    const d = defer<{ items: StudyTopicDto[]; nextCursor: string | null; total: number }>();
    client.listTopics
      .mockResolvedValueOnce({ items: [topicDto()], nextCursor: "cursor-page-2", total: 3 })
      .mockReturnValueOnce(d.promise) // cloze 的 loadMore 挂起
      .mockResolvedValueOnce({ items: [topicDto({ questionType: "sentence_translation", title: "译题" })], nextCursor: null, total: 1 });

    await coordinator.load("cloze");
    const more = coordinator.loadMore();
    await coordinator.load("sentence_translation"); // 切题型推进代际
    d.resolve({ items: [topicDto({ id: TOPIC2_ID })], nextCursor: null, total: 3 });
    await more;

    const snapshot = coordinator.getSnapshot();
    expect(snapshot.topics.map((item) => item.questionType)).toEqual(["sentence_translation"]);
  });

  it("后页专题深链：本地未加载时写操作经续取定位专题后按其最新版本执行（不误判不存在）", async () => {
    const client = makeClient();
    const coordinator = createStudyTopicCoordinator({ client, generateRequestId: nextRequestId });
    client.listTopics
      .mockResolvedValueOnce({ items: [topicDto()], nextCursor: "cursor-page-2", total: 2 })
      .mockResolvedValueOnce({
        items: [topicDto({ id: TOPIC2_ID, title: "专题二", version: 7 })],
        nextCursor: null,
        total: 2,
      });
    client.saveTopic.mockResolvedValueOnce({
      item: topicDto({ id: TOPIC2_ID, title: "v8 标题", version: 8, memberCount: 0 }),
    });

    await coordinator.load("cloze"); // 本地仅首页
    await expect(
      coordinator.saveTopic(TOPIC2_ID, { title: "v8 标题", status: "active" }),
    ).resolves.toMatchObject({ id: TOPIC2_ID, version: 8 });
    // 先经 cursor 续取拿到该专题（v7），再用 v7 作为 expectedVersion
    expect(client.saveTopic).toHaveBeenCalledWith(
      TOPIC2_ID,
      expect.objectContaining({ expectedVersion: 7 }),
    );
    // 续取结果并入列表：面板可见、可再次操作
    expect(coordinator.getSnapshot().topics.map((item) => item.id)).toEqual([TOPIC_ID, TOPIC2_ID]);
  });

  it("深链专题确不存在（cursor 取尽仍无）：显式报错，不静默成功", async () => {
    const client = makeClient();
    const coordinator = createStudyTopicCoordinator({ client, generateRequestId: nextRequestId });
    client.listTopics
      .mockResolvedValueOnce({ items: [topicDto()], nextCursor: "cursor-page-2", total: 2 })
      .mockResolvedValueOnce({
        items: [topicDto({ id: TOPIC2_ID, title: "专题二" })],
        nextCursor: null,
        total: 2,
      });

    await coordinator.load("cloze");
    const ghostId = "00000000-0000-4000-8000-000000000999";
    await expect(coordinator.saveTopic(ghostId, { title: "x", status: "active" })).rejects.toBeTruthy();
    // 未发起 saveTopic 请求
    expect(client.saveTopic).not.toHaveBeenCalled();
  });
});

describe("studyTopicCoordinator · 读写代际（R2/R3 补修）", () => {
  it("迟到创建回包不注入新题型视图；切回原题型可读到（不重复创建）（探针2正式化）", async () => {
    const client = makeClient();
    const coordinator = createStudyTopicCoordinator({ client, generateRequestId: nextRequestId });
    client.listTopics.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    await coordinator.load("cloze");

    const d = defer<{ item: StudyTopicDto; created: boolean }>();
    client.createTopic.mockReturnValueOnce(d.promise);
    const creating = coordinator.createTopic("旧题型专题");

    client.listTopics.mockResolvedValue({
      items: [topicDto({ id: TOPIC2_ID, questionType: "sentence_translation", title: "译题" })],
      nextCursor: null,
      total: 1,
    });
    await coordinator.load("sentence_translation"); // 切题型并加载完成

    d.resolve({ item: topicDto({ id: TOPIC_ID, title: "旧题型专题" }), created: true });
    await creating; // 迟到回包：真实成功

    // 当前视图仅 sentence_translation，cloze 不混入
    expect(coordinator.getSnapshot().topics.map((item) => item.questionType)).toEqual(["sentence_translation"]);

    // 切回 cloze：服务端真实状态可读，无需重复创建
    client.listTopics.mockResolvedValueOnce({
      items: [topicDto({ id: TOPIC_ID, title: "旧题型专题" })],
      nextCursor: null,
      total: 1,
    });
    await coordinator.load("cloze");
    expect(coordinator.getSnapshot().topics.map((item) => item.id)).toEqual([TOPIC_ID]);
    expect(client.createTopic).toHaveBeenCalledTimes(1);
  });

  it("迟到写回包（save/move/remove）不注入新题型列表；失败与 finally 不清除新代状态", async () => {
    const client = makeClient();
    const coordinator = createStudyTopicCoordinator({ client, generateRequestId: nextRequestId });
    client.listTopics
      .mockResolvedValueOnce({ items: [topicDto({ version: 5 })], nextCursor: null, total: 1 })
      .mockResolvedValueOnce({
        items: [topicDto({ id: TOPIC2_ID, questionType: "sentence_translation", title: "译题", version: 1 })],
        nextCursor: null,
        total: 1,
      });
    await coordinator.load("cloze");

    const d = defer<{ item: StudyTopicDto }>();
    client.saveTopic.mockReturnValueOnce(d.promise);
    const saving = coordinator.saveTopic(TOPIC_ID, { title: "改名", status: "active" });
    await coordinator.load("sentence_translation");
    const stableSnapshot = coordinator.getSnapshot();

    d.resolve({ item: topicDto({ version: 6, title: "改名" }) });
    await saving;

    // 迟到回包不注入；新列表原样
    const snapshot = coordinator.getSnapshot();
    expect(snapshot.topics.map((item) => item.id)).toEqual([TOPIC2_ID]);
    expect(snapshot.topics[0]!.version).toBe(stableSnapshot.topics[0]!.version);
    expect(snapshot.writePendingTopicId).toBe(null); // finally 复位（不残留旧代 busy）
  });

  it("迟到刷新不回退已确认版本；下一次写使用已确认的新版本（探针3正式化）", async () => {
    const client = makeClient();
    const coordinator = createStudyTopicCoordinator({ client, generateRequestId: nextRequestId });
    client.listTopics.mockResolvedValueOnce({ items: [topicDto({ version: 1 })], nextCursor: null, total: 1 });
    await coordinator.load("cloze");

    const d = defer<{ items: StudyTopicDto[]; nextCursor: string | null; total: number }>();
    client.listTopics.mockReturnValueOnce(d.promise);
    const refreshing = coordinator.refresh(); // 读到 v1 挂起

    client.saveTopic.mockResolvedValueOnce({ item: topicDto({ version: 2, title: "v2" }) });
    await coordinator.saveTopic(TOPIC_ID, { title: "v2", status: "active" }); // 确认 v2

    d.resolve({ items: [topicDto({ version: 1 })], nextCursor: null, total: 1 });
    await refreshing; // 迟到回包 v1

    expect(coordinator.getSnapshot().topics[0]!.version).toBe(2); // 不倒退

    // 下一次写必须基于 v2（不制造自冲突）
    client.saveTopic.mockResolvedValueOnce({ item: topicDto({ version: 3, title: "v3" }) });
    await coordinator.saveTopic(TOPIC_ID, { title: "v3", status: "active" });
    expect(client.saveTopic).toHaveBeenLastCalledWith(
      TOPIC_ID,
      expect.objectContaining({ expectedVersion: 2 }),
    );
  });

  it("新鲜刷新仍采纳他端更高版本（不因代际保护而永远忽略刷新）", async () => {
    const client = makeClient();
    const coordinator = createStudyTopicCoordinator({ client, generateRequestId: nextRequestId });
    client.listTopics.mockResolvedValueOnce({ items: [topicDto({ version: 1 })], nextCursor: null, total: 1 });
    await coordinator.load("cloze");

    client.saveTopic.mockResolvedValueOnce({ item: topicDto({ version: 2, title: "本端 v2" }) });
    await coordinator.saveTopic(TOPIC_ID, { title: "本端 v2", status: "active" });

    // 他端推进到 v9 的最新快照：新鲜刷新必须采纳
    client.listTopics.mockResolvedValueOnce({ items: [topicDto({ version: 9, title: "他端 v9" })], nextCursor: null, total: 1 });
    await coordinator.refresh();
    expect(coordinator.getSnapshot().topics[0]).toMatchObject({ version: 9, title: "他端 v9" });
  });

  it("切题型后创建不复用旧题型在途 flight；旧 flight 错误不显示到新视图", async () => {
    const client = makeClient();
    const coordinator = createStudyTopicCoordinator({ client, generateRequestId: nextRequestId });
    client.listTopics.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    await coordinator.load("cloze");

    const d = defer<{ item: StudyTopicDto; created: boolean }>();
    client.createTopic.mockReturnValueOnce(d.promise);
    // 旧 flight 的 rejection 由本测试显式处置；断言对象是 createError 的视图归属
    coordinator.createTopic("旧题型专题").catch(() => {});

    await coordinator.load("sentence_translation");
    // 新题型可立即发起创建（不复用旧 flight、不发旧 requestId）
    client.createTopic.mockResolvedValueOnce({
      item: topicDto({ id: TOPIC2_ID, questionType: "sentence_translation", title: "新译题" }),
    });
    await coordinator.createTopic("新译题");
    expect(client.createTopic).toHaveBeenLastCalledWith(expect.objectContaining({ venue: "sentence_translation" }));

    // 旧 flight 失败：错误不显示到新视图
    d.reject(new Error("旧题型创建失败"));
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.getSnapshot().createError).toBe(null);
  });
});
