/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 学习笔记编辑器组件测试（Task 07）——覆盖真实使用路径的关键行为：
 * 初始化仅 GET（不创建）/ 加载失败重试 / StrictMode 双挂载 / 800ms 防抖 + IME /
 * A/B 交错不回退不误标 / 409 冲突恢复（复制 + 显式载入）/ 复制失败可见备选 /
 * marker 预检阻止 PUT / 导航辅助失败留原位 / 引用占位只读渲染。
 *
 * 注：本文件用真实组件 + 注入 fake client（非真实浏览器/PG；后者见联调宿主与 E2E）。
 */
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import type { StudyNotesClient } from "@/frontend/api/studyNotesClient";
import { StudyNoteEditor } from "@/frontend/components/studyNotes/StudyNoteEditor";
import { useStudyNoteEditor, type UseStudyNoteEditorResult } from "@/frontend/hooks/useStudyNoteEditor";
import type { StudyNoteDto } from "@/domain/l3-study-notes";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const NOTE_ID = "00000000-0000-4000-8000-000000000701";
const REF_ID = "00000000-0000-4000-8000-000000000801";
const REF2_ID = "00000000-0000-4000-8000-000000000802";
const SOURCE_ID = "00000000-0000-4000-8000-000000000901";
const QUESTION_ID = "00000000-0000-4000-8000-000000000902";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** body 与 references 集合一致的合法 DTO（两条引用：1 current + 1 unavailable）。 */
function makeDto(overrides: Partial<StudyNoteDto> = {}): StudyNoteDto {
  const bodyMd = `正文一\n\n[[ref:${REF_ID}]]\n\n正文二\n\n[[ref:${REF2_ID}]]\n\n正文三`;
  return {
    id: NOTE_ID,
    title: "初始标题",
    bodyMd,
    venues: ["cloze"],
    pinned: false,
    status: "active",
    version: 3,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:30:00.000Z",
    references: [
      {
        id: REF_ID,
        target: { kind: "source", sourceId: SOURCE_ID },
        status: "current",
        capturedAt: "2026-09-20T00:10:00.000Z",
        displaySnapshot: { kind: "source", title: "来源A", excerpt: "摘录A" },
        liveTitle: "来源A",
      },
      {
        id: REF2_ID,
        target: { kind: "question", questionId: QUESTION_ID },
        status: "unavailable",
        capturedAt: "2026-09-20T00:11:00.000Z",
        displaySnapshot: { kind: "question", stem: "题干B", options: [], questionType: "cloze", sourceTitle: null },
        liveTitle: null,
      },
    ],
    ...overrides,
  };
}

interface ClientMocks {
  client: StudyNotesClient;
  get: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
}

function makeClient(): ClientMocks {
  const get = vi.fn();
  const save = vi.fn();
  const client = { get, save } as unknown as StudyNotesClient;
  return { client, get, save };
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

async function renderEditor(client: StudyNotesClient, options: { strict?: boolean } = {}): Promise<void> {
  const element = createElement(StudyNoteEditor, { noteId: NOTE_ID, client });
  await act(async () => {
    root.render(options.strict ? createElement(StrictMode, null, element) : element);
  });
}

describe("StudyNoteEditor · 加载", () => {
  it("初始化仅 GET：渲染内容，不产生保存/创建请求", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    await renderEditor(client);

    await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());
    expect(get).toHaveBeenCalledTimes(1);
    expect((get.mock.calls[0] as unknown[])[0]).toBe(NOTE_ID);
    expect(save).not.toHaveBeenCalled();
    expect((screen.getByTestId("note-title") as HTMLInputElement).value).toBe("初始标题");
    expect((screen.getByTestId("note-body") as HTMLTextAreaElement).value).toContain(`[[ref:${REF_ID}]]`);
  });

  it("加载失败：错误 + 重试（不落回空笔记）；重试成功后正常进入", async () => {
    const { client, get } = makeClient();
    get.mockRejectedValueOnce(new BrowserApiError(404, { error: "not found", code: "NOT_FOUND" }));
    await renderEditor(client);

    await waitFor(() => expect(screen.getByText(/笔记不存在或已被移除/)).toBeTruthy());
    expect(screen.queryByTestId("note-title")).toBeNull(); // 不以空笔记顶替

    get.mockResolvedValueOnce({ item: makeDto() });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    });
    await waitFor(() => expect((screen.getByTestId("note-title") as HTMLInputElement).value).toBe("初始标题"));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("StrictMode 双挂载：加载正常、可编辑、保存成功", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    save.mockResolvedValue({ item: makeDto({ version: 4, updatedAt: "2026-09-20T02:00:00.000Z" }) });
    await renderEditor(client, { strict: true });

    await waitFor(() => expect((screen.getByTestId("note-title") as HTMLInputElement).value).toBe("初始标题"));
    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "strict 编辑" } });
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toContain("已保存"));
  });
});

