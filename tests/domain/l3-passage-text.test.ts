/**
 * l3-passage-text：卷面空号占位符的单一定义源。
 *
 * 为什么值得独立成测试文件：这是 **L1 复习卡**与 **L3 卷面**共用的解析口径，
 * 回归代价体现在用户可见的 `〖45〗` 泄漏（实测 `abundant` 卡背）—— 不是内部细节。
 */
import { describe, expect, it } from "vitest";
import {
  PASSAGE_BLANK_RE,
  createPassageBlankRe,
  hasPassageBlank,
  segmentPassageBlanks,
} from "@/domain/l3-passage-text";

/** 不丢字符是渲染层的前提：解析只许"标注"，不许吞内容。 */
function rejoin(text: string): string {
  return segmentPassageBlanks(text)
    .map((segment) => segment.text)
    .join("");
}

describe("segmentPassageBlanks", () => {
  it("无占位符 → 单个 text 段，内容原样", () => {
    const text = "The ephemeral beauty of cherry blossoms.";
    expect(segmentPassageBlanks(text)).toEqual([{ kind: "text", text }]);
  });

  it("开头空号（真题原句形态）→ blank + text 两段，空号带数字", () => {
    const text = "〖45〗 When pitching a new idea, it's important to use the language of abundance.";
    const segments = segmentPassageBlanks(text);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ kind: "blank", text: "〖45〗", blankNo: 45 });
    expect(segments[1].kind).toBe("text");
    expect(segments[1].text).toBe(" When pitching a new idea, it's important to use the language of abundance.");
  });

  it("句中空号 → text / blank / text 三段交替", () => {
    const segments = segmentPassageBlanks("And while you might 〖14〗 coming across as incompetent.");
    expect(segments.map((s) => s.kind)).toEqual(["text", "blank", "text"]);
    expect(segments[1].blankNo).toBe(14);
  });

  it("多个空号 + 结尾空号：段数与空号序列正确", () => {
    const segments = segmentPassageBlanks("〖1〗a〖2〗b〖3〗");
    expect(segments.map((s) => s.kind)).toEqual(["blank", "text", "blank", "text", "blank"]);
    expect(segments.filter((s) => s.kind === "blank").map((s) => s.blankNo)).toEqual([1, 2, 3]);
  });

  it("任何形态都不丢字符（join === 原文）", () => {
    const samples = [
      "",
      "no marker",
      "〖45〗leading",
      "trailing〖9〗",
      "adjacent〖1〗〖2〗markers",
      "全文无空号的真题句。",
    ];
    for (const sample of samples) expect(rejoin(sample)).toBe(sample);
  });

  it("空字符串 → 空数组（不产生空 text 段）", () => {
    expect(segmentPassageBlanks("")).toEqual([]);
  });

  it("非数字占位（〖abc〗/〖〗）不识别为空号，按正文原样保留", () => {
    const text = "keep 〖abc〗 and 〖〗 as text";
    expect(segmentPassageBlanks(text)).toEqual([{ kind: "text", text }]);
  });

  it("反复调用互不污染（g 正则的 lastIndex 不被跨调用带跑）", () => {
    const text = "〖7〗once";
    // 若共享同一个 g 正则实例，第二次调用会从上次的 lastIndex 继续 ⇒ 漏掉占位符。
    expect(segmentPassageBlanks(text)).toEqual(segmentPassageBlanks(text));
    expect(segmentPassageBlanks(text)[0]).toMatchObject({ kind: "blank", blankNo: 7 });
  });
});

describe("hasPassageBlank", () => {
  it("有占位 → true；无占位 / 非数字占位 → false", () => {
    expect(hasPassageBlank("〖45〗 x")).toBe(true);
    expect(hasPassageBlank("plain sentence")).toBe(false);
    expect(hasPassageBlank("〖x〗")).toBe(false);
  });

  it("不因 g 正则状态造成漏判（连续调用同结果）", () => {
    const text = "〖1〗a";
    expect(hasPassageBlank(text)).toBe(true);
    expect(hasPassageBlank(text)).toBe(true);
  });
});

describe("PASSAGE_BLANK_RE / createPassageBlankRe", () => {
  it("正则 source 稳定（L3 卷面按 source 复用，改 source 会同时影响两侧）", () => {
    expect(PASSAGE_BLANK_RE.source).toBe("〖(\\d+)〗");
  });

  it("createPassageBlankRe 每次返回全新实例（lastIndex 从 0 开始）", () => {
    const first = createPassageBlankRe();
    first.exec("〖1〗〖2〗");
    expect(first.lastIndex).toBeGreaterThan(0);

    const second = createPassageBlankRe();
    expect(second.lastIndex).toBe(0);
    expect(second.exec("〖1〗")?.[1]).toBe("1");
  });
});
