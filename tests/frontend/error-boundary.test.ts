import { describe, expect, it } from "vitest";
import { isChunkLoadError } from "@/frontend/components/ui/ErrorBoundary";

describe("isChunkLoadError", () => {
  it("recognizes dynamic import / chunk load failure messages", () => {
    expect(
      isChunkLoadError(new Error("Failed to fetch dynamically imported module: /assets/DashboardPage-CIQA9BCY.js")),
    ).toBe(true);
    expect(isChunkLoadError(new Error("Importing a module script failed"))).toBe(true);
    expect(isChunkLoadError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new Error("Loading chunk 4 failed."))).toBe(true);
    expect(isChunkLoadError(new Error("ChunkLoadError: Loading chunk 2 failed."))).toBe(true);
  });

  it("does not treat ordinary render errors as chunk errors", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'foo')"))).toBe(false);
    expect(isChunkLoadError(new TypeError("x is not a function"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
  });
});
