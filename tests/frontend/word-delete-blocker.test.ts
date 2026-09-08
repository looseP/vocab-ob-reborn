import { describe, expect, it } from "vitest";
import { wordDeleteBlockerMessage } from "@/frontend/pages/WordDetailPage";

describe("wordDeleteBlockerMessage", () => {
  it("falls back to a generic hint when no blockers object is present", () => {
    expect(wordDeleteBlockerMessage(undefined)).toBe("该词条存在关联数据，暂不能删除");
    expect(wordDeleteBlockerMessage({})).toBe("该词条存在关联数据，暂不能删除");
  });

  it("falls back to a generic hint when all blocker counts are zero", () => {
    expect(wordDeleteBlockerMessage({ blockers: { l3OccurrenceCount: 0, noteEntryCount: 0, inboundWordLinkCount: 0 } }))
      .toBe("该词条存在关联数据，暂不能删除");
  });

  it("maps each blocker count to actionable Chinese guidance", () => {
    expect(
      wordDeleteBlockerMessage({ blockers: { l3OccurrenceCount: 2, noteEntryCount: 0, inboundWordLinkCount: 0 } }),
    ).toBe("暂不能删除：先到素材空间删除该词绑定的 2 条语境");
    expect(
      wordDeleteBlockerMessage({ blockers: { l3OccurrenceCount: 0, noteEntryCount: 1, inboundWordLinkCount: 0 } }),
    ).toBe("暂不能删除：先删除该词下的 1 条笔记");
    expect(
      wordDeleteBlockerMessage({ blockers: { l3OccurrenceCount: 0, noteEntryCount: 0, inboundWordLinkCount: 3 } }),
    ).toBe("暂不能删除：先删除引用该词的 3 条语境链接");
  });

  it("joins multiple blockers and ignores non-numeric values", () => {
    expect(
      wordDeleteBlockerMessage({
        blockers: { l3OccurrenceCount: 1, noteEntryCount: "2", inboundWordLinkCount: 4 },
      }),
    ).toBe("暂不能删除：先到素材空间删除该词绑定的 1 条语境；先删除引用该词的 4 条语境链接");
  });
});
