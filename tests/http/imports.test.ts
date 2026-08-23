import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import type { ImportVocabNotesResult } from "@/services/vocab-import.service";
import { vocabNotesImportResponseSchema } from "@/http/import-response-contract";

const ORIGINAL_OWNER_TOKEN = process.env.OWNER_API_TOKEN;
const ORIGINAL_LOCAL_OWNER = process.env.LOCAL_OWNER_ID;

beforeAll(() => {
  process.env.OWNER_API_TOKEN = "test-owner";
  process.env.LOCAL_OWNER_ID = "user-123";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL_OWNER_TOKEN;
  process.env.LOCAL_OWNER_ID = ORIGINAL_LOCAL_OWNER;
});

const AUTH_HEADERS = { Authorization: "Bearer test-owner" };

const SERVICE_RESULT: ImportVocabNotesResult = {
  results: [
    {
      path: "L1_雅思词汇/accelerate.md",
      status: "imported",
      total: 1,
      imported: 1,
      unchanged: 0,
      needsSupplement: 0,
      rejected: 0,
      failedWords: 0,
      minScore: 90,
      issues: [],
    },
    {
      path: "L1_雅思词汇/broken.md",
      status: "failed",
      total: 0,
      imported: 0,
      unchanged: 0,
      needsSupplement: 0,
      rejected: 0,
      failedWords: 1,
      minScore: null,
      issues: [],
      error: "no word entries parsed",
    },
  ],
  stats: { files: 2, imported: 1, unchanged: 0, needsSupplement: 0, rejected: 0, failed: 1 },
};

function makeMockServices(importFiles: ReturnType<typeof vi.fn>): Services {
  return {
    vocabImport: { importFiles },
  } as unknown as Services;
}

function makeRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const VALID_BODY = {
  files: [
    { path: "L1_雅思词汇/accelerate.md", content: "# t\n\n---\n\n## accelerate", updatedAt: "2026-08-22T00:00:00.000Z" },
    { path: "L1_雅思词汇/broken.md", content: "no heading at all" },
  ],
  dryRun: false,
  strictness: "standard",
};

describe("POST /api/imports/vocab-notes", () => {
  it("imports files through the service and returns a typed payload", async () => {
    const importFiles = vi.fn().mockResolvedValue(SERVICE_RESULT);
    const app = createApp(makeMockServices(importFiles));

    const res = await app.request("/api/imports/vocab-notes", makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = vocabNotesImportResponseSchema.parse(await res.json());
    expect(body.stats).toMatchObject({ files: 2, imported: 1, failed: 1 });
    expect(body.results[1].error).toBe("no word entries parsed");

    expect(importFiles).toHaveBeenCalledTimes(1);
    const [files, options] = (importFiles.mock.calls[0] ?? []) as [
      Array<{ path: string; content: string; updatedAt?: string | null }>,
      { strictness?: string; dryRun?: boolean },
    ];
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      path: "L1_雅思词汇/accelerate.md",
      updatedAt: "2026-08-22T00:00:00.000Z",
    });
    expect(files[1].updatedAt).toBeNull();
    expect(options).toMatchObject({ strictness: "standard", dryRun: false });
  });

  it("rejects missing credentials with 401 and never calls the service", async () => {
    const importFiles = vi.fn();
    const app = createApp(makeMockServices(importFiles));

    const res = await app.request("/api/imports/vocab-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="vocab-observatory"');
    expect(importFiles).not.toHaveBeenCalled();
  });

  it("returns 400 with field details for an invalid body", async () => {
    const importFiles = vi.fn();
    const app = createApp(makeMockServices(importFiles));

    const res = await app.request("/api/imports/vocab-notes", makeRequest({ files: [] }));
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details?: unknown };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(body.details)).toContain("files");
    expect(importFiles).not.toHaveBeenCalled();
  });

  it("rejects oversized file content with 400", async () => {
    const importFiles = vi.fn();
    const app = createApp(makeMockServices(importFiles));

    const res = await app.request("/api/imports/vocab-notes", makeRequest({
      files: [{ path: "big.md", content: "x".repeat(200_001) }],
    }));
    expect(res.status).toBe(400);
    expect(importFiles).not.toHaveBeenCalled();
  });

  it("caps the number of files per request at 50", async () => {
    const importFiles = vi.fn();
    const app = createApp(makeMockServices(importFiles));

    const res = await app.request("/api/imports/vocab-notes", makeRequest({
      files: Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.md`, content: "# t" })),
    }));
    expect(res.status).toBe(400);
    expect(importFiles).not.toHaveBeenCalled();
  });

  it("defaults strictness to standard and dryRun to false when omitted", async () => {
    const importFiles = vi.fn().mockResolvedValue(SERVICE_RESULT);
    const app = createApp(makeMockServices(importFiles));

    const res = await app.request("/api/imports/vocab-notes", makeRequest({
      files: [{ path: "a.md", content: "# t" }],
    }));
    expect(res.status).toBe(200);
    const [, options] = (importFiles.mock.calls[0] ?? []) as [unknown[], { strictness?: string; dryRun?: boolean }];
    expect(options.strictness).toBe("standard");
    expect(options.dryRun).toBeUndefined();
  });
});
