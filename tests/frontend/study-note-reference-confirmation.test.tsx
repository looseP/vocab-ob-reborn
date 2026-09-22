// @vitest-environment jsdom
/**
 * Task 09A 补修 · 引用确认快照回归（由独立复核探针转化，2026-09-21）。
 *
 * 覆盖审查 R1/R2 的两个核心断言：
 *  - 保存确认后仅改标题，新引用必须 keep（不再重采集）——探针 1；
 *  - 保存确认返回的服务端快照/时间替换插入时的临时预览——探针 2。
 *
 * 与探针的差别仅在于**不使用整对象 toEqual**：正式元数据带一个显式的
 * `confirmed` 标记（R2 的「待确认 vs 已确认」区分），因此按字段断言
 * 「服务端值全部生效、预览值全部消失」，而不是要求对象形状与 DTO 逐字节相同。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/dom";
import { useStudyNoteEditor, type UseStudyNoteEditorResult } from "@/frontend/hooks/useStudyNoteEditor";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const NOTE = "00000000-0000-4000-8000-000000000701";
const SOURCE = "00000000-0000-4000-8000-000000000901";
const target = { kind: "source" as const, sourceId: SOURCE };
const preview = {
  target,
  displaySnapshot: { kind: "source" as const, title: "PREVIEW_OLD", excerpt: "PREVIEW_EXCERPT" },
  liveTitle: "PREVIEW_OLD",
};
const dto = {
  id: NOTE,
  title: "initial",
  bodyMd: "body",
  venues: ["cloze"] as const,
  pinned: false,
  status: "active",
  version: 1,
  createdAt: "2026-09-20T00:00:00Z",
  updatedAt: "2026-09-20T00:00:00Z",
  references: [] as unknown[],
};

let editor: UseStudyNoteEditorResult;
let root: Root;
let container: HTMLDivElement;
let save: ReturnType<typeof vi.fn>;
let stored: any;

function Harness({ client }: { client: any }): null {
  editor = useStudyNoteEditor({ noteId: NOTE, client });
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function boot(): Promise<void> {
  stored = structuredClone(dto);
  save = vi.fn(async (_: string, input: any) => {
    stored = {
      ...stored,
      ...input,
      version: stored.version + 1,
      updatedAt: "2026-09-21T01:00:00Z",
      // 服务端口径：capture → 服务端快照 + 服务端 capturedAt
      references: input.references.map((r: any) => ({
        id: r.id,
        target,
        status: "current",
        capturedAt: "2026-09-21T01:00:00Z",
        displaySnapshot: { kind: "source", title: "SERVER_CONFIRMED", excerpt: "SERVER_EXCERPT" },
        liveTitle: "SERVER_CONFIRMED",
      })),
    };
    return { item: structuredClone(stored) };
  });
  const client = { get: vi.fn(async () => ({ item: structuredClone(dto) })), save };
  await act(async () => root.render(createElement(Harness, { client })));
  await waitFor(() => expect(editor.loadState).toBe("ready"));
}

/**
 * 在正文**普通段落**处插入（cursor=1：段落文本内，非文末/非既有 marker 处）。
 * 传 null（追加到文末）会紧邻上一枚 marker 而被正确拒绝——那不是本用例要覆盖的路径。
 */
async function insert(): Promise<string> {
  let id: string | null = null;
  await act(async () => {
    id = editor.insertReference(target, preview, 1);
  });
  return id!;
}

async function flush(): Promise<void> {
  await act(async () => {
    await editor.requestNavigation(() => {});
  });
  expect(editor.navigationError).toBeNull();
}

it("确认后仅改标题：新引用第二次 PUT 必须 keep（不再重采集）", async () => {
  await boot();
  await insert();
  await flush();
  await act(async () => editor.setTitle("second title"));
  await flush();
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[0]![1].references[0].action).toBe("capture");
  expect(save.mock.calls[1]![1].references[0].action).toBe("keep");
});

it("服务端确认的快照与 capture 时间替换临时预览（预览值全部消失）", async () => {
  await boot();
  const id = await insert();
  await flush();
  const meta = editor.referencesMeta.find((reference) => reference.id === id)!;

  // 服务端值生效
  expect(meta.confirmed).toBe(true);
  expect(meta.capturedAt).toBe("2026-09-21T01:00:00Z");
  expect(meta.displaySnapshot).toEqual({ kind: "source", title: "SERVER_CONFIRMED", excerpt: "SERVER_EXCERPT" });
  expect(meta.liveTitle).toBe("SERVER_CONFIRMED");
  expect(meta.status).toBe("current");
  expect(meta.target).toEqual(target);
  // 预览值不再残留（本机时间也不冒充服务端时间）
  const serialized = JSON.stringify(meta);
  expect(serialized).not.toContain("PREVIEW_OLD");
  expect(serialized).not.toContain("PREVIEW_EXCERPT");
});