describe("StudyNoteEditor · 编辑与保存", () => {
  it("输入 → 800ms 防抖 → 保存成功；载荷为完整快照（引用全 keep，含 unavailable）", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    save.mockResolvedValue({ item: makeDto({ version: 4, updatedAt: "2026-09-20T02:00:00.000Z" }) });
    await renderEditor(client);
    await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());

    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "新标题" } });
    });
    expect(save).not.toHaveBeenCalled(); // 防抖期内不发送

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [noteIdArg, input] = save.mock.calls[0] as [string, Record<string, unknown>];
    expect(noteIdArg).toBe(NOTE_ID);
    expect(input.title).toBe("新标题");
    expect(input.expectedVersion).toBe(3);
    expect(typeof input.requestId).toBe("string");
    expect(input.venues).toEqual(["cloze"]);
    expect(input.pinned).toBe(false);
    expect(input.status).toBe("active");
    // 引用保全：全部 keep（含 unavailable），不重新 capture
    expect(input.references).toEqual([
      { id: REF_ID, action: "keep" },
      { id: REF2_ID, action: "keep" },
    ]);

    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toContain("已保存"));
    expect(screen.getByTestId("save-state").textContent).not.toContain("未保存");
  });

  it("IME：合成期间不发送；compositionend 后防抖补发", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    save.mockResolvedValue({ item: makeDto({ version: 4, updatedAt: "t" }) });
    await renderEditor(client);
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());

    // 变更仍保持 marker 集合一致（避免命中预检，聚焦 IME 语义）
    const imeBody = `正文一拼\n\n[[ref:${REF_ID}]]\n\n正文二\n\n[[ref:${REF2_ID}]]\n\n正文三`;
    const body = screen.getByTestId("note-body");
    await act(async () => {
      fireEvent.compositionStart(body);
      fireEvent.change(body, { target: { value: imeBody } });
    });
    await new Promise((resolve) => setTimeout(resolve, 950)); // 超过防抖时长
    expect(save).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.compositionEnd(body);
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [, input] = save.mock.calls[0] as [string, Record<string, unknown>];
    expect(input.bodyMd).toBe(imeBody);
  });

  it("A 在途输入 B：A 回包不覆盖 B、不把 B 标已保存；B 以新 requestId+新版本发送", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    const first = defer<{ item: StudyNoteDto }>();
    const second = defer<{ item: StudyNoteDto }>();
    save.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await renderEditor(client);
    await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());

    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "A" } });
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });

    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "AB" } });
    });
    expect((screen.getByTestId("note-title") as HTMLInputElement).value).toBe("AB");

    await act(async () => {
      first.resolve({ item: makeDto({ version: 4, updatedAt: "2026-09-20T04:00:00.000Z" }) });
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect((screen.getByTestId("note-title") as HTMLInputElement).value).toBe("AB"); // 不被 A 回包覆盖
    expect(screen.getByTestId("save-state").textContent).not.toContain("已保存"); // B 尚未确认

    const [, firstInput] = save.mock.calls[0] as [string, Record<string, unknown>];
    const [, secondInput] = save.mock.calls[1] as [string, Record<string, unknown>];
    expect(secondInput.title).toBe("AB");
    expect(secondInput.expectedVersion).toBe(4); // A 确认后的新版本
    expect(secondInput.requestId).not.toBe(firstInput.requestId); // 新 requestId

    await act(async () => {
      second.resolve({ item: makeDto({ version: 5, updatedAt: "2026-09-20T04:05:00.000Z" }) });
    });
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toContain("已保存"));
  });

  it("marker 预检：手删 marker 行阻止 PUT（无请求）+ 面板提示；修复后自动恢复保存", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    save.mockResolvedValue({ item: makeDto({ version: 4, updatedAt: "t" }) });
    await renderEditor(client);
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());

    const broken = `正文一\n\n[[ref:${REF_ID}]]\n\n正文二\n\n正文三`; // 删除了 REF2 marker
    await act(async () => {
      fireEvent.change(screen.getByTestId("note-body"), { target: { value: broken } });
    });
    await waitFor(() => expect(screen.getByTestId("invalid-panel")).toBeTruthy(), { timeout: 3000 });
    expect(save).not.toHaveBeenCalled(); // 阻止 PUT
    expect(screen.getByTestId("invalid-panel").textContent).toContain("引用");

    await act(async () => {
      fireEvent.change(screen.getByTestId("note-body"), { target: { value: makeDto().bodyMd } });
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await waitFor(() => expect(screen.queryByTestId("invalid-panel")).toBeNull());
  });
});

