import { describe, expect, it } from "vitest";
import {
  buildPassageSpans,
  enclosingSentence,
  groupSpansIntoParagraphs,
  type PassageAnnotationMarker,
  type PassageSpan,
} from "@/frontend/components/l3/examPassageSpans";

function kinds(spans: PassageSpan[]): Array<PassageSpan["kind"]> {
  return spans.map((span) => span.kind);
}

describe("buildPassageSpans", () => {
  it("returns one text span for plain content", () => {
    const spans = buildPassageSpans("The quiet passage.", {});
    expect(kinds(spans)).toEqual(["text"]);
    expect(spans[0]).toMatchObject({ start: 0, end: 18 });
  });

  it("splits blank placeholders with their number", () => {
    const spans = buildPassageSpans("甲〖1〗乙", {});
    expect(spans).toHaveLength(3);
    expect(spans[0]).toMatchObject({ kind: "text", start: 0, end: 1 });
    expect(spans[1]).toMatchObject({ kind: "blank", start: 1, end: 4, blankNo: 1 });
    expect(spans[2]).toMatchObject({ kind: "text", start: 4, end: 5 });
  });

  it("handles multi-digit blank numbers", () => {
    const spans = buildPassageSpans("a〖41〗b", {});
    expect(spans[1]).toMatchObject({ kind: "blank", start: 1, end: 5, blankNo: 41 });
  });

  it("emits annotation marks for anchored entries", () => {
    const annotations: PassageAnnotationMarker[] = [
      { id: "ann-1", anchorStart: 4, anchorEnd: 9 },
    ];
    const spans = buildPassageSpans("The trap phrase here.", { annotations });
    const marks = spans.filter((s) => s.kind === "annotation");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ start: 4, end: 9, annotationId: "ann-1" });
    expect(spans[0]).toMatchObject({ kind: "text", start: 0, end: 4 });
  });

  it("emits evidence marks only in analysis mode and merges neighbours", () => {
    const evidence = [{ start: 0, end: 4 }];
    expect(kinds(buildPassageSpans("Evidence here.", { evidence, showEvidence: false })))
      .toEqual(["text"]);
    const spans = buildPassageSpans("Evidence here.", { evidence, showEvidence: true });
    expect(spans[0]).toMatchObject({ kind: "evidence", start: 0, end: 4 });
    expect(spans[1]).toMatchObject({ kind: "text", start: 4, end: 14 });
  });

  it("gives blanks precedence over overlapping evidence/annotations", () => {
    const spans = buildPassageSpans("x〖1〗yz", {
      evidence: [{ start: 0, end: 6 }],
      annotations: [{ id: "a1", anchorStart: 2, anchorEnd: 5 }],
      showEvidence: true,
    });
    // 〖1〗 区间 [1,4) 必须是 blank；其前后才是 evidence（evidence 覆盖到串尾）
    expect(spans.map((s) => [s.kind, s.start, s.end])).toEqual([
      ["evidence", 0, 1],
      ["blank", 1, 4],
      ["evidence", 4, 6],
    ]);
  });

  it("gives evidence precedence over annotations on overlap (analysis mode)", () => {
    const spans = buildPassageSpans("abcdefgh", {
      evidence: [{ start: 2, end: 6 }],
      annotations: [{ id: "a1", anchorStart: 4, anchorEnd: 8 }],
      showEvidence: true,
    });
    expect(spans.map((s) => [s.kind, s.start, s.end, s.annotationId ?? null])).toEqual([
      ["text", 0, 2, null],
      ["evidence", 2, 6, null],
      ["annotation", 6, 8, "a1"],
    ]);
  });

  it("drops out-of-range or inverted annotation anchors", () => {
    const content = "short";
    const annotations: PassageAnnotationMarker[] = [
      { id: "bad-start", anchorStart: -1, anchorEnd: 3 },
      { id: "bad-order", anchorStart: 4, anchorEnd: 4 },
      { id: "bad-end", anchorStart: 3, anchorEnd: 99 },
      { id: "good", anchorStart: 0, anchorEnd: 2 },
    ];
    const spans = buildPassageSpans(content, { annotations });
    expect(spans.filter((s) => s.kind === "annotation").map((s) => s.annotationId))
      .toEqual(["good"]);
  });

  it("covers every content codepoint exactly once (no gaps, no overlaps)", () => {
    const spans = buildPassageSpans("甲〖1〗The trap〖2〗end.", {
      evidence: [{ start: 6, end: 10 }],
      annotations: [{ id: "a1", anchorStart: 6, anchorEnd: 10 }],
      showEvidence: true,
    });
    let cursor = 0;
    for (const span of spans) {
      expect(span.start).toBe(cursor);
      cursor = span.end;
    }
    expect(cursor).toBe("甲〖1〗The trap〖2〗end.".length);
  });
});

