import { describe, expect, it } from "vitest";
import {
  L3_QUESTION_TYPES,
  L3_QUESTION_TYPE_LABELS,
  PAPER_PAYLOAD_VERSION,
  questionTypeAllowsSourceless,
  questionTypeSpace,
  validatePaperPayloadShape,
} from "@/domain/l3-question-types";

describe("question type taxonomy (ADR-0030 §3)", () => {
  it("exposes exactly the seven settled question types with Chinese labels", () => {
    expect([...L3_QUESTION_TYPES]).toEqual([
      "cloze",
      "reading_choice",
      "new_question",
      "sentence_translation",
      "short_essay",
      "long_essay",
      "grammar_blank",
    ]);
    for (const type of L3_QUESTION_TYPES) {
      expect(L3_QUESTION_TYPE_LABELS[type]).toBeTruthy();
    }
  });

  it("maps every question type onto exactly one capability space", () => {
    expect(questionTypeSpace("cloze")).toBe("阅读");
    expect(questionTypeSpace("reading_choice")).toBe("阅读");
    expect(questionTypeSpace("new_question")).toBe("阅读");
    expect(questionTypeSpace("sentence_translation")).toBe("翻译");
    expect(questionTypeSpace("short_essay")).toBe("作文");
    expect(questionTypeSpace("long_essay")).toBe("作文");
    expect(questionTypeSpace("grammar_blank")).toBe("语法");
  });

  it("allows sourceless groups only for translation and essays", () => {
    expect(questionTypeAllowsSourceless("sentence_translation")).toBe(true);
    expect(questionTypeAllowsSourceless("short_essay")).toBe(true);
    expect(questionTypeAllowsSourceless("long_essay")).toBe(true);
    expect(questionTypeAllowsSourceless("cloze")).toBe(false);
    expect(questionTypeAllowsSourceless("reading_choice")).toBe(false);
    expect(questionTypeAllowsSourceless("new_question")).toBe(false);
    expect(questionTypeAllowsSourceless("grammar_blank")).toBe(false);
  });
});

describe("validatePaperPayloadShape (ADR-0030 §2 护栏①)", () => {
  const validSection = (overrides: Record<string, unknown> = {}) => ({
    key: "s1",
    title: "Text 1",
    questionType: "reading_choice",
    sourceId: "00000000-0000-4000-8000-000000000001",
    fileKey: null,
    questionIds: ["00000000-0000-4000-8000-000000000101"],
    ...overrides,
  });

  it("accepts a well-formed v1 payload and trims strings", () => {
    const payload = validatePaperPayloadShape({
      version: PAPER_PAYLOAD_VERSION,
      sections: [validSection({ title: "  Text 1  " })],
    });
    expect(payload.version).toBe(1);
    expect(payload.sections[0].title).toBe("Text 1");
  });

  it("rejects wrong version, non-object and empty section lists", () => {
    expect(() => validatePaperPayloadShape(null)).toThrow(/object/);
    expect(() => validatePaperPayloadShape({ version: 2, sections: [validSection()] })).toThrow(/version/);
    expect(() => validatePaperPayloadShape({ version: 1, sections: [] })).toThrow(/at least one section/);
  });

  it("rejects duplicate section keys and duplicate question references", () => {
    expect(() => validatePaperPayloadShape({
      version: 1,
      sections: [validSection(), validSection()],
    })).toThrow(/duplicate section key/);
    expect(() => validatePaperPayloadShape({
      version: 1,
      sections: [
        validSection(),
        validSection({
          key: "s2",
          questionIds: ["00000000-0000-4000-8000-000000000101"],
        }),
      ],
    })).toThrow(/referenced more than once/);
  });

  it("requires a file identity (sourceId or fileKey) and a valid question type", () => {
    expect(() => validatePaperPayloadShape({
      version: 1,
      sections: [validSection({ sourceId: null, fileKey: null })],
    })).toThrow(/sourceId or fileKey/);
    expect(() => validatePaperPayloadShape({
      version: 1,
      sections: [validSection({ questionType: "matching" })],
    })).toThrow(/invalid question_type/);
  });

  it("rejects sections without questions and blank scalar fields", () => {
    expect(() => validatePaperPayloadShape({
      version: 1,
      sections: [validSection({ questionIds: [] })],
    })).toThrow(/non-empty array/);
    expect(() => validatePaperPayloadShape({
      version: 1,
      sections: [validSection({ title: "   " })],
    })).toThrow(/title/);
  });
});
