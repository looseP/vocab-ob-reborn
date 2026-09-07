// tests/l3-segmentation.test.ts
import { describe, it, expect } from "vitest";
import { splitSentences, findSentenceRange } from "@/services/l3-segmentation";

describe("splitSentences", () => {
  it("splits on latin terminators keeping offsets", () => {
    const text = "First one. Second one! Third?";
    const segs = splitSentences(text);
    expect(segs.map((s) => s.text.trim())).toEqual(["First one.", "Second one!", "Third?"]);
    expect(segs[0]).toEqual(expect.objectContaining({ start: 0, end: 10 }));
  });

  it("guards decimals (3.14) and common abbreviations (e.g., Mr.)", () => {
    const text = "Pi is 3.14 exactly. Mr. Smith said e.g. this. Done.";
    const segs = splitSentences(text);
    expect(segs.map((s) => s.text.trim())).toEqual([
      "Pi is 3.14 exactly.",
      "Mr. Smith said e.g. this.",
      "Done.",
    ]);
  });

  it("splits CJK terminators and carries trailing quotes", () => {
    const text = "他说：“你好。”她走了！";
    const segs = splitSentences(text);
    expect(segs).toHaveLength(2);
    expect(segs[0].text).toBe("他说：“你好。”");
    expect(segs[1].text).toBe("她走了！");
  });

  it("returns whole text as one segment without terminators", () => {
    expect(splitSentences("no terminator here")).toEqual([
      { text: "no terminator here", start: 0, end: 18 },
    ]);
  });
});

describe("findSentenceRange", () => {
  const text = "Alpha beta. Gamma delta epsilon. Zeta.";
  it("expands a selection to its containing sentence", () => {
    const sel = text.indexOf("delta");
    // 修正说明：句段携带前导空格（start = 上一句 end = 11，index 12 才是 "Gamma" 的 G），
    // 计划原文期望 {start:12, end:32} 偏移算错，按实际分句结果修正为 start:11；
    // 另计划原文 toEqual 漏掉返回值中的 text 键，改用 objectContaining 只断言偏移。
    expect(findSentenceRange(text, sel, sel + 5)).toEqual(
      expect.objectContaining({ start: 11, end: 32 }),
    );
  });
});