describe("StudyNoteEditor · 冲突恢复", () => {
  it("409 冲突：面板 → 复制本地内容 → 载入服务器版本 → 显示服务器内容 → 以新基线保存", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValueOnce({ item: makeDto() });
    save.mockRejectedValueOnce(
      new BrowserApiError(409, { error: "conflict", code: "CONFLICT", details: { noteId: NOTE_ID, currentVersion: 9 } }),
    );
    const clipboardWrite = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboardWrite }, configurable: true });

    await renderEditor(client);
    await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());
    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "本地改" } });
    });
    await waitFor(() => expect(screen.getByTestId("conflict-panel")).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByTestId("conflict-panel").textContent).toContain("服务器版本 9");
    expect((screen.getByTestId("note-title") as HTMLInputElement).value).toBe("本地改"); // 本地输入保留

    // 复制本地内容（含标题 / 归属 / 引用清单）
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制本地内容" }));
    });
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    const copied = clipboardWrite.mock.calls[0]![0] as string;
    expect(copied).toContain("本地改");
    expect(copied).toContain("归属：cloze");
    expect(copied).toContain("引用清单（2 条）");

    // 显式载入服务器版本
    get.mockResolvedValueOnce({
      item: makeDto({ title: "服务器标题", version: 9, updatedAt: "2026-09-20T05:00:00.000Z" }),
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "载入服务器版本" }));
    });
    await waitFor(() => expect((screen.getByTestId("note-title") as HTMLInputElement).value).toBe("服务器标题"));
    expect(screen.queryByTestId("conflict-panel")).toBeNull();

    // 载入后重新编辑 → 以新基线（版本 9）保存
    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "载入后重写" } });
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2), { timeout: 3000 });
    const [, input] = save.mock.calls[1] as [string, Record<string, unknown>];
    expect(input.title).toBe("载入后重写");
    expect(input.expectedVersion).toBe(9);
  });

  it("复制失败：给出可见文本备选（含标题/归属/引用清单），不丢信息", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValueOnce({ item: makeDto() });
    save.mockRejectedValueOnce(
      new BrowserApiError(409, { error: "conflict", code: "CONFLICT", details: { currentVersion: 9 } }),
    );
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
      configurable: true,
    });

    await renderEditor(client);
    await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());
    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "本地内容X" } });
    });
    await waitFor(() => expect(screen.getByTestId("conflict-panel")).toBeTruthy(), { timeout: 3000 });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制本地内容" }));
    });
    const fallback = await waitFor(() => screen.getByTestId("copy-fallback") as HTMLTextAreaElement);
    expect(fallback.value).toContain("本地内容X");
    expect(fallback.value).toContain("归属：cloze");
    expect(fallback.value).toContain("引用清单");
  });
});