it("未确认前是待确认预览：capturedAt 为空、confirmed=false，转换被拒绝", async () => {
  await boot();
  const id = await insert();
  const meta = editor.referencesMeta.find((reference) => reference.id === id)!;
  expect(meta.confirmed).toBe(false);
  expect(meta.capturedAt).toBe(""); // 不用本机时间冒充服务端 capture 时间
  expect(meta.displaySnapshot).toEqual(preview.displaySnapshot);
  let accepted = true;
  await act(async () => {
    accepted = editor.convertReferenceToExcerpt(id);
  });
  expect(accepted).toBe(false);
  expect(editor.referenceError).toBeTruthy();
});

it("A 保存挂起时新插 B：A 确认只把 A 转 keep，B 仍 capture 且正文保留", async () => {
  // 受控响应：第一次 PUT 挂起，直到测试显式放行
  let releaseFirst: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let call = 0;
  stored = structuredClone(dto);
  save = vi.fn(async (_: string, input: any) => {
    call += 1;
    if (call === 1) await gate; // A 的响应挂起
    stored = {
      ...stored,
      ...input,
      version: (stored.version ?? 1) + 1,
      updatedAt: `2026-09-21T0${call}:00:00Z`,
      references: input.references.map((r: any) => ({
        id: r.id,
        target: r.target,
        status: "current",
        capturedAt: `2026-09-21T0${call}:00:00Z`,
        displaySnapshot: { kind: "source", title: `SERVER_${r.id.slice(-4)}`, excerpt: "SERVER_EXCERPT" },
        liveTitle: `SERVER_${r.id.slice(-4)}`,
      })),
    };
    return { item: structuredClone(stored) };
  });
  const client = { get: vi.fn(async () => ({ item: structuredClone(dto) })), save };
  await act(async () => root.render(createElement(Harness, { client })));
  await waitFor(() => expect(editor.loadState).toBe("ready"));

  // 插入 A；等待防抖自动发起保存（不使用 requestNavigation——那会按设计锁编辑）
  const idA = await insert();
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });
  expect(save.mock.calls[0]![1].references.find((w: any) => w.id === idA).action).toBe("capture");

  // A 在途期间插入 B（保存仍挂起）
  const idB = await insert();
  expect(idB).not.toBe(idA);

  // 放行 A 的确认，并等待管道收尾（B 会随后发起自己的保存）
  releaseFirst!();
  // A 的确认回包 + 管道续发 B（防抖 800ms）
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });
  await waitFor(() => expect(save.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });

  // 关键不变量（R1）：A 的确认**只**结算 A——B 必须走它自己的 capture 往返，
  // 不得因 A 的确认被误标为已确认/误转 keep。
  const bodyNow = editor.snapshot!.edit.bodyMd;
  expect(bodyNow).toContain(`[[ref:${idA}]]`);
  expect(bodyNow).toContain(`[[ref:${idB}]]`);

  // 第一次 PUT（A）时 B 尚未存在；第二次 PUT 必须把 B 作为 capture 提交
  const firstPayload = save.mock.calls[0]![1];
  expect(firstPayload.references.map((w: any) => w.id)).toEqual([idA]);
  const laterPayloads = save.mock.calls.slice(1).map((c: any) => c[1]);
  const payloadWithB = laterPayloads.find((p: any) => p.references.some((w: any) => w.id === idB));
  expect(payloadWithB).toBeTruthy();
  // B 在**它自己的**提交里仍是 capture（没有被 A 的确认提前转 keep）
  expect(payloadWithB.references.find((w: any) => w.id === idB).action).toBe("capture");
  // A 在后续载荷里已是 keep（已确认，不再重采集）
  expect(payloadWithB.references.find((w: any) => w.id === idA).action).toBe("keep");

  const metaA = editor.referencesMeta.find((r) => r.id === idA)!;
  const metaB = editor.referencesMeta.find((r) => r.id === idB)!;
  expect(metaA.confirmed).toBe(true);
  // B 的正式元数据只能来自 B 自己的确认（服务端标题带各自 id 后缀，可区分来源）
  expect(metaA.displaySnapshot).toMatchObject({ title: expect.stringContaining(idA.slice(-4)) });
  expect(metaB.displaySnapshot).toMatchObject({ title: expect.stringContaining(idB.slice(-4)) });
});
