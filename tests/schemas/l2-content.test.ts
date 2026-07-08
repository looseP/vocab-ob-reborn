import { describe, it, expect } from "vitest";
import {
  parseL2Content,
  safeParseL2Content,
  isValidL2Content,
} from "@/schemas/service";
import type { z } from "zod";

// ── Legacy array fixtures (must keep passing) ──────────────────────────
const LEGACY_COLLOCATION = [
  {
    phrase: "abandon ship",
    gloss: "弃船",
    tone: "neutral",
    example: "The captain ordered to abandon ship.",
    exampleTranslation: "船长下令弃船。",
  },
];
const LEGACY_CORPUS = [
  {
    text: "They had to abandon the project.",
    translation: "他们不得不放弃这个项目。",
    source: "generated",
  },
];

// ── v1 wrapper helpers ─────────────────────────────────────────────────
function v1CollocationItem(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    phrase: "abandon hope",
    provenance: { source: "manual" },
    ...overrides,
  };
}

function v1CorpusItem(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sentence: "They abandoned all hope of rescue.",
    translation: "他们放弃了所有获救的希望。",
    provenance: { source: "manual" },
    ...overrides,
  };
}

function v1Wrapper(
  field: string,
  items: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: "l2-content-v1",
    field,
    items,
    ...extra,
  };
}

describe("parseL2Content — v1 wrapper", () => {
  it("parseL2Content('collocation', v1Wrapper) returns parsed content (not { success })", () => {
    const wrapper = v1Wrapper("collocation", [v1CollocationItem()]);
    const parsed = parseL2Content("collocation", wrapper) as {
      schemaVersion: string;
      field: string;
      items: unknown[];
    };

    expect(parsed.schemaVersion).toBe("l2-content-v1");
    // field is normalized to the storage name
    expect(parsed.field).toBe("collocation");
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items).toHaveLength(1);
    // it is NOT a { success, data } envelope
    expect(parsed).not.toHaveProperty("success");
  });

  it("safeParseL2Content('collocation', v1Wrapper).success === true", () => {
    const wrapper = v1Wrapper("collocation", [v1CollocationItem()]);
    const result = safeParseL2Content("collocation", wrapper);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty("schemaVersion", "l2-content-v1");
    }
  });

  it("maps wrapper field 'example' to storage 'corpus' and validates items", () => {
    const wrapper = v1Wrapper("example", [v1CorpusItem()]);
    const parsed = parseL2Content("corpus", wrapper) as {
      field: string;
      items: unknown[];
    };
    // returned wrapper field is normalized to the storage name
    expect(parsed.field).toBe("corpus");
    expect(parsed.items).toHaveLength(1);
  });

  it("preserves provenance/evidence in parsed v1 collocation items", () => {
    const item = v1CollocationItem({
      evidence: { dictionaryName: "OALD", rawPhrase: "abandon hope" },
      provenance: { source: "dictionary", dictionaryName: "OALD" },
    });
    const parsed = parseL2Content("collocation", v1Wrapper("collocation", [item])) as {
      items: Array<{ evidence: { dictionaryName: string }; provenance: { source: string } }>;
    };
    expect(parsed.items[0].evidence.dictionaryName).toBe("OALD");
    expect(parsed.items[0].provenance.source).toBe("dictionary");
  });
});

