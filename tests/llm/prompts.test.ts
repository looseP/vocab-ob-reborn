import { describe, it, expect } from "vitest";
import { buildCollocationPrompt } from "@/llm/prompts/collocations";
import { buildExamplePrompt } from "@/llm/prompts/examples";
import { buildSynonymPrompt } from "@/llm/prompts/synonyms";
import { buildAntonymPrompt } from "@/llm/prompts/antonyms";
import { buildPromptForField } from "@/llm/prompts";
import type { DictionaryCandidate } from "@/dictionary/provider";
import { getStyleProfile } from "@/domain/l2-style-profile";

const WORD_CONTEXT = {
  lemma: "abundant",
  pos: "adj.",
  semanticField: "自然物理",
  shortDefinition: "大量存在的",
  cefrTarget: "雅思",
};

describe("buildCollocationPrompt", () => {
  it("returns system + user messages", () => {
    const messages = buildCollocationPrompt(WORD_CONTEXT, { count: 2, cefrTarget: "雅思" });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });

  it("system prompt specifies JSON output format", () => {
    const messages = buildCollocationPrompt(WORD_CONTEXT, { count: 2, cefrTarget: "雅思" });
    expect(messages[0].content).toContain("JSON");
    expect(messages[0].content).toContain("phrase");
  });

  it("user prompt contains word + semantic field", () => {
    const messages = buildCollocationPrompt(WORD_CONTEXT, { count: 2, cefrTarget: "雅思" });
    expect(messages[1].content).toContain("abundant");
    expect(messages[1].content).toContain("自然物理");
  });
});

