/**
 * Task 09A · 引用正文操作域工具测试（先红后绿）。
 *
 * 纪律：marker 必须独占顶层段落；插入/删除/转换后 marker 集合与引用集合
 * 仍可由 `assertReferenceSet` 校验；工具纯文本、不读 React/DOM。
 */
import { describe, expect, it } from "vitest";
import { assertReferenceSet, ReferenceContractError } from "@/domain/l3-study-notes";
import type { ReferencePreview } from "@/domain/l3-study-notes";
import {
  excerptLinesFromSnapshot,
  insertReferenceMarker,
  removeReferenceMarker,
  replaceMarkerWithExcerpt,
} from "@/frontend/utils/studyNoteReferenceOps";

const REF_A = "00000000-0000-4000-8000-000000000a01";
const REF_B = "00000000-0000-4000-8000-000000000b01";

describe("studyNoteReferenceOps · 插入", () => {
  it("空正文：插入裸标记（无多余空行）", () => {
    expect(insertReferenceMarker("", REF_A, null)).toBe(`[[ref:${REF_A}]]`);
    expect(insertReferenceMarker("", REF_A, 0)).toBe(`[[ref:${REF_A}]]`);
  });

  it("文末（光标在末尾，无尾随换行）：补空行边界", () => {
    expect(insertReferenceMarker("第一段正文", REF_A, 5)).toBe(
      `第一段正文\n\n[[ref:${REF_A}]]`,
    );
  });

  it("光标在段落中间：拆出独立段落（前后各补空行）", () => {
    expect(insertReferenceMarker("前文后文", REF_A, 2)).toBe(
      `前文\n\n[[ref:${REF_A}]]\n\n后文`,
    );
  });

  it("光标恰在既有空行边界：不重复补空行", () => {
    expect(insertReferenceMarker("前文\n\n后文", REF_A, 4)).toBe(
      `前文\n\n[[ref:${REF_A}]]\n\n后文`,
    );
  });

  it("插入后经 assertReferenceSet 校验（marker 与 capture write 一致）", () => {
    const body = insertReferenceMarker("正文", REF_A, 2);
    expect(() =>
      assertReferenceSet(body, [
        {
          id: REF_A,
          action: "capture",
          target: { kind: "source", sourceId: "00000000-0000-4000-8000-000000000001" },
        },
      ]),
    ).not.toThrow();
  });
});

describe("studyNoteReferenceOps · 删除", () => {
  it("删除独占段落的标记行（含其相邻空行，保持段落整齐）", () => {
    const body = `前文\n\n[[ref:${REF_A}]]\n\n后文`;
    expect(removeReferenceMarker(body, REF_A)).toBe("前文\n\n后文");
  });

  it("删除文首标记（其后空行一并清理）", () => {
    const body = `[[ref:${REF_A}]]\n\n后文`;
    expect(removeReferenceMarker(body, REF_A)).toBe("后文");
  });

  it("删除文末标记（其前空行一并清理）", () => {
    const body = `前文\n\n[[ref:${REF_A}]]`;
    expect(removeReferenceMarker(body, REF_A)).toBe("前文");
  });

  it("大小写归一：大写形态的 marker 同样可删", () => {
    const body = `前文\n\n[[ref:${REF_A.toUpperCase()}]]\n\n后文`;
    expect(removeReferenceMarker(body, REF_A)).toBe("前文\n\n后文");
  });

  it("仅删除目标标记：其他引用不受影响", () => {
    const body = `前\n\n[[ref:${REF_A}]]\n\n中\n\n[[ref:${REF_B}]]\n\n后`;
    expect(removeReferenceMarker(body, REF_A)).toBe(`前\n\n中\n\n[[ref:${REF_B}]]\n\n后`);
  });

  it("marker 不存在：显式报错（不静默成功）", () => {
    expect(() => removeReferenceMarker("无标记正文", REF_A)).toThrow(ReferenceContractError);
  });
});

describe("studyNoteReferenceOps · 转换普通摘录", () => {
  it("marker 行替换为摘录行；与移除不同——文本保留", () => {
    const body = `前文\n\n[[ref:${REF_A}]]\n\n后文`;
    const excerpt = ["> 「原文摘录」", "> —— 来源标题"];
    expect(replaceMarkerWithExcerpt(body, REF_A, excerpt)).toBe(
      `前文\n\n> 「原文摘录」\n> —— 来源标题\n\n后文`,
    );
  });

  it("转换后 marker 消失、断言可检查（供调用方同步移除 write）", () => {
    const body = `[[ref:${REF_A}]]`;
    const next = replaceMarkerWithExcerpt(body, REF_A, ["> 摘录"]);
    expect(next).toBe("> 摘录");
    expect(next).not.toContain("[[ref:");
  });

  it("marker 不存在：显式报错", () => {
    expect(() => replaceMarkerWithExcerpt("无标记", REF_A, ["> x"])).toThrow(ReferenceContractError);
  });
});

describe("studyNoteReferenceOps · 摘录行生成", () => {
  const base: Omit<ReferencePreview, "displaySnapshot"> = {
    id: REF_A,
    target: { kind: "source", sourceId: "00000000-0000-4000-8000-000000000001" },
    status: "current",
    capturedAt: "2026-09-20T00:00:00.000Z",
    liveTitle: "来源标题",
  };

  it("source：标题 + 来源行", () => {
    const meta: ReferencePreview = {
      ...base,
      displaySnapshot: { kind: "source", title: "来源标题", excerpt: "摘要" },
    };
    expect(excerptLinesFromSnapshot(meta)).toEqual(["> 「来源标题」", "> —— 来源"]);
  });

  it("source_quote：引文 + 来源标题", () => {
    const meta: ReferencePreview = {
      ...base,
      displaySnapshot: { kind: "source_quote", title: "来源标题", quote: "原文片段" },
    };
    expect(excerptLinesFromSnapshot(meta)).toEqual(["> 「原文片段」", "> —— 来源标题"]);
  });

  it("question：题干 + 题型/来源描述", () => {
    const meta: ReferencePreview = {
      ...base,
      displaySnapshot: {
        kind: "question",
        stem: "题干内容",
        options: [],
        questionType: "cloze",
        sourceTitle: "来源A",
      },
    };
    expect(excerptLinesFromSnapshot(meta)).toEqual(["> 题干内容", "> —— 题目（cloze）· 来源A"]);
  });

  it("option_quote：选项引文 + 选项号", () => {
    const meta: ReferencePreview = {
      ...base,
      displaySnapshot: {
        kind: "option_quote",
        optionKey: "B",
        quote: "选项文本",
        questionType: "reading_choice",
        sourceTitle: null,
      },
    };
    expect(excerptLinesFromSnapshot(meta)).toEqual(["> 「选项文本」", "> —— 选项 B（reading_choice）"]);
  });

  it("多行 quote：逐行转换为引用块行（不破坏 Markdown 引用语义）", () => {
    const meta: ReferencePreview = {
      ...base,
      displaySnapshot: { kind: "source_quote", title: "T", quote: "第一行\n第二行" },
    };
    expect(excerptLinesFromSnapshot(meta)).toEqual(["> 「第一行", "> 第二行」", "> —— T"]);
  });
});
