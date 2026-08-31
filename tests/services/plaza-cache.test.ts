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

  it("treats the exact TTL boundary as expired (expiresAt <= now)", () => {
    const cache = new PlazaCache(60_000);
    cache.set("k", { count: 3 });

    vi.advanceTimersByTime(60_000);

    expect(cache.get("k")).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("overwrites a key with a newer value without growing the map", () => {
    const cache = new PlazaCache(60_000);
    cache.set("k", { count: 3 });
    cache.set("k", { count: 5 });

    expect(cache.get<{ count: number }>("k")).toEqual({ count: 5 });
    expect(cache.size).toBe(1);
  });

  it("expired entries are not resurrected by re-reading after eviction", () => {
    const cache = new PlazaCache(10_000);
    cache.set("a", 1);
    vi.advanceTimersByTime(10_001);
    expect(cache.get("a")).toBeNull();

    cache.set("a", 2);
    expect(cache.get("a")).toBe(2);
    expect(cache.size).toBe(1);
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