describe("buildExamplePrompt", () => {
  it("returns system + user messages with domain preference", () => {
    const messages = buildExamplePrompt(WORD_CONTEXT, {
      domains: ["科技", "商业"],
      difficulty: "雅思7分",
      count: 1,
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("JSON");
    expect(messages[1].content).toContain("科技");
    expect(messages[1].content).toContain("商业");
  });
});

describe("buildSynonymPrompt", () => {
  it("returns system + user messages", () => {
    const messages = buildSynonymPrompt(WORD_CONTEXT, { count: 2 });
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("semanticDiff");
    expect(messages[0].content).toContain("tone");
  });
});

describe("buildAntonymPrompt", () => {
  it("returns system + user messages", () => {
    const messages = buildAntonymPrompt(WORD_CONTEXT, { count: 2 });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });

  it("system prompt specifies JSON output format with the synonym-shape keys", () => {
    const messages = buildAntonymPrompt(WORD_CONTEXT, { count: 2 });
    expect(messages[0].content).toContain("JSON");
    // output shape must be compatible with l2SynonymItemSchema
    expect(messages[0].content).toContain("semanticDiff");
    expect(messages[0].content).toContain("tone");
    expect(messages[0].content).toContain("usage");
    expect(messages[0].content).toContain("delta");
    expect(messages[0].content).toContain("object");
  });

  it("system prompt demands contrast/antonym semantics and a usage boundary", () => {
    const messages = buildAntonymPrompt(WORD_CONTEXT, { count: 2 });
    // asks for antonyms / contrast, not synonyms
    expect(messages[0].content).toMatch(/反义|对立/);
    // asks for a usage boundary between the word and its antonym
    expect(messages[0].content).toMatch(/用法边界|边界|何时/);
  });

  it("user prompt contains the word lemma / pos / semanticField / shortDefinition", () => {
    const messages = buildAntonymPrompt(WORD_CONTEXT, { count: 2 });
    expect(messages[1].content).toContain("abundant");
    expect(messages[1].content).toContain("adj.");
    expect(messages[1].content).toContain("自然物理");
    expect(messages[1].content).toContain("大量存在的");
  });

  it("reflects the requested count in the system prompt", () => {
    const messages = buildAntonymPrompt(WORD_CONTEXT, { count: 3 });
    expect(messages[0].content).toContain("3 个");
  });
});

// ── B3: dictionary-grounded collocation prompt ─────────────────────────
const DICT_CANDIDATES: DictionaryCandidate[] = [
  {
    phrase: "abundant rainfall",
    headword: "rainfall",
    sourceName: "Datamuse",
    sourceUrl: "https://api.datamuse.com/words?rel_jja=abundant",
    relation: "rel_jja",
    score: 100,
  },
  {
    phrase: "abundant evidence",
    headword: "evidence",
    meaning: "充分的证据",
    sourceName: "Datamuse",
    relation: "rel_jja",
    score: 90,
  },
];

describe("buildCollocationPrompt — dictionary grounding (B3)", () => {
  it("includes the candidate phrases in the prompt when candidates are supplied", () => {
    const messages = buildCollocationPrompt(
      WORD_CONTEXT,
      { count: 3, cefrTarget: "雅思" },
      { dictionaryCandidates: DICT_CANDIDATES },
    );
    expect(messages[0].content).toContain("abundant rainfall");
    expect(messages[0].content).toContain("abundant evidence");
    // candidate meaning is surfaced so the LLM can refine
    expect(messages[0].content).toContain("充分的证据");
  });

  it("forbids inventing collocations absent from the candidate list", () => {
    const messages = buildCollocationPrompt(
      WORD_CONTEXT,
      { count: 3, cefrTarget: "雅思" },
      { dictionaryCandidates: DICT_CANDIDATES },
    );
    // explicit grounding instruction — the dictionary is the sole source
    expect(messages[0].content).toMatch(/不得.{0,4}发明|do not invent|不得发明|不能新增候选|sole source of truth/i);
    expect(messages[0].content).toContain("dictionaryCandidates");
  });

  it("falls back to the ungrounded prompt when no candidates are supplied", () => {
    const messages = buildCollocationPrompt(WORD_CONTEXT, { count: 3, cefrTarget: "雅思" });
    // legacy ungrounded prompt asks to generate collocations freely
    expect(messages[0].content).toContain("3 个最值得记忆的搭配");
    expect(messages[0].content).not.toContain("dictionaryCandidates");
  });

  it("buildPromptForField threads dictionaryCandidates through the registry to collocation", () => {
    const messages = buildPromptForField("collocation", WORD_CONTEXT, {
      dictionaryCandidates: DICT_CANDIDATES,
    });
    expect(messages[0].content).toContain("abundant rainfall");
    expect(messages[0].content).toMatch(/不得.{0,4}发明|do not invent|不得发明|不能新增候选/i);
  });
});

// ── B4: example prompt with style profile ──────────────────────────────
describe("buildExamplePrompt — style profile (B4)", () => {
  it("injects the academic profile rules into the system message", () => {
    const profile = getStyleProfile("academic");
    const messages = buildExamplePrompt(
      WORD_CONTEXT,
      { domains: ["科技", "商业"], difficulty: "雅思", count: 2 },
      { styleProfile: profile },
    );
    // academic register + difficulty surface in the system message
    expect(messages[0].content).toContain("academic");
    expect(messages[0].content).toMatch(/学术|语体.*academic|register.*academic/i);
    // profile id is echoed so the style is identifiable
    expect(messages[0].content).toContain("academic");
  });

  it("profile maxItems overrides the config count", () => {
    const profile = getStyleProfile("academic"); // maxItems = 2
    const messages = buildExamplePrompt(
      WORD_CONTEXT,
      { domains: ["科技"], difficulty: "雅思", count: 5 },
      { styleProfile: profile },
    );
    expect(messages[0].content).toContain("2 个例句");
    expect(messages[0].content).not.toContain("5 个例句");
  });

  it("buildPromptForField threads the style profile through the registry to corpus", () => {
    const profile = getStyleProfile("postgraduate_essay");
    const messages = buildPromptForField("corpus", WORD_CONTEXT, { styleProfile: profile });
    // postgraduate_essay sets register=formal, avoidCliches=true
    expect(messages[0].content).toContain("formal");
    expect(messages[0].content).toMatch(/避免陈词滥调|cliché/i);
  });

  it("omits style rules when no profile is supplied (legacy prompt)", () => {
    const messages = buildPromptForField("corpus", WORD_CONTEXT);
    expect(messages[0].content).not.toContain("styleProfile");
    // legacy default domains still appear in the user message
    expect(messages[1].content).toContain("科技");
    expect(messages[1].content).toContain("商业");
  });
});