describe("StudyNoteEditor · 导航辅助（hook 宿主）", () => {
  function makeNavHost(client: StudyNotesClient, onNavigated: () => void) {
    return function NavHost(): ReturnType<typeof createElement> {
      const editor = useStudyNoteEditor({ noteId: NOTE_ID, client });
      return createElement(
        "div",
        null,
        createElement("button", { onClick: () => void editor.requestNavigation(() => { onNavigated(); }) }, "goto"),
        createElement("button", { onClick: () => editor.setTitle("changed") }, "change"),
        editor.navigationError ? createElement("span", { "data-testid": "nav-error" }, editor.navigationError) : null,
      );
    };
  }

  it("保存失败时不导航并显示原因（留原位）", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    save.mockRejectedValueOnce(new BrowserApiError(422, { error: "invalid", code: "VALIDATION_ERROR" }));
    const onNavigated = vi.fn();
    const NavHost = makeNavHost(client, onNavigated);

    await act(async () => {
      root.render(createElement(NavHost));
    });
    await waitFor(() => expect(screen.getByText("change")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText("change"));
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });

    await act(async () => {
      fireEvent.click(screen.getByText("goto"));
    });
    await waitFor(() => expect(screen.getByTestId("nav-error")).toBeTruthy());
    expect(onNavigated).not.toHaveBeenCalled();
  });

  it("有未保存内容时先 flush 成功再导航", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    save.mockResolvedValue({ item: makeDto({ version: 4, updatedAt: "t" }) });
    const onNavigated = vi.fn();
    const NavHost = makeNavHost(client, onNavigated);

    await act(async () => {
      root.render(createElement(NavHost));
    });
    await waitFor(() => expect(screen.getByText("change")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText("change"));
    });
    // 不等 800ms 防抖，直接请求导航：requestNavigation 须先 flush 成功才离开
    await act(async () => {
      fireEvent.click(screen.getByText("goto"));
    });
    await waitFor(() => expect(onNavigated).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("StudyNoteEditor · 引用占位预览", () => {
  it("预览：marker 渲染为只读占位（unavailable 显示已失效），不注入 HTML", async () => {
    const { client, get } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    await renderEditor(client);
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "预览" }));
    });
    const placeholders = screen.getAllByTestId("reference-placeholder");
    expect(placeholders.length).toBe(2);
    expect(placeholders[0]!.textContent).toContain("来源A");
    expect(placeholders[1]!.textContent).toContain("引用已失效");
    expect(screen.queryByTestId("note-body")).toBeNull(); // 预览态替换编辑区
  });
});

describe("StudyNoteEditor · R1 服务端确定拒绝恢复", () => {
  it("R1：真实拒绝分类可读（非『网络或服务异常』）→ 修正后重试提交最新内容", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    save.mockRejectedValueOnce(
      new BrowserApiError(422, { error: "标题超过上限", code: "VALIDATION_ERROR", details: { field: "title" } }),
    );
    await renderEditor(client);
    await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());

    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "x".repeat(121) } });
    });
    await waitFor(() => expect(screen.getByTestId("error-panel")).toBeTruthy(), { timeout: 3000 });
    const panel = screen.getByTestId("error-panel");
    expect(panel.textContent).toContain("标题超过上限"); // 服务端可读原因（旧实现：无法读取）
    expect(panel.textContent).toContain("服务端拒绝"); // 分类文案（旧实现：无分类）
    expect(panel.textContent).not.toContain("网络或服务异常"); // 旧实现：一律网络/服务异常

    // 修正为合法标题 → 重试保存 → 提交最新内容
    save.mockResolvedValueOnce({ item: makeDto({ version: 4, updatedAt: "2026-09-20T09:00:00.000Z" }) });
    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "修正标题" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    });
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toContain("已保存"), { timeout: 3000 });
    const [, secondInput] = save.mock.calls[1] as [string, Record<string, unknown>];
    expect(secondInput.title).toBe("修正标题"); // 旧实现：重发 121 字旧载荷 → 再失败
  });
});

