/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * Task 08 · 学习笔记空间页测试（先红后绿）——真实组件 + 注入 fake client。
 *
 * 覆盖：七题型入口空态（零请求）/ 浏览与筛选零 POST / 显式创建一次（双击守卫）/
 * 深链校验（venue ∈ note.venues）/ 未授权深链（不泄露、不创建）/ 分页与筛选游标 /
 * 离页 flush 成功与失败 / 在途保存期间禁止错误导航 / 双标签 409 恢复 / 归档与恢复 /
 * 专题创建与重命名（服务端版本）/ 成员移动（beforeNoteId）。
 *
 * 真实浏览器 + 隔离 PG 见 e2e-study-notes/study-notes-workspace.spec.ts。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import type { StudyNotesClient } from "@/frontend/api/studyNotesClient";
import type { StudyNoteDto, StudyNoteSummary, StudyTopicDto } from "@/domain/l3-study-notes";
import { L3StudyNotesPage } from "@/frontend/pages/L3StudyNotesPage";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const NOTE_ID = "00000000-0000-4000-8000-000000000701";
const NOTE2_ID = "00000000-0000-4000-8000-000000000702";
const TOPIC_ID = "00000000-0000-4000-8000-000000000901";

function makeSummary(overrides: Partial<StudyNoteSummary> = {}): StudyNoteSummary {
  return {
    id: NOTE_ID,
    title: "笔记标题一",
    venues: ["cloze"],
    pinned: false,
    status: "active",
    version: 3,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:30:00.000Z",
    ...overrides,
  };
}

function makeDto(overrides: Partial<StudyNoteDto> = {}): StudyNoteDto {
  return {
    ...makeSummary(),
    bodyMd: "正文内容",
    references: [],
    ...overrides,
  };
}

function makeTopic(overrides: Partial<StudyTopicDto> = {}): StudyTopicDto {
  return {
    id: TOPIC_ID,
    questionType: "cloze",
    title: "专题一",
    status: "active",
    version: 4,
    memberCount: 2,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface ClientMocks {
  client: StudyNotesClient;
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  listTopics: ReturnType<typeof vi.fn>;
  createTopic: ReturnType<typeof vi.fn>;
  saveTopic: ReturnType<typeof vi.fn>;
  moveTopicMember: ReturnType<typeof vi.fn>;
  removeTopicMember: ReturnType<typeof vi.fn>;
}

function makeClient(): ClientMocks {
  const list = vi.fn();
  const get = vi.fn();
  const create = vi.fn();
  const save = vi.fn();
  const listTopics = vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null });
  const createTopic = vi.fn();
  const saveTopic = vi.fn();
  const moveTopicMember = vi.fn();
  const removeTopicMember = vi.fn();
  const client = {
    list, get, create, save, listTopics, createTopic, saveTopic, moveTopicMember, removeTopicMember,
    searchTargets: vi.fn(), preview: vi.fn(), backlinks: vi.fn(),
  } as unknown as StudyNotesClient;
  return { client, list, get, create, save, listTopics, createTopic, saveTopic, moveTopicMember, removeTopicMember };
}

/** 位置探针：断言 URL（path + search）随导航变化。 */
function LocationProbe() {
  const location = useLocation();
  return createElement("div", { "data-testid": "location" }, `${location.pathname}${location.search}`);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

async function renderPage(url: string, client: StudyNotesClient): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [url] },
        createElement(L3StudyNotesPage, { client }),
        createElement(LocationProbe),
      ),
    );
  });
}

function locationText(): string {
  return screen.getByTestId("location").textContent ?? "";
}

const LIST_URL = "/l3?section=study-notes&venue=cloze";
const NOTE_URL = `/l3?section=study-notes&venue=cloze&noteId=${NOTE_ID}`;

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ── 用例 ────────────────────────────────────────────────────────────────────

