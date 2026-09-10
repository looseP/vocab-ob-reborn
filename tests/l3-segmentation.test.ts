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

  it("bounds the backward abbreviation scan on a long word before a period", () => {
    // Drives the wordBeforeDot length guard: without the break the scan would
    // walk back to the start of the text looking for an abbreviation.
    const text = "Supercalifragilisticexpialidocious. Next one.";
    const segs = splitSentences(text);
    expect(segs.map((s) => s.text.trim())).toEqual([
      "Supercalifragilisticexpialidocious.",
      "Next one.",
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

  it("falls back to a paragraph-level range when the selection spans sentences", () => {
    // Selection runs from inside "beta" into "Gamma": no single segment contains
    // it, so the fallback takes the first sentence ending after selStart and the
    // last sentence starting before selEnd.
    const selStart = text.indexOf("beta");
    const selEnd = text.indexOf("Gamma") + 5;
    expect(findSentenceRange(text, selStart, selEnd)).toEqual(
      expect.objectContaining({ start: 0, end: 32 }),
    );
  });

  it("falls back to the first/last segment when the selection has no match at either end", () => {
    // Selection entirely past the end: no segment ends after selStart, so the
    // first-segment fallback arm of the `??` is taken. It still pairs with the
    // last segment that starts before selEnd, hence the whole-text range.
    expect(findSentenceRange(text, text.length + 10, text.length + 20)).toEqual(
      expect.objectContaining({ start: 0, end: text.length }),
    );
    // Selection entirely before the start (and before every segment): no segment
    // starts before selEnd, so the last-segment fallback arm is taken.
    expect(findSentenceRange(text, -1, -1)).toEqual(
      expect.objectContaining({ start: 0, end: text.length }),
    );
  });
});