describe("StudyNoteEditor · R3 reload 保护未保存输入", () => {
  const NOTE_B_ID = "00000000-0000-4000-8000-000000000702";

  function HookHost(props: {
    client: StudyNotesClient;
    noteId: string;
    holder: { current: UseStudyNoteEditorResult | null };
  }): ReturnType<typeof createElement> | null {
    const editor = useStudyNoteEditor({ noteId: props.noteId, client: props.client });
    props.holder.current = editor;
    return null;
  }

  it("R3-A：dirty 时 reload 不销毁控制器、不丢本地输入（reload 仅用于初始化失败重试）", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    save.mockResolvedValue({ item: makeDto({ version: 4, updatedAt: "2026-09-20T10:00:00.000Z" }) });
    const holder: { current: UseStudyNoteEditorResult | null } = { current: null };

    await act(async () => {
      root.render(createElement(HookHost, { client, noteId: NOTE_ID, holder }));
    });
    await waitFor(() => expect(holder.current?.snapshot).not.toBeNull());

    await act(async () => {
      holder.current!.setTitle("local unsaved");
    });
    expect(holder.current!.snapshot!.edit.title).toBe("local unsaved");

    await act(async () => {
      holder.current!.reload();
    });
    await waitFor(() => expect(holder.current?.snapshot).not.toBeNull());
    expect(holder.current!.snapshot!.edit.title).toBe("local unsaved"); // 旧实现：回服务器值（丢输入）
    expect(get).toHaveBeenCalledTimes(1); // 不重复取数
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 }); // 控制器仍活：可自动保存
    expect((save.mock.calls[0] as [string, Record<string, unknown>])[1].title).toBe("local unsaved");
  });

  it("R3-B：在途保存时 reload 不中断、不丢在途内容", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    const pending = defer<{ item: StudyNoteDto }>();
    save.mockReturnValueOnce(pending.promise);
    const holder: { current: UseStudyNoteEditorResult | null } = { current: null };

    await act(async () => {
      root.render(createElement(HookHost, { client, noteId: NOTE_ID, holder }));
    });
    await waitFor(() => expect(holder.current?.snapshot).not.toBeNull());

    await act(async () => {
      holder.current!.setTitle("在途内容");
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });

    await act(async () => {
      holder.current!.reload();
    });
    await act(async () => {
      pending.resolve({ item: makeDto({ version: 4, updatedAt: "2026-09-20T10:01:00.000Z" }) });
    });
    await waitFor(() => expect(holder.current!.snapshot!.state).toBe("idle"));
    expect(holder.current!.snapshot!.edit.title).toBe("在途内容"); // 旧实现：新控制器回服务器标题
    expect(get).toHaveBeenCalledTimes(1); // 旧实现：reload 触发第二次 GET
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("R3-C：error 态 reload 保留失败态与本地输入", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    save.mockRejectedValueOnce(new BrowserApiError(422, { error: "invalid", code: "VALIDATION_ERROR" }));
    const holder: { current: UseStudyNoteEditorResult | null } = { current: null };

    await act(async () => {
      root.render(createElement(HookHost, { client, noteId: NOTE_ID, holder }));
    });
    await waitFor(() => expect(holder.current?.snapshot).not.toBeNull());
    await act(async () => {
      holder.current!.setTitle("失败内容");
    });
    await waitFor(() => expect(holder.current!.snapshot!.state).toBe("error"), { timeout: 3000 });

    await act(async () => {
      holder.current!.reload();
    });
    await waitFor(() => expect(holder.current?.snapshot).not.toBeNull());
    expect(holder.current!.snapshot!.state).toBe("error"); // 旧实现：重建后 idle
    expect(holder.current!.snapshot!.edit.title).toBe("失败内容");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("R3-C2：conflict 态 reload 保留冲突态（不作重置后门）", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    save.mockRejectedValueOnce(
      new BrowserApiError(409, { error: "conflict", code: "CONFLICT", details: { currentVersion: 9 } }),
    );
    const holder: { current: UseStudyNoteEditorResult | null } = { current: null };

    await act(async () => {
      root.render(createElement(HookHost, { client, noteId: NOTE_ID, holder }));
    });
    await waitFor(() => expect(holder.current?.snapshot).not.toBeNull());
    await act(async () => {
      holder.current!.setTitle("本地改");
    });
    await waitFor(() => expect(holder.current!.snapshot!.state).toBe("conflict"), { timeout: 3000 });

    await act(async () => {
      holder.current!.reload();
    });
    await waitFor(() => expect(holder.current?.snapshot).not.toBeNull());
    expect(holder.current!.snapshot!.state).toBe("conflict"); // 旧实现：重建后 idle（丢弃冲突上下文）
    expect(holder.current!.snapshot!.edit.title).toBe("本地改");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("R3-D：换 note 正常重新加载；旧笔记迟到保存响应不污染新笔记", async () => {
    const { client, get, save } = makeClient();
    get.mockImplementation(async (id: string) =>
      id === NOTE_ID
        ? { item: makeDto() }
        : { item: makeDto({ id: NOTE_B_ID, title: "乙笔记", version: 1 }) },
    );
    const pendingA = defer<{ item: StudyNoteDto }>();
    save.mockReturnValueOnce(pendingA.promise);
    const holder: { current: UseStudyNoteEditorResult | null } = { current: null };

    await act(async () => {
      root.render(createElement(HookHost, { client, noteId: NOTE_ID, holder }));
    });
    await waitFor(() => expect(holder.current?.snapshot).not.toBeNull());
    await act(async () => {
      holder.current!.setTitle("甲改");
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });

    // 换 note：重新加载乙
    await act(async () => {
      root.render(createElement(HookHost, { client, noteId: NOTE_B_ID, holder }));
    });
    await waitFor(() => expect(holder.current!.snapshot?.edit.title).toBe("乙笔记"));

    // 旧笔记的迟到保存响应 → 不得污染新笔记
    await act(async () => {
      pendingA.resolve({ item: makeDto({ version: 9, title: "甲已保存" }) });
    });
    expect(holder.current!.snapshot!.edit.title).toBe("乙笔记");
  });
});

describe("StudyNoteEditor · R2 在途 IME 交错与导航协同", () => {
  it("R2 组件级：A 在途进入组合 → A 响应后不发 B、状态未保存 → compositionend 后发送完整 B", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    const first = defer<{ item: StudyNoteDto }>();
    const second = defer<{ item: StudyNoteDto }>();
    save.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await renderEditor(client);
    await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());

    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "A" } });
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });

    // A 在途：开始组合并输入未完成 B
    await act(async () => {
      fireEvent.compositionStart(screen.getByTestId("note-title"));
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "未完成B" } });
    });

    await act(async () => {
      first.resolve({ item: makeDto({ version: 4, updatedAt: "2026-09-20T11:00:00.000Z" }) });
      await new Promise((resolve) => setTimeout(resolve, 60)); // 等待 A 确认流程处理完
    });
    expect(save).toHaveBeenCalledTimes(1); // 旧实现：A 确认后立刻发送组合中的 B（2 次）
    expect(screen.getByTestId("save-state").textContent).not.toContain("已保存"); // B 未保存

    await act(async () => {
      fireEvent.compositionEnd(screen.getByTestId("note-title"));
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect((save.mock.calls[1] as [string, Record<string, unknown>])[1].title).toBe("未完成B");

    await act(async () => {
      second.resolve({ item: makeDto({ version: 5, updatedAt: "2026-09-20T11:05:00.000Z" }) });
    });
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toContain("已保存"));
  });

  function makeImeNavHost(client: StudyNotesClient, onNavigated: () => void) {
    return function ImeNavHost(): ReturnType<typeof createElement> {
      const editor = useStudyNoteEditor({ noteId: NOTE_ID, client });
      return createElement(
        "div",
        null,
        createElement("button", { onClick: () => void editor.requestNavigation(() => { onNavigated(); }) }, "goto"),
        createElement("button", { onClick: () => editor.onCompositionStart() }, "ime-start"),
        createElement("button", { onClick: () => editor.onCompositionEnd() }, "ime-end"),
        createElement("button", { onClick: () => editor.setTitle("组合中内容") }, "change"),
        editor.navigationLocked ? createElement("span", { "data-testid": "nav-locked" }, "locked") : null,
        editor.navigationError ? createElement("span", { "data-testid": "nav-error" }, editor.navigationError) : null,
      );
    };
  }

  it("R2 导航协同：组合中导航被明确拒绝（不锁死输入、不永久 pending）；完成组合保存后可导航", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    save.mockResolvedValue({ item: makeDto({ version: 4, updatedAt: "t" }) });
    const onNavigated = vi.fn();
    const Host = makeImeNavHost(client, onNavigated);

    await act(async () => {
      root.render(createElement(Host));
    });
    await waitFor(() => expect(screen.getByText("goto")).toBeTruthy());

    // 开始组合并输入（未完成）
    await act(async () => {
      fireEvent.click(screen.getByText("ime-start"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("change"));
    });

    // 组合中导航 → 拒绝并提示，不进入锁等待
    await act(async () => {
      fireEvent.click(screen.getByText("goto"));
    });
    await waitFor(() => expect(screen.getByTestId("nav-error")).toBeTruthy());
    expect(screen.getByTestId("nav-error").textContent).toContain("输入法");
    expect(onNavigated).not.toHaveBeenCalled();
    expect(screen.queryByTestId("nav-locked")).toBeNull(); // 未锁死输入（可完成组合）

    // 完成组合 → 保存 → 导航成功（不永久 pending）
    await act(async () => {
      fireEvent.click(screen.getByText("ime-end"));
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await act(async () => {
      fireEvent.click(screen.getByText("goto"));
    });
    await waitFor(() => expect(onNavigated).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });
});

describe("StudyNoteEditor · R4 预览 marker 识别与域合同一致", () => {
  it("R4-A：缩进代码中的 marker 是代码（域合同），预览不显示占位卡", async () => {
    const bodyMd = `正文开头\n\n    [[ref:${REF_ID}]]\n\n正文结尾`;
    const { client, get } = makeClient();
    get.mockResolvedValue({ item: makeDto({ bodyMd, references: [] }) });
    await renderEditor(client);
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "预览" }));
    });
    expect(screen.queryAllByTestId("reference-placeholder").length).toBe(0); // 旧实现：误识别为 1
    // 代码文本保留（真实渲染；不退化）
    await waitFor(
      () => expect(screen.getByTestId("note-preview").textContent).toContain("[[ref:"),
      { timeout: 3000 },
    );
  });

  it("R4-B：合法独立顶层 marker 变占位卡（大写 UUID 归一小写匹配快照）；无快照显示未找到", async () => {
    const upper = REF_ID.toUpperCase();
    const bodyMd = `正文\n\n[[ref:${upper}]]\n\n[[ref:${REF2_ID}]]\n\n结尾`;
    const { client, get } = makeClient();
    get.mockResolvedValue({
      item: makeDto({
        bodyMd,
        references: [makeDto().references[0]!], // 仅 REF_ID 有快照；REF2 缺失
      }),
    });
    await renderEditor(client);
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "预览" }));
    });
    const placeholders = screen.getAllByTestId("reference-placeholder");
    expect(placeholders.length).toBe(2);
    expect(placeholders[0]!.getAttribute("data-ref-id")).toBe(REF_ID); // 小写归一
    expect(placeholders[0]!.textContent).toContain("来源A"); // 快照匹配（大小写不敏感）
    expect(placeholders[1]!.getAttribute("data-ref-id")).toBe(REF2_ID);
    expect(placeholders[1]!.textContent).toContain("未找到快照"); // 缺失引用如实展示
  });

  it("R4-C：HTML/XSS 净化保持（预览不注入脚本/事件属性）", async () => {
    const bodyMd = `正文\n\n<script>window.__xss=1</script>\n\n<img src=x onerror="window.__xss=2">\n\n[[ref:${REF_ID}]]`;
    const { client, get } = makeClient();
    get.mockResolvedValue({ item: makeDto({ bodyMd, references: [makeDto().references[0]!] }) });
    await renderEditor(client);
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "预览" }));
    });
    await waitFor(
      () => expect(screen.getByTestId("note-preview").textContent).toContain("正文"),
      { timeout: 3000 },
    );
    const preview = screen.getByTestId("note-preview");
    expect(preview.querySelector("script")).toBeNull();
    expect(preview.querySelector("img[onerror]")).toBeNull();
    expect(preview.querySelectorAll('[data-testid="reference-placeholder"]').length).toBe(1);
  });
});