describe("L3StudyNotesPage · 入口与创建纪律", () => {
  it("无 venue：显示题型选择空态；不发列表/详情/创建请求", async () => {
    const { client, list, get, create } = makeClient();
    await renderPage("/l3?section=study-notes", client);
    expect(screen.getByTestId("venue-picker")).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("浏览列表：仅 list 请求（venue、无 cursor）；渲染行与 total；零 POST", async () => {
    const { client, list, create } = makeClient();
    list.mockResolvedValue({
      items: [makeSummary(), makeSummary({ id: NOTE2_ID, title: "笔记二" })],
      total: 2,
      nextCursor: null,
    });
    await renderPage(LIST_URL, client);
    await waitFor(() => expect(screen.getAllByTestId("study-note-row")).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]![0]).toMatchObject({ venue: "cloze" });
    expect((list.mock.calls[0]![0] as Record<string, unknown>).cursor).toBeUndefined();
    expect(screen.getByTestId("list-total").textContent).toContain("2");
    expect(create).not.toHaveBeenCalled(); // 浏览不创建
  });

  it("显式新建：POST 恰一次（requestId + venue），成功后 URL replace 到该 note；双击不并行创建", async () => {
    const { client, list, create, get } = makeClient();
    list.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    const createDeferred = defer<{ item: StudyNoteDto; created: boolean }>();
    create.mockReturnValue(createDeferred.promise);
    get.mockResolvedValue({ item: makeDto() });

    await renderPage(LIST_URL, client);
    await waitFor(() => expect(screen.getByTestId("new-note-button")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("new-note-button"));
      fireEvent.click(screen.getByTestId("new-note-button")); // 双击守卫
    });
    expect(create).toHaveBeenCalledTimes(1);
    const input = create.mock.calls[0]![0] as { requestId: string; venue: string };
    expect(input.venue).toBe("cloze");
    expect(input.requestId).toMatch(/^[0-9a-f-]{36}$/i);

    await act(async () => {
      createDeferred.resolve({ item: makeDto(), created: true });
    });
    await waitFor(() => expect(locationText()).toContain(`noteId=${NOTE_ID}`));
    await waitFor(() => expect(screen.getByTestId("study-note-editor")).toBeTruthy());
  });

  it("创建失败后重试：复用同一 requestId（不重复建）", async () => {
    const { client, list, create, get } = makeClient();
    list.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    create.mockRejectedValueOnce(new BrowserApiError(500, { code: "UNAVAILABLE", message: "boom" }));
    get.mockResolvedValue({ item: makeDto() });

    await renderPage(LIST_URL, client);
    await waitFor(() => expect(screen.getByTestId("new-note-button")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("new-note-button"));
    });
    await waitFor(() => expect(screen.getByTestId("create-error")).toBeTruthy());
    const firstRequestId = (create.mock.calls[0]![0] as { requestId: string }).requestId;

    create.mockResolvedValueOnce({ item: makeDto(), created: true });
    await act(async () => {
      fireEvent.click(screen.getByTestId("new-note-retry"));
    });
    expect((create.mock.calls[1]![0] as { requestId: string }).requestId).toBe(firstRequestId);
    await waitFor(() => expect(locationText()).toContain(`noteId=${NOTE_ID}`));
  });
});