describe("buildPassageSpans · marks 通道（v2 §4.6 划重点）", () => {
  it("emits mark spans for passage marks", () => {
    const spans = buildPassageSpans("abcdefgh", { marks: [{ start: 2, end: 6 }] });
    expect(spans.map((s) => [s.kind, s.start, s.end])).toEqual([
      ["text", 0, 2],
      ["mark", 2, 6],
      ["text", 6, 8],
    ]);
  });

  it("precedence: blank > evidence > mark > annotation（底色冲突时官方/结构优先）", () => {
    // blank 覆盖 mark
    expect(buildPassageSpans("x〖1〗y", { marks: [{ start: 0, end: 5 }] }).map((s) => s.kind))
      .toEqual(["mark", "blank", "mark"]);
    // evidence 覆盖 mark（解析模式）
    expect(buildPassageSpans("abcdefgh", {
      evidence: [{ start: 2, end: 6 }],
      marks: [{ start: 4, end: 8 }],
      showEvidence: true,
    }).map((s) => [s.kind, s.start, s.end])).toEqual([
      ["text", 0, 2],
      ["evidence", 2, 6],
      ["mark", 6, 8],
    ]);
    // mark 覆盖 annotation（marks 无其他出口；注记在题卡列表仍可见）
    expect(buildPassageSpans("abcdefgh", {
      marks: [{ start: 2, end: 6 }],
      annotations: [{ id: "a1", anchorStart: 4, anchorEnd: 8 }],
    }).map((s) => [s.kind, s.start, s.end])).toEqual([
      ["text", 0, 2],
      ["mark", 2, 6],
      ["annotation", 6, 8],
    ]);
  });

  it("parseBlanks: false keeps 〖n〗 as plain text（题干渲染用）", () => {
    const spans = buildPassageSpans("21. 〖1〗的含义", { parseBlanks: false, marks: [{ start: 4, end: 7 }] });
    expect(spans.map((s) => [s.kind, s.start, s.end])).toEqual([
      ["text", 0, 4],
      ["mark", 4, 7],
      ["text", 7, 10],
    ]);
  });

  it("drops out-of-range or inverted marks", () => {
    const spans = buildPassageSpans("short", {
      marks: [{ start: -1, end: 2 }, { start: 3, end: 99 }, { start: 1, end: 1 }],
    });
    expect(kinds(spans)).toEqual(["text"]);
  });
});

describe("enclosingSentence", () => {
  it("expands to the nearest Chinese/English sentence boundaries", () => {
    const content = "第一句很短。第二句藏着考点词在这里！第三句。";
    // "考点词" 位于第二句
    const start = content.indexOf("考点词");
    const end = start + "考点词".length;
    expect(enclosingSentence(content, start, end)).toBe("第二句藏着考点词在这里！");
  });

  it("falls back to the selection itself when no boundary exists", () => {
    const content = "no boundaries at all";
    expect(enclosingSentence(content, 3, 12)).toBe("no boundaries at all");
  });
});

describe("groupSpansIntoParagraphs", () => {
  it("splits text runs on newlines into separate paragraphs with global offsets", () => {
    const content = "First paragraph.\nSecond one here.";
    const paragraphs = groupSpansIntoParagraphs(buildPassageSpans(content, {}), content);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.runs).toEqual([
      { start: 0, end: 16, kind: "text", text: "First paragraph." },
    ]);
    expect(paragraphs[1]!.runs).toEqual([
      { start: 17, end: 33, kind: "text", text: "Second one here." },
    ]);
    expect(paragraphs.every((p) => !p.blank)).toBe(true);
  });

  it("represents a blank line as a blank paragraph (paragraph spacing)", () => {
    const content = "Para one.\n\nPara two.";
    const paragraphs = groupSpansIntoParagraphs(buildPassageSpans(content, {}), content);
    expect(paragraphs.map((p) => p.blank)).toEqual([false, true, false]);
    expect(paragraphs[2]!.runs[0]).toMatchObject({ start: 11, text: "Para two." });
  });

  it("keeps blank placeholders inside the paragraph where they occur", () => {
    const content = "A〖1〗B\nC〖2〗D";
    const paragraphs = groupSpansIntoParagraphs(buildPassageSpans(content, {}), content);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.runs.map((r) => r.kind)).toEqual(["text", "blank", "text"]);
    expect(paragraphs[0]!.runs[1]).toMatchObject({ kind: "blank", blankNo: 1 });
    expect(paragraphs[1]!.runs.map((r) => r.kind)).toEqual(["text", "blank", "text"]);
    expect(paragraphs[1]!.runs[1]).toMatchObject({ kind: "blank", blankNo: 2 });
  });

  it("splits a cross-paragraph annotation into runs sharing the annotationId", () => {
    const content = "abc\nfgh";
    const annotations: PassageAnnotationMarker[] = [{ id: "a1", anchorStart: 1, anchorEnd: 7 }];
    const spans = buildPassageSpans(content, { annotations });
    const paragraphs = groupSpansIntoParagraphs(spans, content);
    const annotationRuns = paragraphs.flatMap((p) => p.runs).filter((r) => r.kind === "annotation");
    expect(annotationRuns.map((r) => [r.start, r.end, r.text])).toEqual([
      [1, 3, "bc"],
      [4, 7, "fgh"],
    ]);
    expect(annotationRuns.every((r) => r.annotationId === "a1")).toBe(true);
  });
});
