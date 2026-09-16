import { describe, expect, it } from "vitest";
import {
  buildPassageSpans,
  enclosingSentence,
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