describe("L3StudyNotesPage · 深链与未授权", () => {
  it("深链打开：GET 校验通过后渲染编辑器；列表高亮该 note；零 POST", async () => {
    const { client, list, get, create } = makeClient();
    list.mockResolvedValue({ items: [makeSummary(), makeSummary({ id: NOTE2_ID, title: "笔记二" })], total: 2, nextCursor: null });
    get.mockResolvedValue({ item: makeDto() });

    await renderPage(NOTE_URL, client);
    await waitFor(() => expect(screen.getByTestId("study-note-editor")).toBeTruthy());
    expect(get).toHaveBeenCalledWith(NOTE_ID); // 深链先经 GET 完成身份/所有权校验
    const row = screen.getAllByTestId("study-note-row").find((el) => el.getAttribute("data-note-id") === NOTE_ID)!;
    expect(row.getAttribute("data-active")).toBe("true");
    expect(create).not.toHaveBeenCalled();
  });

  it("venue 不在 note.venues：无效入口空态（提示返回），不渲染编辑器、不创建", async () => {
    const { client, list, get, create } = makeClient();
    list.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    get.mockResolvedValue({ item: makeDto({ venues: ["reading_choice"] }) }); // 不含 cloze

    await renderPage(NOTE_URL, client);
    await waitFor(() => expect(screen.getByTestId("invalid-entry")).toBeTruthy());
    expect(screen.queryByTestId("study-note-editor")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("未授权/不存在深链（404）：显示错误空态，不泄露内容、不创建替代", async () => {
    const { client, list, get, create } = makeClient();
    list.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    get.mockRejectedValue(new BrowserApiError(404, { code: "NOT_FOUND", message: "not found" }));

    await renderPage(NOTE_URL, client);
    await waitFor(() => expect(screen.getByTestId("note-error")).toBeTruthy());
    expect(screen.getByTestId("note-error").textContent).toContain("不存在或无权访问");
    expect(screen.queryByTestId("study-note-editor")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("noteId 缺少 venue：无效入口空态；零请求", async () => {
    const { client, list, get } = makeClient();
    await renderPage(`/l3?section=study-notes&noteId=${NOTE_ID}`, client);
    expect(screen.getByTestId("invalid-entry")).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("L3StudyNotesPage · 分页与筛选", () => {
  it("分页：加载更多带 cursor、跨页去重", async () => {
    const { client, list } = makeClient();
    list.mockResolvedValueOnce({ items: [makeSummary()], total: 2, nextCursor: "C1" });
    await renderPage(LIST_URL, client);
    await waitFor(() => expect(screen.getByTestId("load-more-button")).toBeTruthy());

    list.mockResolvedValueOnce({ items: [makeSummary(), makeSummary({ id: NOTE2_ID, title: "笔记二" })], total: 2, nextCursor: null });
    await act(async () => {
      fireEvent.click(screen.getByTestId("load-more-button"));
    });
    await waitFor(() => expect(screen.getAllByTestId("study-note-row")).toHaveLength(2)); // 去重
    expect((list.mock.calls[1]![0] as Record<string, unknown>).cursor).toBe("C1");
  });

  it("筛选变化清 cursor：选专题后的列表请求无 cursor", async () => {
    const { client, list, listTopics } = makeClient();
    list.mockResolvedValueOnce({ items: [makeSummary()], total: 21, nextCursor: "C1" });
    listTopics.mockResolvedValue({ items: [makeTopic()], total: 1, nextCursor: null });

    await renderPage(LIST_URL, client);
    await waitFor(() => expect(screen.getByTestId("load-more-button")).toBeTruthy());
    list.mockResolvedValueOnce({ items: [makeSummary()], total: 1, nextCursor: null }); // 第二页
    await act(async () => {
      fireEvent.click(screen.getByTestId("load-more-button"));
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    await act(async () => {
      fireEvent.click(screen.getByTestId("topic-item"));
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect((list.mock.calls[2]![0] as Record<string, unknown>).topicId).toBe(TOPIC_ID);
    expect((list.mock.calls[2]![0] as Record<string, unknown>).cursor).toBeUndefined();
  });
});

describe("L3StudyNotesPage · 离页屏障（flush）", () => {
  it("离页成功：编辑后点返回列表 → 保存确认后离开（URL 去掉 noteId、编辑器卸载）", async () => {
    const { client, list, get, save } = makeClient();
    list.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    get.mockResolvedValue({ item: makeDto() });
    save.mockResolvedValue({ item: makeDto({ version: 4 }) });

    await renderPage(NOTE_URL, client);
    await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());

    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "改过的标题" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("leave-action"));
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(locationText()).not.toContain("noteId="));
    await waitFor(() => expect(screen.queryByTestId("study-note-editor")).toBeNull());
  });

  it("离页失败：保存被确定拒绝（422）→ 留原位、显示导航错误、输入保留", async () => {
    const { client, list, get, save } = makeClient();
    list.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    get.mockResolvedValue({ item: makeDto() });
    save.mockRejectedValue(new BrowserApiError(422, { code: "VALIDATION_ERROR", message: "too long" }));

    await renderPage(NOTE_URL, client);
    await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());
    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "改过的标题" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("leave-action"));
    });
    await waitFor(() => expect(screen.getByTestId("navigation-error")).toBeTruthy());
    expect(locationText()).toContain("noteId="); // 仍在原位
    expect((screen.getByTestId("note-title") as HTMLInputElement).value).toBe("改过的标题"); // 输入保留
  });

  it("在途保存期间禁止错误导航：flush 等待保存落定后才离开", async () => {
    const { client, list, get, save } = makeClient();
    list.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    get.mockResolvedValue({ item: makeDto() });
    const saveDeferred = defer<{ item: StudyNoteDto }>();
    save.mockReturnValue(saveDeferred.promise);

    await renderPage(NOTE_URL, client);
    await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());
    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "在途内容" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("leave-action"));
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // 保存未落定：不得离开
    expect(locationText()).toContain("noteId=");
    expect(screen.getByText(/正在保存并确认未保存内容/)).toBeTruthy();

    await act(async () => {
      saveDeferred.resolve({ item: makeDto({ version: 4, title: "在途内容" }) });
    });
    await waitFor(() => expect(locationText()).not.toContain("noteId="));
  });
});

describe("L3StudyNotesPage · 冲突与归档", () => {
  it("双标签 409：停写、面板可见、不可静默离开；显式载入服务器版本后用新基线保存", async () => {
    const { client, list, get, save } = makeClient();
    list.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    get.mockResolvedValue({ item: makeDto({ version: 3 }) });
    save.mockRejectedValueOnce(new BrowserApiError(409, { code: "CONFLICT", message: "conflict" }));

    await renderPage(NOTE_URL, client);
    await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());
    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "本地修改" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("leave-action")); // 触发 flush → 409
    });
    await waitFor(() => expect(screen.getByTestId("conflict-panel")).toBeTruthy());
    expect(locationText()).toContain("noteId="); // 未离开、本地内容未覆盖

    // 显式载入服务器版本（GET 返回他端版本 5）
    get.mockResolvedValueOnce({ item: makeDto({ version: 5, title: "他端标题" }) });
    await act(async () => {
      fireEvent.click(screen.getByText("载入服务器版本"));
    });
    await waitFor(() => expect(screen.queryByTestId("conflict-panel")).toBeNull());
    expect((screen.getByTestId("note-title") as HTMLInputElement).value).toBe("他端标题");

    // 重新编辑并以新 requestId + 新基线保存
    save.mockResolvedValueOnce({ item: makeDto({ version: 6, title: "二次修改" }) });
    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "二次修改" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("leave-action"));
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    const second = save.mock.calls[1]! as [string, Record<string, unknown>];
    expect(second[1]!.expectedVersion).toBe(5); // 新基线
    expect(second[1]!.requestId).not.toBe((save.mock.calls[0]![1] as Record<string, unknown>).requestId);
  });

  it("归档：GET 最新快照 → PUT 完整快照（status=archived、expectedVersion）+ 刷新列表", async () => {
    const { client, list, get, save } = makeClient();
    list.mockResolvedValue({ items: [makeSummary({ version: 2 })], total: 1, nextCursor: null });
    get.mockResolvedValue({ item: makeDto({ version: 2 }) });
    save.mockResolvedValue({ item: makeDto({ version: 3, status: "archived" }) });

    await renderPage(LIST_URL, client);
    await waitFor(() => expect(screen.getByTestId("row-archive")).toBeTruthy());
    const listCallsBefore = list.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("row-archive"));
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [noteIdArg, input] = save.mock.calls[0]! as [string, Record<string, unknown>];
    expect(noteIdArg).toBe(NOTE_ID);
    expect(input.status).toBe("archived");
    expect(input.expectedVersion).toBe(2);
    expect(input.title).toBe("笔记标题一"); // 完整快照字段齐备
    expect(input.bodyMd).toBeDefined();
    expect(input.references).toEqual([]);
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(listCallsBefore)); // 刷新
  });
});

