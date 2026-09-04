import { describe, it, expect } from "vitest";
import { parseLlmJson } from "@/llm/parser";

describe("parseLlmJson", () => {
  it("parses clean JSON array", () => {
    const result = parseLlmJson('[{"phrase":"abundant evidence"}]');
    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ phrase: "abundant evidence" }]);
  });

  it("parses JSON wrapped in markdown code block", () => {
    const result = parseLlmJson('```json\n[{"phrase":"abundant evidence"}]\n```');
    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ phrase: "abundant evidence" }]);
  });

  it("parses JSON with leading/trailing text", () => {
    const result = parseLlmJson('Here are the collocations:\n[{"phrase":"abundant evidence"}]\nDone.');
    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ phrase: "abundant evidence" }]);
  });

  it("returns failure for non-JSON", () => {
    const result = parseLlmJson("I cannot generate collocations for this word.");
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.raw).toBe("I cannot generate collocations for this word.");
  });

  it("returns failure for malformed JSON", () => {
    const result = parseLlmJson('[{phrase: "missing quotes"}]');
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
  });

  it("extracts JSON object (not just array)", () => {
    const result = parseLlmJson('{"phrase":"abundant evidence","gloss":"充分证据"}');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ phrase: "abundant evidence", gloss: "充分证据" });
  });

  it("returns raw content on failure", () => {
    const result = parseLlmJson("not json at all");
    expect(result.raw).toBe("not json at all");
  });
});
