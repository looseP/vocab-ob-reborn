import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatamuseProvider } from "@/dictionary/providers/datamuse";
import { buildPhrase, selectRelation } from "@/dictionary/normalizer";

describe("normalizer", () => {
  it("adjective phrase order: lemma + word", () => {
    expect(buildPhrase("abundant", "rainfall", "adj.")).toBe("abundant rainfall");
  });

  it("noun phrase order: word + lemma", () => {
    expect(buildPhrase("rain", "heavy", "n.")).toBe("heavy rain");
  });

  it("unknown POS defaults to lemma + word", () => {
    expect(buildPhrase("test", "word")).toBe("test word");
  });

  it("adjective selects rel_jja", () => {
    expect(selectRelation("adj.")?.rel).toBe("rel_jja");
  });

  it("noun selects rel_jjb", () => {
    expect(selectRelation("n.")?.rel).toBe("rel_jjb");
  });

  it("verb returns null", () => {
    expect(selectRelation("v.")).toBeNull();
  });
});

describe("DatamuseProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns normalized candidates for adjective", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [{ word: "rainfall", score: 100 }],
    } as Response);
    const provider = new DatamuseProvider();
    const result = await provider.lookupCollocations({
      lemma: "abundant",
      pos: "adj.",
      limit: 5,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].phrase).toBe("abundant rainfall");
    expect(result.candidates[0].sourceName).toBe("Datamuse");
  });

  it("returns normalized candidates for noun", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [{ word: "heavy", score: 200 }],
    } as Response);
    const provider = new DatamuseProvider();
    const result = await provider.lookupCollocations({
      lemma: "rain",
      pos: "n.",
      limit: 5,
    });
    expect(result.candidates[0].phrase).toBe("heavy rain");
  });

  it("returns empty + warning for verb (no reliable relation)", async () => {
    const provider = new DatamuseProvider();
    const result = await provider.lookupCollocations({
      lemma: "run",
      pos: "v.",
      limit: 5,
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.warning).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns empty + warning on API error", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as Response);
    const provider = new DatamuseProvider();
    const result = await provider.lookupCollocations({
      lemma: "abundant",
      pos: "adj.",
      limit: 5,
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.warning).toContain("500");
  });

  it("returns empty + warning on fetch rejection", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Network error"));
    const provider = new DatamuseProvider();
    const result = await provider.lookupCollocations({
      lemma: "abundant",
      pos: "adj.",
      limit: 5,
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.warning).toContain("Network error");
  });
});
