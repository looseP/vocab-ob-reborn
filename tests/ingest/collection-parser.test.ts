import { describe, expect, it } from "vitest";
import {
  assessWordCompleteness,
  computeIngestHash,
  parseVocabCollection,
  slugifyHeadword,
} from "@/domain/ingest";

const SAMPLE_FILE = `# L1 雅思词汇 · 交通旅行

> 批次：交通旅行；本批词数：2。
> confidence 口径：source-backed 为主。

---

## accelerate

### Identity
- lemma: accelerate
- title: accelerate
- pos: v
- ipa: /əkˈseləreɪt/
- cefr: B1
- aliases: accelerates, accelerated, accelerating, acceleration

### Short Definition
加速

### Core Definitions
1. 加速（交通旅行语境中的基本义）
   - en: to increase speed; make faster
   - priority: 1
   - tags: core, v

### Prototype
accelerate = 加速：加速——人类跨越空间的方式与工具

### Morphology
- prefix: ad-
- root: celer（celerare "加快"）
- suffix: -atus
- family: accelerate, acceleration, accelerator, celerity

### Etymology Narrative
1520年代起用于英语，源自拉丁语 acceleratus。

### Mnemonic
- type: root
- text: ad-（向）+ celer（快）→ "向更快去"。

### Semantic Chain
ad- (to) + celer (swift) -> accelerare -> accelerate

### Reviewer Notes
- Etymonline accelerate：1520年代，源自拉丁语。
- confidence: source-backed

## dock

### Identity
- lemma: dock
- title: dock
- pos: n
- ipa:
- cefr: B1
- aliases: docks

### Short Definition
港口码头

### Core Definitions
1. 港口码头（交通旅行语境中的基本义）
   - en: a place for loading ships; a wharf
   - priority: 1
   - tags: core, n

### Prototype
dock = 港口码头

### Morphology


- prefix:
- root: dock（中古荷兰语 docke？来源不详）
- suffix:
- family: dock, docks, docker

### Etymology Narrative
15世纪末出现，指船坞；来源不详（可能来自中古荷兰语 docke）。

### Mnemonic
- type: root
- text: dock 指停泊船只的船坞；来源不详。

### Semantic Chain
MDu docke? -> dock

### Reviewer Notes
- Etymonline dock：15世纪末，指船坞。
- confidence: uncertain
`;

describe("slugifyHeadword", () => {
  it("supports multi-word phrases like the migration corpus", () => {
    expect(slugifyHeadword("slow down")).toBe("slow-down");
    expect(slugifyHeadword("traffic jam")).toBe("traffic-jam");
  });
});

