/**
 * review-l3-contexts：复习队列的 L3 语境注入（自 review.ts 外迁后独立成测）。
 *
 * 这条链路的三条口径都是**用户可见行为**，值得锁死：
 * 1. 无语境的词回空数组（前端据此不渲染折叠、也不生成 H1′ 提示级）；
 * 2. best-effort：L3 抛错不阻塞队列（ADR-0016 哲学），调用方不必再包 try/catch；
 * 3. `surface` 必须随载荷下发 —— 它是提示阶梯 H1′ 级的遮盖锚，缺了整级不生成。
 */
import { describe, expect, it, vi } from "vitest";
import { REVIEW_L3_CONTEXT_LIMIT, loadL3ContextsByWord } from "@/http/routes/review-l3-contexts";

const ITEM = {
  context: { id: "ctx-1", text: "〖45〗 use the language of abundance." },
  source: { id: "src-1", title: "2025 英语二 · Part B" },
  occurrence: { bound_sense: "丰富的；充裕的；大量的", surface: "abundance" },
};

describe("loadL3ContextsByWord", () => {
  it("按 wordId 归并语境，并下发 surface / bound_sense", async () => {
    const listContextsForWord = vi.fn(async () => ({ items: [ITEM] }));
    const map = await loadL3ContextsByWord({
      userId: "u1",
      words: [{ id: "w1", slug: "abundant" }],
      listContextsForWord,
    });

    expect(map.get("w1")).toEqual([{
      context_id: "ctx-1",
      source_id: "src-1",
      text: "〖45〗 use the language of abundance.",
      source_title: "2025 英语二 · Part B",
      bound_sense: "丰富的；充裕的；大量的",
      surface: "abundance",
    }]);
  });

  it("occurrence 缺失时两个 nullable 字段回 null（不抛错、不编造）", async () => {
    const map = await loadL3ContextsByWord({
      userId: "u1",
      words: [{ id: "w1", slug: "abundant" }],
      listContextsForWord: async () => ({
        items: [{ context: { id: "c", text: "t" }, source: { id: "s", title: "title" } }],
      }),
    });
    expect(map.get("w1")?.[0]).toMatchObject({ bound_sense: null, surface: null });
  });

  it("缺 slug 的卡回空数组，且不发起查询", async () => {
    const listContextsForWord = vi.fn(async () => ({ items: [ITEM] }));
    const map = await loadL3ContextsByWord({
      userId: "u1",
      words: [{ id: "w1", slug: null }, { id: "w2" }, { id: "w3", slug: "abundant" }],
      listContextsForWord,
    });

    expect(map.get("w1")).toEqual([]);
    expect(map.get("w2")).toEqual([]);
    expect(listContextsForWord).toHaveBeenCalledTimes(1);
  });

  it("best-effort：查询抛错时该卡回空数组，其它卡不受影响", async () => {
    const listContextsForWord = vi.fn(async (input: { slug: string }) => {
      if (input.slug === "boom") throw new Error("l3 down");
      return { items: [ITEM] };
    });
    const map = await loadL3ContextsByWord({
      userId: "u1",
      words: [{ id: "w-boom", slug: "boom" }, { id: "w-ok", slug: "abundant" }],
      listContextsForWord,
    });

    expect(map.get("w-boom")).toEqual([]);
    expect(map.get("w-ok")).toHaveLength(1);
  });

  it("每卡上限锁定为 2（口径常量，勿随手调大）", async () => {
    const listContextsForWord = vi.fn(async () => ({ items: [] }));
    await loadL3ContextsByWord({
      userId: "u1",
      words: [{ id: "w1", slug: "abundant" }],
      listContextsForWord,
    });

    expect(REVIEW_L3_CONTEXT_LIMIT).toBe(2);
    expect(listContextsForWord).toHaveBeenCalledWith({ userId: "u1", slug: "abundant", limit: 2 });
  });
});
