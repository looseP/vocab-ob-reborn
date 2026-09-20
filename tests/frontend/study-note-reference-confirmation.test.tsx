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
 *
 * DEFECT 1（P2，2026-09-21 后续补修）追加两例：**迟到的确认不得复活已移除引用的元数据**。
 * 根因在 `applyConfirmedReferences` 的元数据「补齐」循环：升级（升级已有条目）与补齐
 * （推送响应里多余条目）都没有按「当前有效引用集合」过滤，所以一次在途移除之后再返回的
 * 响应会把已删除的 A 重新塞回 `referencesMeta`（且 `confirmed: true`）。
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

function Harness({ client, noteId }: { client: any; noteId?: string }): null {
  editor = useStudyNoteEditor({ noteId: noteId ?? NOTE, client });
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // 防跨用例串味：先放一个 loading 哨兵，否则 waitFor 会立刻看到上一条用例残留的
  // "ready"，新挂载的 effect 还没跑（client.get 未调用）就往下走，读到已 dispose 的控制器。
  editor = { loadState: "loading" } as unknown as UseStudyNoteEditorResult;
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

/**
 * 在正文**末尾段落之后**追加引用（新 marker 成为文末顶层块）。
 *
 * DEFECT 1 的两个用例都要「插入 A → 再移除 A」：只有当 marker 是最后一个顶层块时，
 * 移除才会把正文还原成干净的前文（删除语义为「标记段落 + 其相邻空行」）。用 `insert()`
 * 的 cursor=1 会把首段切成两半（`b\n\n[[ref:A]]\n\nody`），移除后中途拼回 `b]]…`——
 * 那是**另一个**既有缺陷（删除区间起点回溯换行导致残留 `]]`），不属本缺陷范围，
 * 不应把本回归测试建立在它之上。
 */
async function insertAtEnd(): Promise<string> {
  let id: string | null = null;
  await act(async () => {
    const end = editor.snapshot!.edit.bodyMd.length;
    id = editor.insertReference(target, preview, end);
  });
  return id!;
}

async function flush(): Promise<void> {
  await act(async () => {
    await editor.requestNavigation(() => {});
  });
  expect(editor.navigationError).toBeNull();
}

/**
 * 受控保存桩：第 `holdCalls` 次起的**响应投递**由测试用 `release(call)` 放行（deferred
 * latch），其余次立即返回。注意挂起的是「响应送达」，不是「处理函数执行」——因此挂起期间
 * 后续 PUT 仍会真正发起（计入 `save.mock.calls`），这正是复现交错所需的时序。
 * 服务端逐条回显 references（capture → 快照 + 服务端 capturedAt）。
 */
function makeGatedSave(options: { holdCalls: number[] }): {
  save: ReturnType<typeof vi.fn>;
  release: (call: number) => void;
} {
  const gates = new Map<number, { promise: Promise<void>; resolve: () => void }>();
  for (const call of options.holdCalls) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    gates.set(call, { promise, resolve });
  }
  let call = 0;
  let stored: any = structuredClone(dto);
  const save = vi.fn((_: string, input: any) => {
    call += 1;
    const myCall = call;
    stored = {
      ...stored,
      ...input,
      version: stored.version + 1,
      updatedAt: `2026-09-21T0${myCall}:00:00Z`,
      references: input.references.map((r: any) => ({
        id: r.id,
        target,
        status: "current",
        capturedAt: `2026-09-21T0${myCall}:00:00Z`,
        // 每条引用的正式快照带各自 id 后缀，便于区分「来自哪一次确认」
        displaySnapshot: { kind: "source", title: `SERVER_${r.id.slice(-4)}`, excerpt: "SERVER_EXCERPT" },
        liveTitle: `SERVER_${r.id.slice(-4)}`,
      })),
    };
    const item = structuredClone(stored);
    const gate = gates.get(myCall);
    return gate ? gate.promise.then(() => ({ item })) : Promise.resolve({ item });
  });
  return { save, release: (target) => gates.get(target)?.resolve() };
}

/**
 * 渲染并等到 ready（自定义 save 桩版本，用于需要控制请求时序的用例）。
 * 与 `boot()` 同一挂载方式；用例名不同的 noteId 让 hook 状态完全隔离。
 */
async function bootWith(save: ReturnType<typeof vi.fn>, noteId: string = NOTE): Promise<void> {
  const client = { get: vi.fn(async () => ({ item: structuredClone({ ...dto, id: noteId }) })), save };
  await act(async () => {
    root.render(createElement(Harness, { client, noteId }));
  });
  await waitFor(() => expect(editor.loadState).toBe("ready"), { timeout: 3000 });
}

/** 等真实防抖（800ms）走完并让自动 PUT 落地；不使用 requestNavigation（它会锁编辑）。 */
async function settleAutosave(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });
}

/**
 * 放行被挂起的响应，并等待 hook 侧的确认回调 + 订阅重渲染落地。
 * **不使用 requestNavigation**（它会按设计锁编辑、且在这里会与在途请求争抢管道）。
 */