describe("parseVocabCollection", () => {
  const parsed = parseVocabCollection(SAMPLE_FILE);

  it("extracts the collection header with blockquote notes", () => {
    expect(parsed.header.title).toBe("L1 雅思词汇 · 交通旅行");
    expect(parsed.header.notes).toHaveLength(2);
    expect(parsed.header.notes[0]).toContain("本批词数：2");
  });

  it("splits every ## entry and parses Identity fields", () => {
    expect(parsed.words).toHaveLength(2);
    const [accelerate] = parsed.words;
    expect(accelerate!.lemma).toBe("accelerate");
    expect(accelerate!.pos).toBe("v");
    expect(accelerate!.ipa).toBe("/əkˈseləreɪt/");
    expect(accelerate!.cefr).toBe("B1");
    expect(accelerate!.aliases).toEqual([
      "accelerates",
      "accelerated",
      "accelerating",
      "acceleration",
    ]);
  });

  it("parses multi-sense core definitions with sub-fields", () => {
    const [aboardLike] = parseVocabCollection(
      `# t\n\n---\n\n## aboard\n\n### Identity\n- lemma: aboard\n\n### Core Definitions\n1. 在交通工具上\n   - en: on or into a ship\n   - priority: 1\n   - tags: core\n\n2. 上（车/船）\n   - en: onto a means of transport\n   - priority: 2\n   - tags: motion\n`,
    ).words;
    expect(aboardLike!.coreDefinitions).toHaveLength(2);
    expect(aboardLike!.coreDefinitions[0]).toMatchObject({
      sense: "在交通工具上",
      en: "on or into a ship",
      priority: 1,
      tags: ["core"],
    });
    expect(aboardLike!.coreDefinitions[1]!.tags).toEqual(["motion"]);
  });

  it("renders definitionMd from core definitions", () => {
    const [accelerate] = parsed.words;
    expect(accelerate!.definitionMd.split("\n")[0]).toBe("1. 加速（交通旅行语境中的基本义）");
    expect(accelerate!.definitionMd).toContain("- en: to increase speed; make faster");
    expect(accelerate!.definitionMd).toContain("- priority: 1");
  });

  it("orders senses by priority regardless of written order (nulls last, stable)", () => {
    const [word] = parseVocabCollection(
      `# t\n\n---\n\n## release\n\n### Identity\n- lemma: release\n\n### Core Definitions`
        + `\n1. 释放\n   - priority: 2`
        + `\n2. 发行\n   - priority: 1`
        + `\n3. 无优先义项甲`
        + `\n4. 无优先义项乙`,
    ).words;
    expect(word!.coreDefinitions.map((d) => d.sense)).toEqual([
      "发行",
      "释放",
      "无优先义项甲",
      "无优先义项乙",
    ]);
    expect(word!.definitionMd.split("\n")[0]).toBe("1. 发行");
  });

  it("treats blank morphology fields as null and keeps non-empty ones", () => {
    const [, dock] = parsed.words;
    expect(dock!.morphology.prefix).toBeNull();
    expect(dock!.morphology.suffix).toBeNull();
    expect(dock!.morphology.root).toContain("docke");
    expect(dock!.morphology.family).toEqual(["dock", "docks", "docker"]);
  });

  it("captures confidence and reviewer notes", () => {
    const [accelerate, dock] = parsed.words;
    expect(accelerate!.confidence).toBe("source-backed");
    expect(dock!.confidence).toBe("uncertain");
    expect(dock!.reviewerNotes.some((note) => note.startsWith("Etymonline dock"))).toBe(true);
  });

  it("builds the metadata bag for words.metadata JSONB", () => {
    const [accelerate] = parsed.words;
    expect(accelerate!.metadata).toMatchObject({
      morphology_prefix: "ad-",
      morphology_root: 'celer（celerare "加快"）',
      confidence: "source-backed",
    });
    expect(accelerate!.metadata.mnemonic_text).toContain("向更快去");
  });

  it("keeps bodyMd lossless for the whole entry", () => {
    const [accelerate] = parsed.words;
    expect(accelerate!.bodyMd).toContain("## accelerate");
    expect(accelerate!.bodyMd).toContain("### Semantic Chain");
  });

  it("warns instead of failing when Identity is missing", () => {
    const broken = parseVocabCollection("# t\n\n---\n\n## mystery\n\n### Prototype\nm = m\n");
    expect(broken.words[0]!.warnings.join()).toContain("Identity 小节缺失");
    expect(broken.words[0]!.warnings.join()).toContain("缺少 lemma");
  });

  it("warns on unknown sections but preserves their content in bodyMd", () => {
    const withExtra = parseVocabCollection(
      "# t\n\n---\n\n## wordy\n\n### Identity\n- lemma: wordy\n\n### Future Section\nsomething new\n",
    );
    expect(withExtra.words[0]!.warnings.join()).toContain('未知小节 "Future Section"');
    expect(withExtra.words[0]!.bodyMd).toContain("something new");
  });
});

describe("computeIngestHash", () => {
  it("is stable across identical inputs", () => {
    const a = parseVocabCollection(SAMPLE_FILE).words[0]!;
    const b = parseVocabCollection(SAMPLE_FILE).words[0]!;
    expect(computeIngestHash(a)).toBe(computeIngestHash(b));
  });

  it("differs when content changes", () => {
    const base = parseVocabCollection(SAMPLE_FILE);
    const modified = parseVocabCollection(SAMPLE_FILE.replace("加速\n", "加速 v2\n"));
    expect(computeIngestHash(base.words[0]!)).not.toBe(computeIngestHash(modified.words[0]!));
  });
});

describe("assessWordCompleteness (ported gate)", () => {
  it("standard: corpus-shaped word with ipa is fully scored ok", () => {
    const word = parseVocabCollection(SAMPLE_FILE).words[0]!;
    const report = assessWordCompleteness(word);
    expect(report.tier).toBe("ok");
    expect(report.score).toBe(100);
    expect(report.missing).toEqual([]);
  });

  it("standard: missing ipa alone flags needs_supplement", () => {
    const file = parseVocabCollection(SAMPLE_FILE.replace("- ipa: /əkˈseləreɪt/", "- ipa:"));
    const report = assessWordCompleteness(file.words[0]!);
    expect(report.tier).toBe("needs_supplement");
    expect(report.score).toBe(60);
    expect(report.missing).toEqual(["ipa"]);
  });

  it("any strictness rejects a definition-less word", () => {
    const broken = parseVocabCollection(
      "# t\n\n---\n\n## ghost\n\n### Identity\n- lemma: ghost\n\n### Morphology\n- prefix:\n",
    );
    for (const strictness of ["lenient", "standard", "strict"] as const) {
      expect(assessWordCompleteness(broken.words[0]!, strictness).tier).toBe("rejected");
    }
  });

  it("strict flags any single missing field as needs_supplement", () => {
    const word = parseVocabCollection(SAMPLE_FILE.replace("- ipa: /əkˈseləreɪt/", "- ipa:")).words[0]!;
    expect(assessWordCompleteness(word, "strict").tier).toBe("needs_supplement");
    expect(assessWordCompleteness(word, "lenient").tier).toBe("ok");
  });
});
