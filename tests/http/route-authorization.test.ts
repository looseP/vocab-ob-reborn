import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The owner-only guarantee for the L2 cache RPCs is NOT enforced inside the
// database. drizzle-release/0018 relaxed refresh_l2_cache / finalize_l2_content_hash
// from "the actor must hold a user_word_l2_progress row for the word" to "any
// authenticated actor", so the Phase G content-first candidate flow can adopt
// content for words that are not yet in an L2 track. The real security boundary
// is the HTTP layer: src/http/server.ts mounts authMiddleware(..., "owner") on
// /api/* and every protected /api route is registered AFTER that mount. This
// test pins that ordering so a future refactor cannot silently re-expose those
// RPCs to non-owner (or unauthenticated) callers.
//
// It reads the server source as TEXT on purpose: createApp() needs a fully wired
// Services graph, whereas the invariant under test is purely about the order of
// registrations in this one file.

const SERVER_SOURCE_PATH = fileURLToPath(new URL("../../src/http/server.ts", import.meta.url));

// The browser session exchange must run before the protected middleware, so it is
// the one /api route deliberately registered ahead of the owner guard. Every
// other /api route must sit behind it.
const ROUTES_ALLOWED_BEFORE_OWNER_MOUNT = new Set<string>(["/api/auth"]);

// Anchored to the start of a live code line so a commented-out mount cannot
// satisfy the assertion. A commented guard still contains the same text, and a
// silently disabled guard is exactly the failure mode this test exists to catch.
const OWNER_MOUNT_PATTERN = /^\s*app\.use\(\s*["']\/api\/\*["']\s*,\s*authMiddleware\(/;
const API_ROUTE_PATTERN = /app\.(?:route|get|post|put|patch|delete)\(\s*["'](\/api\/[^"']*)["']/;

// Every match below is restricted to live code lines. Comment detection is done
// by inspecting the leading token rather than stripping "//" first, because the
// latter would corrupt string literals such as "https://..." inside routes.
const isCommentLine = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

const lines = readFileSync(SERVER_SOURCE_PATH, "utf8").split(/\r?\n/);

const ownerMountIndex = lines.findIndex(
  (line) => !isCommentLine(line) && OWNER_MOUNT_PATTERN.test(line) && line.includes('"owner"'),
);

const apiRoutes = lines.flatMap((line, index) => {
  if (isCommentLine(line)) return [];
  const match = line.match(API_ROUTE_PATTERN);
  return match ? [{ path: match[1], index }] : [];
});

describe("src/http/server.ts route authorization ordering", () => {
  it("mounts the owner-gated auth middleware on /api/*", () => {
    expect(ownerMountIndex).toBeGreaterThanOrEqual(0);
    const mountLine = lines[ownerMountIndex];
    // The guard must be live code, not a commented-out mount: a disabled guard
    // is the exact regression this suite exists to catch.
    expect(isCommentLine(mountLine)).toBe(false);
    expect(mountLine).toContain("authMiddleware(");
    expect(mountLine).toContain('"owner"');
  });

  it("registers every owner-only /api route strictly after the owner auth mount", () => {
    expect(ownerMountIndex).toBeGreaterThanOrEqual(0);
    expect(apiRoutes.length).toBeGreaterThan(0);

    const aheadOfMount = apiRoutes.filter((route) => route.index < ownerMountIndex);
    const illegal = aheadOfMount
      .map((route) => route.path)
      .filter((path) => !ROUTES_ALLOWED_BEFORE_OWNER_MOUNT.has(path));
    expect(illegal).toEqual([]);
  });

  it("mounts the L2 routes (refresh_l2_cache / finalize_l2_content_hash) behind the owner guard", () => {
    expect(ownerMountIndex).toBeGreaterThanOrEqual(0);
    const l2Routes = apiRoutes.filter((route) => route.path === "/api/l2");
    expect(l2Routes.length).toBeGreaterThan(0);
    for (const route of l2Routes) {
      expect(route.index).toBeGreaterThan(ownerMountIndex);
    }
  });
});