async function releaseAndSettle(release: (call: number) => void, target: number): Promise<void> {
  await act(async () => {
    release(target);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
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

// ── DEFECT 1（P2）：迟到的确认不得复活已移除引用的元数据 ─────────────────────
//
// 复现（独立复核 + 本地实测）：插入 A → A 的自动 PUT 被挂起 → 移除 A（本地元数据清空）
// → 放行 A 的响应 → 空引用保存完成。最终 edit.references 与第二次 PUT 载荷都正确为空，
// 但 `referencesMeta` 把 A 带了回来且 confirmed=true。根因：capture→keep 路径按当前编辑
// 集合过滤，元数据「补齐」循环没有；随后的空响应也不做清理。

it("A 确认在途时移除 A 并插入 B：B 的正文/采集保留，A 不复活，B 仍等自己的确认", async () => {
  const { save, release } = makeGatedSave({ holdCalls: [1, 2] });

  await bootWith(save, "00000000-0000-4000-8000-0000000007d2");

  // 插入 A → 自动 PUT 1（挂起）：等真实防抖（800ms）走完，不靠 requestNavigation。
  const idA = await insertAtEnd();
  await settleAutosave();
  expect(save).toHaveBeenCalledTimes(1);

  // A 在途：移除 A，再插入 B
  await act(async () => {
    expect(editor.removeReference(idA)).toBe(true);
  });
  expect(editor.snapshot!.edit.bodyMd).toBe("body");
  const idB = await insertAtEnd();
  expect(idB).not.toBe(idA);
  expect(editor.snapshot!.edit.references).toEqual([{ id: idB, action: "capture", target }]);
  const bodyAfter = editor.snapshot!.edit.bodyMd;
  expect(bodyAfter).not.toContain(`[[ref:${idA}]]`);
  expect(bodyAfter).toContain(`[[ref:${idB}]]`);

  // 放行 A 的迟到确认：A 已不在集合中，不得复活；B 保持待确认（capture + confirmed=false）。
  // B 自己的 PUT 2 会在 A 结算后被立刻续发，但它的响应同样被挂起——所以此刻 B 只能还停在
  // 「待确认」，这正是「B 的确认只能来自 B 自己的确认」这一要求。
  await releaseAndSettle(release, 1);
  expect(editor.referencesMeta.map((meta) => meta.id)).toEqual([idB]);
  expect(editor.referencesMeta[0]!.confirmed).toBe(false);
  expect(editor.snapshot!.edit.bodyMd).toBe(bodyAfter);

  // B 走自己的确认往返（capture）：A 的确认结算后管道会续发 B 的 PUT 2（响应仍被挂起）。
  await waitFor(() => expect(save.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
  const payloadWithB = save.mock.calls
    .slice(1)
    .map((c: any) => c[1])
    .find((p: any) => p.references.some((w: any) => w.id === idB))!;
  expect(payloadWithB.references).toEqual([{ id: idB, action: "capture", target }]);
  expect(payloadWithB.references.some((w: any) => w.id === idA)).toBe(false);

  // 放行 B 自己的确认之前，B 仍是待确认（服务端尚未确认 B 的正式快照）
  expect(editor.referencesMeta.find((m) => m.id === idB)!.confirmed).toBe(false);
  await releaseAndSettle(release, 2);
  await waitFor(() => expect(editor.referencesMeta.find((m) => m.id === idB)!.confirmed).toBe(true), {
    timeout: 3000,
  });
  expect(editor.referencesMeta.map((meta) => meta.id)).toEqual([idB]);
  expect(editor.referencesMeta[0]!.capturedAt).toBe("2026-09-21T02:00:00Z");
  expect(editor.snapshot!.edit.bodyMd).toBe(bodyAfter);
});

it("迟到的确认不得复活在途移除的引用元数据", async () => {
  const { save, release } = makeGatedSave({ holdCalls: [1] });

  await bootWith(save, "00000000-0000-4000-8000-0000000007d1");

  // 插入 A；等真实防抖走完、自动 PUT 发起（响应被挂起）
  const idA = await insertAtEnd();
  await settleAutosave();
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0]![1].references.map((w: any) => w.id)).toEqual([idA]);

  // A 在途时移除 A：本地引用集合与元数据都必须立刻清空
  await act(async () => {
    expect(editor.removeReference(idA)).toBe(true);
  });
  expect(editor.snapshot!.edit.references).toEqual([]);
  expect(editor.referencesMeta).toEqual([]);

  // 空引用的编辑已脏，先把 flush 挂起（第二次 PUT 需要的确认），再放行 A 的迟到响应——
  // 制造「A 的确认落在移除之后」的真实交错。
  const emptyFlush = editor.snapshot!.editSeq > editor.snapshot!.savedSeq ? flush() : Promise.resolve();
  await releaseAndSettle(release, 1);
  await emptyFlush;
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2), { timeout: 3000 });

  // 四条硬断言：两份状态都必须是空，且 A 不得以任何形式回到元数据
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1]![1].references).toEqual([]);
  expect(editor.snapshot!.edit.references).toEqual([]);
  expect(editor.referencesMeta).toEqual([]);
  await settleAutosave();
});
