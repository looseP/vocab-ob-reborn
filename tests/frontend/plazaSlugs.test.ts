import { describe, expect, it } from "vitest";
import {
  extractRootTokens,
  deriveSemanticCollection,
  deriveRootCollection,
  deriveRootCollections,
  deriveWordCollections,
} from "@/frontend/utils/plazaSlugs";

describe("extractRootTokens (frontend, mirrors PlazaService.extractRootTokens)", () => {
  it("splits compound roots on '+' and keeps each valid token", () => {
    expect(extractRootTokens("air + condition")).toEqual(["air", "condition"]);
    expect(extractRootTokens("nostos (Greek 'homecoming') + algos (Greek 'pain')")).toEqual(["nostos", "algos"]);
  });

  it("takes the leading latin token before parentheses (half/full width)", () => {
    expect(extractRootTokens("chart (from Late Latin charta)")).toEqual(["chart"]);
    expect(extractRootTokens("german（Germania，罗马称谓）")).toEqual(["german"]);
    expect(extractRootTokens("cogn (know)")).toEqual(["cogn"]);
  });

  it("deduplicates repeated tokens", () => {
    expect(extractRootTokens("leg (Latin) + leg (PIE)")).toEqual(["leg"]);
  });

  it("returns [] for empty / EMPTY / null / noise-only inputs", () => {
    expect(extractRootTokens("")).toEqual([]);
    expect(extractRootTokens("EMPTY")).toEqual([]);
    expect(extractRootTokens(null)).toEqual([]);
    expect(extractRootTokens(undefined)).toEqual([]);
    expect(extractRootTokens("a (x) + 中国人")).toEqual([]);
    expect(extractRootTokens("al-Khwarizmi (borrowed Arabic proper name)")).toEqual([]);
  });
});

describe("deriveSemanticCollection", () => {
  it("derives a semantic-field slug from the L1 source_path", () => {
    expect(deriveSemanticCollection({ source_path: "L1_雅思词汇/L1_雅思词汇_学校教育.md" })).toEqual({
      slug: "semantic-学校教育",
      title: "学校教育",
    });
  });

  it("returns null for missing or non-L1 source_path", () => {
    expect(deriveSemanticCollection({})).toBeNull();
    expect(deriveSemanticCollection({ source_path: "notes/foo.md" })).toBeNull();
    expect(deriveSemanticCollection(null)).toBeNull();
  });
});

describe("deriveRootCollection (legacy single-token signature)", () => {
  it("returns the first valid root token family", () => {
    expect(deriveRootCollection({ morphology_root: "air + condition" })).toEqual({
      slug: "root-air",
      title: "air",
    });
  });

  it("returns null when no valid token exists", () => {
    expect(deriveRootCollection({})).toBeNull();
    expect(deriveRootCollection({ morphology_root: "EMPTY" })).toBeNull();
  });
});

describe("deriveRootCollections (B4-1: all family backlinks)", () => {
  it("returns every root family for a compound-root word", () => {
    expect(deriveRootCollections({ morphology_root: "air + condition" })).toEqual([
      { slug: "root-air", title: "air" },
      { slug: "root-condition", title: "condition" },
    ]);
  });

  it("returns a single family for a simple-root word", () => {
    expect(deriveRootCollections({ morphology_root: "port (Latin portare)" })).toEqual([
      { slug: "root-port", title: "port" },
    ]);
  });

  it("returns [] when no valid token exists", () => {
    expect(deriveRootCollections({})).toEqual([]);
    expect(deriveRootCollections({ morphology_root: "" })).toEqual([]);
  });
});

describe("deriveWordCollections (E2 + B4-1 combined)", () => {
  it("returns semantic field plus all root families", () => {
    const metadata = {
      source_path: "L1_雅思词汇/L1_雅思词汇_科技发明.md",
      morphology_root: "air + condition",
    };
    expect(deriveWordCollections(metadata)).toEqual([
      { slug: "semantic-科技发明", title: "科技发明" },
      { slug: "root-air", title: "air" },
      { slug: "root-condition", title: "condition" },
    ]);
  });

  it("returns only the semantic field when no root exists", () => {
    expect(deriveWordCollections({ source_path: "L1_雅思词汇/L1_雅思词汇_饮食健康.md" })).toEqual([
      { slug: "semantic-饮食健康", title: "饮食健康" },
    ]);
  });

  it("returns only root families when no semantic field exists", () => {
    expect(deriveWordCollections({ morphology_root: "leg" })).toEqual([
      { slug: "root-leg", title: "leg" },
    ]);
  });

  it("returns [] for empty metadata", () => {
    expect(deriveWordCollections(null)).toEqual([]);
  });
});
