import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "../helpers/mock-db";

// Mock the connection BEFORE importing repositories
const mock = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  getBatchImportPool: () => mock.pool,
  checkPoolHealth: vi.fn(),
  resetPool: vi.fn(),
}));

import { WordRepository } from "@/repositories/word.repository";
import type { UpsertFullWordInput } from "@/repositories/interfaces";

const baseInput: UpsertFullWordInput = {
  slug: "accelerate",
  title: "accelerate",
  lemma: "accelerate",
  pos: "v",
  cefr: "B1",
  ipa: "/əkˈseləreɪt/",
  aliases: ["accelerates"],
  shortDefinition: "加速",
  definitionMd: "1. 加速\n   - en: to increase speed",
  bodyMd: "## accelerate\n...",
  examplesJson: [],
  metadataJson: { confidence: "source-backed" },
  coreDefinitionsJson: [{ sense: "加速", en: "to increase speed", priority: 1, tags: ["core"] }],
  prototypeText: "accelerate = 加速",
  contentHash: "a".repeat(64),
  sourcePath: "L1_雅思词汇_交通旅行.md",
  sourceUpdatedAt: null,
  isPublished: true,
  qualityStatus: "ok",
  qualityIssuesJson: [],
};

describe("WordRepository.upsertFullWord", () => {
  beforeEach(() => mock.reset());

  const repo = new WordRepository();

  it("imports and returns imported when the row is written", async () => {
    mock.setRows([{ id: "w-1" }]);
    await expect(repo.upsertFullWord(baseInput)).resolves.toBe("imported");

    expect(mock.lastQuery!.text).toContain("ON CONFLICT (slug) DO UPDATE");
    expect(mock.lastQuery!.text).toContain("IS DISTINCT FROM EXCLUDED.content_hash");
    const params = mock.lastQuery!.params;
    expect(params[0]).toBe("accelerate");
    expect(params[6]).toEqual(["accelerates"]);
    expect(params[17]).toBe(true);
    expect(params[18]).toBe("ok");
  });

  it("returns unchanged when the hash guard skips the update", async () => {
    mock.setRows([]);
    await expect(repo.upsertFullWord(baseInput)).resolves.toBe("unchanged");
  });

  it("maps needs_supplement to unpublished with issues payload", async () => {
    mock.setRows([{ id: "w-2" }]);
    await repo.upsertFullWord({
      ...baseInput,
      isPublished: false,
      qualityStatus: "needs_supplement",
      qualityIssuesJson: ["缺少例句（collocation / corpus 均为空）"],
    });
    const params = mock.lastQuery!.params;
    expect(params[17]).toBe(false);
    expect(params[18]).toBe("needs_supplement");
    expect(params[19]).toContain("缺少例句");
  });
});