describe("L3StudyNotesPage · 专题协调", () => {
  it("创建专题：requestId + venue + title；列表出现；重命名用服务端版本", async () => {
    const { client, list, listTopics, createTopic, saveTopic } = makeClient();
    list.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    listTopics.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    createTopic.mockResolvedValue({ item: makeTopic({ version: 1, title: "新专题" }), created: true });

    await renderPage(LIST_URL, client);
    await waitFor(() => expect(screen.getByTestId("topic-create-input")).toBeTruthy());

    await act(async () => {
      fireEvent.change(screen.getByTestId("topic-create-input"), { target: { value: "新专题" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("topic-create-submit"));
    });
    await waitFor(() => expect(createTopic).toHaveBeenCalledTimes(1));
    const input = createTopic.mock.calls[0]![0] as { requestId: string; venue: string; title: string };
    expect(input.title).toBe("新专题");
    expect(input.venue).toBe("cloze");
    await waitFor(() => expect(screen.getByTestId("topic-item")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("topic-item"));
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2)); // 按 topicId 过滤
    expect((list.mock.calls[1]![0] as Record<string, unknown>).topicId).toBe(TOPIC_ID);

    saveTopic.mockResolvedValue({ item: makeTopic({ version: 2, title: "改名后" }) });
    await act(async () => {
      fireEvent.change(screen.getByTestId("topic-rename-input"), { target: { value: "改名后" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("topic-rename-submit"));
    });
    await waitFor(() => expect(saveTopic).toHaveBeenCalledTimes(1));
    const [topicIdArg, saveInput] = saveTopic.mock.calls[0]! as [string, Record<string, unknown>];
    expect(topicIdArg).toBe(TOPIC_ID);
    expect(saveInput.expectedVersion).toBe(1); // 来自服务端响应版本（创建返回 version=1）
  });

  it("成员移动：上移使用前一成员作为 beforeNoteId；移出经 removeTopicMember；而后刷新列表", async () => {
    const { client, list, listTopics, moveTopicMember, removeTopicMember } = makeClient();
    const rows = [makeSummary({ id: NOTE_ID, title: "成员一" }), makeSummary({ id: NOTE2_ID, title: "成员二" })];
    list.mockResolvedValue({ items: rows, total: 2, nextCursor: null });
    listTopics.mockResolvedValue({ items: [makeTopic({ version: 6 })], total: 1, nextCursor: null });
    moveTopicMember.mockResolvedValue({ item: makeTopic({ version: 7 }) });
    removeTopicMember.mockResolvedValue({ item: makeTopic({ version: 8 }) });

    await renderPage(LIST_URL, client);
    await waitFor(() => expect(screen.getByTestId("topic-item")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId("topic-item"));
    });
    await waitFor(() => expect(screen.getAllByTestId("study-note-row")).toHaveLength(2));

    const listCallsBefore = list.mock.calls.length;
    // 第二行上移：beforeNoteId = 第一行（前一成员）
    const upButtons = screen.getAllByTestId("row-move-up");
    await act(async () => {
      fireEvent.click(upButtons[1]!);
    });
    await waitFor(() => expect(moveTopicMember).toHaveBeenCalledTimes(1));
    const [topicIdArg, noteIdArg, moveInput] = moveTopicMember.mock.calls[0]! as [string, string, Record<string, unknown>];
    expect(topicIdArg).toBe(TOPIC_ID);
    expect(noteIdArg).toBe(NOTE2_ID);
    expect(moveInput.beforeNoteId).toBe(NOTE_ID); // 目标前一个成员（非本地推断全量顺序）
    expect(moveInput.expectedVersion).toBe(6); // 服务端版本
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(listCallsBefore)); // 成员变更后刷新

    // 移出成员（不删除笔记）：DELETE 经客户端方法
    const removeButtons = screen.getAllByTestId("row-remove-topic");
    await act(async () => {
      fireEvent.click(removeButtons[0]!);
    });
    await waitFor(() => expect(removeTopicMember).toHaveBeenCalledTimes(1));
    expect((removeTopicMember.mock.calls[0]! as [string, string, Record<string, unknown>])[0]).toBe(TOPIC_ID);
  });
});

// ── F4 收尾：后页专题深链自动定位 ────────────────────────────────────────────

describe("L3StudyNotesPage · 后页深链定位（F4 收尾）", () => {
  const TOPIC_A = "00000000-0000-4000-8000-000000000902";

  it("后页 topicId 深链：自动续取定位 → 显示目标标题/版本/重命名入口（无需手动翻页；探针迁移）", async () => {
    const { client, list, listTopics } = makeClient();
    list.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    listTopics
      .mockResolvedValueOnce({
        items: [makeTopic({ id: TOPIC_A, title: "首页专题" })],
        total: 2,
        nextCursor: "page-two",
      })
      .mockResolvedValueOnce({ items: [makeTopic()], total: 2, nextCursor: null });

    await renderPage(`${LIST_URL}&topicId=${TOPIC_ID}`, client);
    await waitFor(() => expect(screen.queryByTestId("topic-rename-input")).not.toBeNull());
    expect(listTopics).toHaveBeenCalledWith(expect.objectContaining({ cursor: "page-two" }));
    expect(screen.getByTestId("topic-version").textContent).toContain("v4"); // 服务端真实版本
    expect(screen.queryByTestId("topic-locate-error")).toBeNull();
  });

  it("定位成功后重命名：经真实页面入口，使用服务端 status/version（不假设 active）", async () => {
    const { client, list, listTopics, saveTopic } = makeClient();
    list.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    listTopics
      .mockResolvedValueOnce({
        items: [makeTopic({ id: TOPIC_A, title: "首页专题" })],
        total: 2,
        nextCursor: "page-two",
      })
      .mockResolvedValueOnce({
        items: [makeTopic({ status: "archived", version: 7 })],
        total: 2,
        nextCursor: null,
      });
    saveTopic.mockResolvedValue({
      item: makeTopic({ title: "改名后", status: "archived", version: 8 }),
    });

    await renderPage(`${LIST_URL}&topicId=${TOPIC_ID}`, client);
    await waitFor(() => expect(screen.queryByTestId("topic-rename-input")).not.toBeNull());

    await act(async () => {
      fireEvent.change(screen.getByTestId("topic-rename-input"), { target: { value: "改名后" } });
      fireEvent.click(screen.getByTestId("topic-rename-submit"));
    });
    await waitFor(() => expect(saveTopic).toHaveBeenCalledTimes(1));
    expect(saveTopic).toHaveBeenCalledWith(
      TOPIC_ID,
      expect.objectContaining({ expectedVersion: 7, status: "archived", title: "改名后" }),
    );
  });

  it("定位期间切换 topicId：旧代结果不消费、不报错、不混入", async () => {
    const { client, list, listTopics } = makeClient();
    list.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    const walk = defer<{ items: StudyTopicDto[]; total: number; nextCursor: string | null }>();
    listTopics
      .mockResolvedValueOnce({
        items: [makeTopic({ id: TOPIC_A, title: "首页专题" })],
        total: 2,
        nextCursor: "page-two",
      })
      .mockReturnValueOnce(walk.promise);

    const TOPIC_B = "00000000-0000-4000-8000-000000000903";
    await renderPage(`${LIST_URL}&topicId=${TOPIC_B}`, client);
    await waitFor(() => expect(screen.queryByTestId("topic-locating")).not.toBeNull());

    // 用户切换选中（topicId → A，A 在首页可见）
    await act(async () => {
      fireEvent.click(screen.getByTestId("topic-item"));
    });
    expect(locationText()).toContain(`topicId=${TOPIC_A}`);

    // 旧代定位回包迟到：不消费、不报错、不把 B 的元数据填入
    await act(async () => {
      walk.resolve({ items: [makeTopic({ id: TOPIC_B, title: "后页专题B" })], total: 2, nextCursor: null });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("topic-locate-error")).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("topic-rename-input")).not.toBeNull());
    expect((screen.getByTestId("topic-rename-input") as HTMLInputElement).value).toBe("首页专题");
  });

  it("定位取尽仍无目标：显式错误可见、零写入、不创建", async () => {
    const { client, list, listTopics, saveTopic, createTopic, moveTopicMember, removeTopicMember } = makeClient();
    list.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    listTopics
      .mockResolvedValueOnce({
        items: [makeTopic({ id: TOPIC_A, title: "首页专题" })],
        total: 2,
        nextCursor: "page-two",
      })
      .mockResolvedValueOnce({
        items: [makeTopic({ id: "00000000-0000-4000-8000-000000000905", title: "末页专题" })],
        total: 2,
        nextCursor: null,
      });

    await renderPage(`${LIST_URL}&topicId=${TOPIC_ID}`, client);
    await waitFor(() => expect(screen.queryByTestId("topic-locate-error")).not.toBeNull());
    expect(screen.getByTestId("topic-locate-error").textContent).toContain("不存在");
    expect(saveTopic).not.toHaveBeenCalled();
    expect(createTopic).not.toHaveBeenCalled();
    expect(moveTopicMember).not.toHaveBeenCalled();
    expect(removeTopicMember).not.toHaveBeenCalled();
  });
});
