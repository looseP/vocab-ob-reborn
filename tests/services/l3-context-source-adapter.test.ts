/**
 * L3ContextSourceAdapter 单元测试 —— FR-12 接线2：L3 语境源适配器.
 *
 * 验证点：
 * - 包装 L3ContextRepository.listContextsForWord 返回 context.text 数组
 * - 事务以 actorId=userId 运行（RLS 红线，spec D7'/ADR-0005）
 * - 默认 limit=3，可被 lookup.limit 覆盖
 * - 调用失败时异常透传（best-effort 吞掉由 L2DrillService.fetchContextSnippets 负责，
 *   适配器本身只做读路径，不假设调用方的异常策略）
 * - 空结果集返回 []（L3 暂无语境时不影响 L2 队列建步）
 *
 * 不触达真实数据库：通过 deps.txRunner + deps.repoFactory 注入 mock。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IL3ContextRepository } from "@/repositories/interfaces";
import type { L3PaginatedList, L3WordContextListItem, L3ContextRow, L3SourceRow, L3OccurrenceRow, L3ContextLinkRow } from "@/domain";
import { L3ContextSourceAdapter } from "@/services/l3-context-source-adapter";
import { noopContextSource } from "@/domain/context-source";
import type { withTransaction } from "@/db/transaction";

type TxRunner = typeof withTransaction;

const USER_ID = "00000000-0000-4000-8000-000000000104";
const WORD_ID = "00000000-0000-4000-8000-000000000106";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000999";

function makeContextRow(id: string, text: string): L3ContextRow {
  return {
    id,
    source_id: "src-1",
    user_id: USER_ID,
    context_type: "sentence",
    text,
    normalized_text: null,
    language: "en",
    position: {},
    metadata: {},
    created_at: "2026-08-25T00:00:00Z",
    updated_at: "2026-08-25T00:00:00Z",
  };
}

function makeSourceRow(): L3SourceRow {
  return {
    id: "src-1",
    user_id: USER_ID,
    wordbook_id: null,
    source_type: "article",
    title: "Essay",
    author: null,
    url: null,
    language: "en",
    metadata: {},
    created_at: "2026-08-25T00:00:00Z",
    updated_at: "2026-08-25T00:00:00Z",
  };
}

function makeOccurrenceRow(): L3OccurrenceRow {
  return {
    id: "occ-1",
    context_id: "ctx-1",
    word_id: WORD_ID,
    user_id: USER_ID,
    surface: "vivid",
    lemma: null,
    start_offset: null,
    end_offset: null,
    confidence: null,
    evidence: {},
    created_at: "2026-08-25T00:00:00Z",
  };
}

function makeListItem(text: string, id = "ctx-1"): L3WordContextListItem {
  return {
    context: makeContextRow(id, text),
    source: makeSourceRow(),
    occurrence: makeOccurrenceRow(),
    links: [] as L3ContextLinkRow[],
  };
}

function makeEmptyPage(): L3PaginatedList<L3WordContextListItem> {
  return { items: [], limit: 3, cursor: null, nextCursor: null };
}

function makePage(items: L3WordContextListItem[]): L3PaginatedList<L3WordContextListItem> {
  return { items, limit: items.length, cursor: null, nextCursor: null };
}

interface AdapterFixture {
  adapter: L3ContextSourceAdapter;
  listContextsForWord: ReturnType<typeof vi.fn>;
  txRunnerMock: ReturnType<typeof vi.fn>;
  txOptions: Array<{ actorId?: string }>;
}

function makeAdapter(listContextsForWord: ReturnType<typeof vi.fn>): AdapterFixture {
  const txOptions: Array<{ actorId?: string }> = [];
  const txRunnerMock = vi.fn(async (cb: (tx: unknown) => Promise<unknown>, options?: { actorId?: string }) => {
    txOptions.push(options ?? {});
    return cb({});
  });
  const repoFactory = vi.fn((tx?: unknown) => ({
    l3Context: { listContextsForWord } as unknown as IL3ContextRepository,
  }));
  const adapter = new L3ContextSourceAdapter({
    txRunner: txRunnerMock as unknown as TxRunner,
    repoFactory,
  });
  return { adapter, listContextsForWord, txRunnerMock, txOptions };
}

beforeEach(() => {
  // 每个 it 重新构建 fixture，无需全局 reset
});

describe("L3ContextSourceAdapter (FR-12 接线2)", () => {
  it("returns ContextSnippet[] (text + source metadata) from listContextsForWord page items", async () => {
    const listContextsForWord = vi.fn(async () =>
      makePage([
        makeListItem("A vivid context.", "ctx-1"),
        makeListItem("Another snippet.", "ctx-2"),
      ]),
    );
    const { adapter } = makeAdapter(listContextsForWord);

    const result = await adapter.getContextSnippets({ userId: USER_ID, wordId: WORD_ID });

    // P3-8：返回 ContextSnippet[]，携带 contextId / sourceId / sourceTitle 元数据
    expect(result).toEqual([
      { text: "A vivid context.", contextId: "ctx-1", sourceId: "src-1", sourceTitle: "Essay" },
      { text: "Another snippet.", contextId: "ctx-2", sourceId: "src-1", sourceTitle: "Essay" },
    ]);
    // 必须以 (userId, wordId, limit) 调用 repo
    expect(listContextsForWord).toHaveBeenCalledWith({
      userId: USER_ID,
      wordId: WORD_ID,
      limit: 3, // 默认上限
    });
  });

  it("returns empty array when L3 has no contexts for the word", async () => {
    const listContextsForWord = vi.fn(async () => makeEmptyPage());
    const { adapter } = makeAdapter(listContextsForWord);

    const result = await adapter.getContextSnippets({ userId: USER_ID, wordId: WORD_ID });

    expect(result).toEqual([]);
    // 即使空结果也应调用 repo（让调用方根据 [] 自然回退）
    expect(listContextsForWord).toHaveBeenCalledTimes(1);
  });

  it("scopes transaction with actorId=userId (RLS red line)", async () => {
    const listContextsForWord = vi.fn(async () => makeEmptyPage());
    const { adapter, txOptions } = makeAdapter(listContextsForWord);

    await adapter.getContextSnippets({ userId: USER_ID, wordId: WORD_ID });

    // 红线：事务必须带 actorId=userId，否则 RLS 过滤不到本用户行
    expect(txOptions).toHaveLength(1);
    expect(txOptions[0]).toEqual({ actorId: USER_ID });
  });

  it("uses lookup.userId as transaction actor (not a hardcoded value)", async () => {
    const listContextsForWord = vi.fn(async () => makeEmptyPage());
    const { adapter, txOptions } = makeAdapter(listContextsForWord);

    await adapter.getContextSnippets({ userId: OTHER_USER_ID, wordId: WORD_ID });

    // 不同用户必须有不同的 actorId，否则会越权返回他人 L3 语境
    expect(txOptions[0]).toEqual({ actorId: OTHER_USER_ID });
    expect(listContextsForWord).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OTHER_USER_ID }),
    );
  });

  it("respects custom limit override (default 3, can be raised)", async () => {
    const listContextsForWord = vi.fn(async () => makeEmptyPage());
    const { adapter } = makeAdapter(listContextsForWord);

    await adapter.getContextSnippets({ userId: USER_ID, wordId: WORD_ID, limit: 10 });

    expect(listContextsForWord).toHaveBeenCalledWith({
      userId: USER_ID,
      wordId: WORD_ID,
      limit: 10,
    });
  });

  it("passes a tx handle into repoFactory so the same connection is reused", async () => {
    const listContextsForWord = vi.fn(async () => makeEmptyPage());
    const txToken = { kind: "tx-handle" };
    const txRunnerMock = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      return cb(txToken);
    });
    const repoFactory = vi.fn((tx?: unknown) => ({
      l3Context: { listContextsForWord } as unknown as IL3ContextRepository,
    }));
    const adapter = new L3ContextSourceAdapter({
      txRunner: txRunnerMock as unknown as TxRunner,
      repoFactory,
    });

    await adapter.getContextSnippets({ userId: USER_ID, wordId: WORD_ID });

    // repoFactory 必须被以 tx 句柄调用（保证共享同一事务连接）
    expect(repoFactory).toHaveBeenCalledWith(txToken);
  });

  it("propagates repository errors (best-effort swallowing is the caller's job)", async () => {
    const listContextsForWord = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const { adapter } = makeAdapter(listContextsForWord);

    // 适配器不吞异常——L2DrillService.fetchContextSnippets 才负责 best-effort 吞掉
    await expect(
      adapter.getContextSnippets({ userId: USER_ID, wordId: WORD_ID }),
    ).rejects.toThrow(/connection refused/);
  });

  it("implements ContextSource interface (duck-typed via getContextSnippets)", async () => {
    const listContextsForWord = vi.fn(async () => makeEmptyPage());
    const { adapter } = makeAdapter(listContextsForWord);

    // 接口契约：必须有 getContextSnippets 方法
    expect(typeof adapter.getContextSnippets).toBe("function");
    // 调用签名匹配 ContextSource.getContextSnippets(lookup)
    const result = await adapter.getContextSnippets({ userId: USER_ID, wordId: WORD_ID });
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("noopContextSource (FR-12 接线2 默认实现)", () => {
  it("returns empty array for any lookup (no L3 wiring)", async () => {
    const result = await noopContextSource.getContextSnippets({
      userId: USER_ID,
      wordId: WORD_ID,
    });
    expect(result).toEqual([]);
  });

  it("returns empty array even with custom limit", async () => {
    const result = await noopContextSource.getContextSnippets({
      userId: USER_ID,
      wordId: WORD_ID,
      limit: 50,
    });
    expect(result).toEqual([]);
  });

  it("never throws (must not block L2 queue buildup)", async () => {
    // 即使传奇怪入参，noop 也不应抛异常（best-effort 兜底）
    const result = await noopContextSource.getContextSnippets({
      userId: "",
      wordId: "",
    });
    expect(result).toEqual([]);
  });
});