describe("parseL2Content — v1 collocation validation", () => {
  it("rejects v1 collocation item without provenance.source", () => {
    const item = v1CollocationItem({ provenance: {} });
    expect(() =>
      parseL2Content("collocation", v1Wrapper("collocation", [item])),
    ).toThrow();
  });

  it("rejects v1 collocation item without provenance at all", () => {
    const item = { phrase: "abandon hope" };
    expect(() =>
      parseL2Content("collocation", v1Wrapper("collocation", [item])),
    ).toThrow();
  });

  it("rejects 'dictionary' collocation without dictionary evidence", () => {
    const item = v1CollocationItem({
      provenance: { source: "dictionary" },
      // no dictionaryName in provenance or evidence
    });
    const result = safeParseL2Content(
      "collocation",
      v1Wrapper("collocation", [item]),
    );
    expect(result.success).toBe(false);
  });

  it("rejects 'dictionary_llm_refined' collocation without dictionary evidence", () => {
    const item = v1CollocationItem({
      provenance: { source: "dictionary_llm_refined" },
    });
    expect(
      safeParseL2Content("collocation", v1Wrapper("collocation", [item]))
        .success,
    ).toBe(false);
  });

  it("rejects 'external_chat' collocation without dictionary evidence", () => {
    const item = v1CollocationItem({
      provenance: { source: "external_chat" },
    });
    expect(
      safeParseL2Content("collocation", v1Wrapper("collocation", [item]))
        .success,
    ).toBe(false);
  });

  it("rejects 'external_chat' collocation without evidence.rawPhrase", () => {
    const item = v1CollocationItem({
      provenance: { source: "external_chat" },
      evidence: { dictionaryName: "Datamuse" },
    });
    expect(
      safeParseL2Content("collocation", v1Wrapper("collocation", [item]))
        .success,
    ).toBe(false);
  });

  it("accepts 'external_chat' collocation with dictionary evidence and rawPhrase", () => {
    const item = v1CollocationItem({
      provenance: { source: "external_chat", externalTool: "chatgpt" },
      evidence: { dictionaryName: "Datamuse", rawPhrase: "abandon hope" },
    });
    expect(
      safeParseL2Content("collocation", v1Wrapper("collocation", [item]))
        .success,
    ).toBe(true);
  });

  it("rejects 'llm' collocation without dictionary evidence", () => {
    const item = v1CollocationItem({
      provenance: { source: "llm" },
    });
    expect(
      safeParseL2Content("collocation", v1Wrapper("collocation", [item]))
        .success,
    ).toBe(false);
  });

  it("accepts 'dictionary' collocation when dictionaryName is in provenance", () => {
    const item = v1CollocationItem({
      provenance: { source: "dictionary", dictionaryName: "OALD" },
    });
    expect(
      safeParseL2Content("collocation", v1Wrapper("collocation", [item]))
        .success,
    ).toBe(true);
  });

  it("accepts 'dictionary' collocation when dictionaryName is in evidence", () => {
    const item = v1CollocationItem({
      provenance: { source: "dictionary" },
      evidence: { dictionaryName: "OALD" },
    });
    expect(
      safeParseL2Content("collocation", v1Wrapper("collocation", [item]))
        .success,
    ).toBe(true);
  });

  it("rejects v1 collocation with an empty phrase", () => {
    const item = v1CollocationItem({ phrase: "   " });
    expect(
      safeParseL2Content("collocation", v1Wrapper("collocation", [item]))
        .success,
    ).toBe(false);
  });

  it("rejects v1 wrapper with empty items array", () => {
    const wrapper = v1Wrapper("collocation", []);
    expect(safeParseL2Content("collocation", wrapper).success).toBe(false);
  });

  it("rejects v1 wrapper whose field does not match the requested field", () => {
    const wrapper = v1Wrapper("corpus", [v1CorpusItem()]);
    expect(() => parseL2Content("collocation", wrapper)).toThrow();
  });
});

describe("parseL2Content — v1 corpus validation", () => {
  it("v1 corpus supports 'sentence'", () => {
    const item = v1CorpusItem({ sentence: "They abandoned the project." });
    expect(
      safeParseL2Content("corpus", v1Wrapper("corpus", [item])).success,
    ).toBe(true);
  });

  it("v1 corpus supports legacy 'text'", () => {
    const item = v1CorpusItem({
      sentence: undefined,
      text: "They abandoned the project.",
      provenance: { source: "manual" },
    });
    const result = safeParseL2Content("corpus", v1Wrapper("corpus", [item]));
    expect(result.success).toBe(true);
  });

  it("rejects v1 corpus without provenance", () => {
    const item = {
      sentence: "They abandoned the project.",
      // no provenance
    };
    expect(
      safeParseL2Content("corpus", v1Wrapper("corpus", [item])).success,
    ).toBe(false);
  });

  it("rejects v1 corpus with neither sentence nor text", () => {
    const item = v1CorpusItem({
      sentence: undefined,
      text: undefined,
      provenance: { source: "manual" },
    });
    expect(
      safeParseL2Content("corpus", v1Wrapper("corpus", [item])).success,
    ).toBe(false);
  });

  it("accepts v1 corpus via 'example' composer field", () => {
    const wrapper = v1Wrapper("example", [v1CorpusItem()]);
    expect(safeParseL2Content("corpus", wrapper).success).toBe(true);
  });
});

describe("parseL2Content — legacy array fixtures still pass", () => {
  it("accepts legacy collocation array", () => {
    expect(() => parseL2Content("collocation", LEGACY_COLLOCATION)).not.toThrow();
    expect(isValidL2Content("collocation", LEGACY_COLLOCATION)).toBe(true);
  });

  it("accepts legacy corpus array", () => {
    expect(() => parseL2Content("corpus", LEGACY_CORPUS)).not.toThrow();
    expect(isValidL2Content("corpus", LEGACY_CORPUS)).toBe(true);
  });

  it("rejects legacy collocation array with a bad item", () => {
    expect(() =>
      parseL2Content("collocation", [{ phrase: "abandon ship" }]),
    ).toThrow();
    expect(
      isValidL2Content("collocation", [{ phrase: "abandon ship" }]),
    ).toBe(false);
  });
});

describe("safeParseL2Content — error shape", () => {
  it("returns { success: false, error } for invalid legacy content", () => {
    const result = safeParseL2Content("collocation", [{ phrase: "x" }]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("returns { success: false, error } for invalid v1 wrapper", () => {
    const item = v1CollocationItem({ provenance: {} });
    const result = safeParseL2Content(
      "collocation",
      v1Wrapper("collocation", [item]),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      // zod error
      expect((result.error as z.ZodError).issues).toBeDefined();
    }
  });
});
