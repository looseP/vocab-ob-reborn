import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlazaCache } from "@/services/plaza-cache";

describe("PlazaCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stores and returns a value within TTL", () => {
    const cache = new PlazaCache(60_000);
    cache.set("k", { count: 3 });
    expect(cache.get<{ count: number }>("k")).toEqual({ count: 3 });
    expect(cache.size).toBe(1);
  });

  it("returns null and evicts after TTL expiry", () => {
    const cache = new PlazaCache(60_000);
    cache.set("k", { count: 3 });

    vi.advanceTimersByTime(60_001);

    expect(cache.get("k")).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("returns null for a missing key", () => {
    const cache = new PlazaCache();
    expect(cache.get("nope")).toBeNull();
  });

  it("invalidateAll clears every entry", () => {
    const cache = new PlazaCache();
    cache.set("a", 1);
    cache.set("b", 2);
    cache.invalidateAll();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
  });
});
