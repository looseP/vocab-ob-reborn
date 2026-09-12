/**
 * 素材宇宙视图模型（B1 体验层）——纯函数直测。
 *
 * 前端文件不受分层覆盖率治理，但按纪律仍需真实测试：这里覆盖计数格式化、
 * 同句多词的圈记合并（首页不重复同一句）、空态判定与相对时间。
 */
import { describe, expect, it } from "vitest";
import type { L3ContextRow, L3OccurrenceListItem, L3OccurrenceRow, L3SourceRow } from "@/domain";
import {
  buildRecentCaptureGroups,
  formatUniverseCount,
  formatUniverseWhen,
  isUniverseEmpty,
  trimUniverseExcerpt,
} from "@/frontend/viewModels/l3UniverseViewModel";

function item(input: {
  contextId: string;
  slug: string;
  text?: string;
  createdAt?: string;
  sourceId?: string;
  sourceTitle?: string;
}): L3OccurrenceListItem {
  const createdAt = input.createdAt ?? "2026-09-08T09:00:00Z";
  return {
    occurrence: { id: `occ-${input.slug}`, created_at: createdAt } as L3OccurrenceRow,
    word: { id: "w-1", slug: input.slug, title: input.slug },
    context: { id: input.contextId, text: input.text ?? "A vivid context.", created_at: createdAt } as L3ContextRow,
    source: { id: input.sourceId ?? "src-1", title: input.sourceTitle ?? "Essay" } as L3SourceRow,
  };
}

describe("formatUniverseCount", () => {
  it("groups thousands and clamps non-positive or non-finite values", () => {
    expect(formatUniverseCount(0)).toBe("0");
    expect(formatUniverseCount(999)).toBe("999");
    expect(formatUniverseCount(1000)).toBe("1,000");
    expect(formatUniverseCount(12345)).toBe("12,345");
    expect(formatUniverseCount(-3)).toBe("0");
    expect(formatUniverseCount(Number.NaN)).toBe("0");
  });
});

describe("buildRecentCaptureGroups", () => {
  it("merges several words marked in the same sentence into one row", () => {
    const groups = buildRecentCaptureGroups([
      item({ contextId: "ctx-1", slug: "vivid", text: "A vivid context." }),
      item({ contextId: "ctx-1", slug: "lucid" }),
      item({ contextId: "ctx-2", slug: "quiet", text: "A quiet sentence." }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].contextId).toBe("ctx-1");
    expect(groups[0].words).toEqual(["vivid", "lucid"]);
    expect(groups[0].excerpt).toBe("A vivid context.");
    expect(groups[1].words).toEqual(["quiet"]);
  });

  it("stops once the requested number of distinct sentences is collected", () => {
    const groups = buildRecentCaptureGroups(
      [
        item({ contextId: "ctx-1", slug: "a" }),
        item({ contextId: "ctx-2", slug: "b" }),
        item({ contextId: "ctx-3", slug: "c" }),
      ],
      2,
    );
    expect(groups.map((group) => group.contextId)).toEqual(["ctx-1", "ctx-2"]);
  });

  it("skips occurrences without a context and collapses blank text", () => {
    const groups = buildRecentCaptureGroups([
      { ...item({ contextId: "ctx-1", slug: "a" }), context: null as unknown as L3ContextRow },
      item({ contextId: "ctx-2", slug: "b", text: "  many   \n spaces  " }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].excerpt).toBe("many spaces");
  });
});

describe("isUniverseEmpty", () => {
  it("treats a missing summary or zero sources as the accumulating empty state", () => {
    expect(isUniverseEmpty(null)).toBe(true);
    expect(isUniverseEmpty({ sourceCount: 0 })).toBe(true);
    expect(isUniverseEmpty({ sourceCount: 1 })).toBe(false);
  });
});

describe("formatUniverseWhen", () => {
  it("renders a coarse Chinese relative time and tolerates unparsable input", () => {
    const now = new Date("2026-09-12T12:00:00Z");
    expect(formatUniverseWhen("2026-09-12T11:59:30Z", now)).toBe("刚刚");
    expect(formatUniverseWhen("2026-09-12T11:30:00Z", now)).toBe("30 分钟前");
    expect(formatUniverseWhen("2026-09-12T06:00:00Z", now)).toBe("6 小时前");
    expect(formatUniverseWhen("2026-09-10T12:00:00Z", now)).toBe("2 天前");
    expect(formatUniverseWhen("2026-07-13T12:00:00Z", now)).toBe("2 个月前");
    expect(formatUniverseWhen("2025-07-13T12:00:00Z", now)).toBe("1 年前");
    expect(formatUniverseWhen("not-a-date", now)).toBe("");
  });
});

describe("trimUniverseExcerpt", () => {
  it("truncates long sentences with an ellipsis", () => {
    const long = "a".repeat(200);
    expect(trimUniverseExcerpt(long)).toHaveLength(121);
    expect(trimUniverseExcerpt(long).endsWith("…")).toBe(true);
  });
});
