import { describe, expect, it } from "vitest";
import { parseRawTextImport } from "@/l3/import/parser";

describe("parseRawTextImport", () => {
  it("splits English sentences and preserves original context text", () => {
    const result = parseRawTextImport("One vivid day. Another storm?", [], { contextType: "sentence" });

    expect(result.contexts.map((context) => context.text)).toEqual(["One vivid day.", "Another storm?"]);
    expect(result.contexts[0].startOffset).toBe(0);
    expect(result.contexts[0].endOffset).toBe("One vivid day.".length);
  });

  it("splits paragraphs on blank lines", () => {
    const result = parseRawTextImport("First paragraph.\n\nSecond paragraph.", [], { contextType: "paragraph" });

    expect(result.contexts.map((context) => context.text)).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("matches target slugs case-insensitively while preserving surface slices", () => {
    const result = parseRawTextImport("A Vivid account. vividness is different.", [{ slug: "vivid" }]);

    expect(result.contexts[0].occurrences).toEqual([
      expect.objectContaining({
        slug: "vivid",
        surface: "Vivid",
        startOffset: 2,
        endOffset: 7,
      }),
    ]);
    expect(result.contexts[1].occurrences).toHaveLength(0);
  });

  it("keeps occurrence offsets aligned to each context text slice", () => {
    const result = parseRawTextImport("Storm, storm, storm.", [{ slug: "storm" }]);

    for (const occurrence of result.contexts[0].occurrences) {
      expect(result.contexts[0].text.slice(occurrence.startOffset, occurrence.endOffset)).toBe(occurrence.surface);
    }
  });

  it("applies max contexts and max occurrences limits", () => {
    const result = parseRawTextImport(
      "storm storm storm storm. vivid. final.",
      [{ slug: "storm" }],
      { maxContexts: 2, maxOccurrencesPerWordPerContext: 2 },
    );

    expect(result.contexts).toHaveLength(2);
    expect(result.contexts[0].occurrences).toHaveLength(2);
    expect(result.skippedContextCount).toBe(1);
  });

  it("warns when maxContexts truncates contexts and counts all skipped contexts", () => {
    const result = parseRawTextImport(
      "x. One vivid day. Two vivid days. Three vivid days.",
      [{ slug: "vivid" }],
      { maxContexts: 2, minContextLength: 3 },
    );

    expect(result.contexts.map((context) => context.text)).toEqual(["One vivid day.", "Two vivid days."]);
    expect(result.skippedContextCount).toBe(2);
    expect(result.warnings).toContain("Context limit reached; remaining contexts skipped.");
  });

  it("generates no occurrences when target words are absent", () => {
    const result = parseRawTextImport("A vivid account.");

    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0].occurrences).toHaveLength(0);
    expect(result.warnings).toContain("No targetWords supplied; occurrences were not generated.");
  });
});
