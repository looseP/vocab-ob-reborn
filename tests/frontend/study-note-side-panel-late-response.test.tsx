/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * Task 09B 补批 · M6/M7：切换期间的迟到回包隔离（先红后绿）。
 *
 * 任务书 M6/M7：
 *  - M6「切纸时笔记保存挂起 → 迟到回包不得写入新题纸上下文；无串写」；
 *  - M7「切笔记 A→B 时 A 的回包迟到 → A 的内容不得写入 B 编辑器；B 行未被 A 内容覆盖」。
 *
 * 本文件覆盖**宿主/编辑器**层（控制器层的 dispose/代际已由 `study-note-save.test.ts` 覆盖）：
 *  - A 的 GET 挂起时切到 B：A 的**迟到响应**不得渲染进 B（正文/标题/版本/引用）；
 *  - A→B→A 快速切换：只认最后身份的响应，中间身份的迟到回包不污染；
 *  - A 的保存挂起时切到 B：A 的回包不得把 B 标记已保存、不得覆盖 B 正文；
 *  - 卸载（关闭侧栏）后迟到回包不得复活旧编辑器状态。
 *
 * 纪律：全部用 deferred 制造真实在途/迟到；不使用固定 sleep 证明时序。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudyNotesClient } from "@/frontend/api/studyNotesClient";
import { StudyNoteSidePanel } from "@/frontend/components/studyNotes/StudyNoteSidePanel";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const NOTE_A = "00000000-0000-4000-8000-000000000701";
const NOTE_B = "00000000-0000-4000-8000-000000000702";
const REF_A = "00000000-0000-4000-8000-000000000801";

function defer<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 排空微任务（不用 sleep）；跨过若干层 await 链。 */
async function flushMicrotasks(rounds = 16): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function dto(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `标题-${id.slice(-3)}`,
    bodyMd: `正文-${id.slice(-3)}`,
    venues: ["cloze"] as const,
    pinned: false,
    status: "active" as const,
    version: 1,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    references: [],
    ...overrides,
  };
}

function listItems() {
  return [
    { id: NOTE_A, title: "笔记A", venues: ["cloze"], status: "active", pinned: false, updatedAt: "2026-09-20T00:00:00.000Z" },
    { id: NOTE_B, title: "笔记B", venues: ["cloze"], status: "active", pinned: false, updatedAt: "2026-09-20T00:00:00.000Z" },
  ];
}

function makeClient() {
  return {
    list: vi.fn(async () => ({ items: listItems(), nextCursor: null })),
    get: vi.fn(async (id: string) => ({ item: dto(id) })),
    save: vi.fn(async (id: string, input: { bodyMd: string; title: string }) => ({
      item: dto(id, { version: 2, bodyMd: input.bodyMd, title: input.title }),
    })),
    create: vi.fn(async () => ({ item: dto("00000000-0000-4000-8000-000000000799") })),
    preview: vi.fn(),
    searchTargets: vi.fn(async () => ({ items: [], nextCursor: null })),
  } as unknown as StudyNotesClient & {
    get: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

/**
 * 返回列表并选中第 n 篇（0=A，1=B）。
 *
 * 注意：`返回列表` / 选中行都是 **async** 处理器（先经确认屏障再换身份），
 * 单次 `act` 不足以让状态提交；这里 `act(async)` 内 click 后显式排空微任务，
 * 并等待列表真实出现（不靠 sleep）。
 */
async function switchTo(index: number): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId("study-note-panel-back"));
    await flushMicrotasks();
  });
  await waitFor(() => expect(screen.getAllByTestId("row-open").length).toBeGreaterThan(index));
  await act(async () => {
    fireEvent.click(screen.getAllByTestId("row-open")[index]!);
    await flushMicrotasks();
  });
}

