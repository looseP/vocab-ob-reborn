import { describe, it, expect } from "vitest";
import { STYLE_PROFILES, getStyleProfile, findStyleProfile, validateStyleProfileField } from "@/domain/l2-style-profile";

describe("Style Profile Registry", () => {
  it("has 6 built-in profiles", () => {
    expect(STYLE_PROFILES).toHaveLength(6);
  });

  it("default profile resolves when id omitted", () => {
    expect(getStyleProfile().id).toBe("default");
  });

  it("profile ids are unique", () => {
    const ids = STYLE_PROFILES.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("findStyleProfile returns undefined for unknown id", () => {
    expect(findStyleProfile("nonexistent")).toBeUndefined();
  });

  it("postgraduate_essay rejects collocation", () => {
    const profile = getStyleProfile("postgraduate_essay");
    expect(() => validateStyleProfileField(profile, "collocation")).toThrow();
  });

  it("core_collocation accepts collocation", () => {
    const profile = getStyleProfile("core_collocation");
    expect(() => validateStyleProfileField(profile, "collocation")).not.toThrow();
  });

  it("core_collocation rejects example", () => {
    const profile = getStyleProfile("core_collocation");
    expect(() => validateStyleProfileField(profile, "example")).toThrow();
  });

  it("default accepts both fields", () => {
    const profile = getStyleProfile("default");
    expect(() => validateStyleProfileField(profile, "collocation")).not.toThrow();
    expect(() => validateStyleProfileField(profile, "example")).not.toThrow();
  });
});