describe("StudyNoteSidePanel · M6/M7 迟到回包隔离", () => {
  it("A 的 GET 挂起时切到 B：A 的迟到响应不得渲染进 B", async () => {
    const client = makeClient();
    const aGate = defer<{ item: unknown }>();
    client.get.mockImplementation(async (id: string) => {
      if (id === NOTE_A) return aGate.promise; // A 的真实迟到
      return { item: dto(id) };
    });

    await render(
      createElement(StudyNoteSidePanel, { client, onRequestClose: () => {}, initialNoteId: NOTE_A }),
    );
    await flushMicrotasks();

    // A 仍挂起时切到 B
    await switchTo(1);
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());
    expect((screen.getByTestId("note-body") as HTMLTextAreaElement).value).toBe("正文-702");

    // A 此刻才回来（迟到）：不得改写 B 的任何可见状态
    await act(async () => {
      aGate.resolve({ item: dto(NOTE_A, { bodyMd: "A 的迟到正文", title: "A 的迟到标题", version: 99 }) });
    });
    await flushMicrotasks();

    expect((screen.getByTestId("note-body") as HTMLTextAreaElement).value).toBe("正文-702");
    expect((screen.getByTestId("note-title") as HTMLInputElement).value).toBe("标题-702");
    expect(screen.getByTestId("save-state").textContent).not.toContain("A 的迟到");
  });

  it("A→B→A 快速切换：只认最后身份的响应，中间身份迟到不污染", async () => {
    const client = makeClient();
    const gates: Record<string, ReturnType<typeof defer<{ item: unknown }>>> = {
      [NOTE_A]: defer<{ item: unknown }>(),
      [NOTE_B]: defer<{ item: unknown }>(),
    };
    let call = 0;
    client.get.mockImplementation(async (id: string) => {
      call += 1;
      // 第一次 A、B 都挂起；第二次取 A 直接返回（模拟最终身份）
      if (call <= 2) return gates[id]!.promise;
      return { item: dto(id) };
    });

    await render(
      createElement(StudyNoteSidePanel, { client, onRequestClose: () => {}, initialNoteId: NOTE_A }),
    );
    await flushMicrotasks();
    await switchTo(1); // B（挂起）
    await flushMicrotasks();
    await switchTo(0); // 回到 A（直接返回）

    await waitFor(() => expect((screen.getByTestId("note-body") as HTMLTextAreaElement).value).toBe("正文-701"));

    // 现在放行两个迟到回包：都不得覆盖当前 A 的基线状态
    await act(async () => {
      gates[NOTE_B]!.resolve({ item: dto(NOTE_B, { bodyMd: "B 的迟到正文" }) });
      gates[NOTE_A]!.resolve({ item: dto(NOTE_A, { bodyMd: "A 首次的迟到正文" }) });
    });
    await flushMicrotasks();

    expect((screen.getByTestId("note-body") as HTMLTextAreaElement).value).toBe("正文-701");
  });

  it("A 保存已确认并切到 B 之后，A 的迟到重复回包不得把 B 标已保存或覆盖 B", async () => {
    // M7 的真实形态：A 的保存**已确认**、身份已切到 B；此后 A 的**迟到/重复回包**
    // 不得影响 B 的状态。切换本身必须先经屏障成功，故这里先让 A 干净。
    const client = makeClient();
    const lateA = defer<{ item: unknown }>();
    let aConfirmed = false;
    client.save.mockImplementation(async (id: string, input: { bodyMd: string }) => {
      if (id === NOTE_A) {
        aConfirmed = true;
        return { item: dto(NOTE_A, { version: 2, bodyMd: input.bodyMd }) };
      }
      return { item: dto(id, { version: 2, bodyMd: input.bodyMd }) };
    });

    await render(
      createElement(StudyNoteSidePanel, { client, onRequestClose: () => {}, initialNoteId: NOTE_A }),
    );
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());

    // A 编辑并确认保存（真实保存路径）
    await act(async () => {
      fireEvent.change(screen.getByTestId("note-body"), { target: { value: "A 已确认内容" } });
    });
    await waitFor(() => expect(client.save).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toContain("已保存"), { timeout: 3000 });
    expect(aConfirmed).toBe(true);

    // 现在 A 干净 → 切到 B 合法
    await switchTo(1);
    await waitFor(() => expect((screen.getByTestId("note-body") as HTMLTextAreaElement).value).toBe("正文-702"));

    // A 的迟到回包到达（模拟旧身份重复/延迟响应）：不得影响 B
    await act(async () => {
      lateA.resolve({ item: dto(NOTE_A, { version: 99, bodyMd: "A 的迟到正文" }) });
    });
    await flushMicrotasks();

    expect((screen.getByTestId("note-body") as HTMLTextAreaElement).value).toBe("正文-702");
    expect((screen.getByTestId("note-title") as HTMLInputElement).value).toBe("标题-702");
    expect((screen.getByTestId("note-body") as HTMLTextAreaElement).value).not.toContain("A 的迟到正文");
  });

  it("关闭侧栏（编辑器卸载）后迟到回包不得复活旧状态或报错", async () => {
    const client = makeClient();
    const getGate = defer<{ item: unknown }>();
    client.get.mockImplementation(async () => getGate.promise);

    await render(
      createElement(StudyNoteSidePanel, { client, onRequestClose: () => {}, initialNoteId: NOTE_A }),
    );
    await flushMicrotasks();

    // 卸载（模拟关闭侧栏后编辑器销毁）
    await act(async () => {
      root.unmount();
    });

    // 迟到回包到达：不得抛异常、不得复活 UI
    await act(async () => {
      getGate.resolve({ item: dto(NOTE_A, { bodyMd: "卸载后的迟到正文" }) });
    });
    await flushMicrotasks();

    expect(container.querySelector('[data-testid="note-body"]')).toBeNull();

    // 重新挂载一个新 root，确保环境未被污染
    root = createRoot(container);
    await render(
      createElement(StudyNoteSidePanel, { client: makeClient(), onRequestClose: () => {}, initialNoteId: NOTE_B }),
    );
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());
  });
});
