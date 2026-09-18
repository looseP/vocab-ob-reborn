import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { createMockPool } from "../helpers/mock-db";

const mockDb = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mockDb.pool,
  getBatchImportPool: () => mockDb.pool,
  checkPoolHealth: vi.fn(),
  resetPool: vi.fn(),
  pool: () => mockDb.pool,
}));

beforeAll(() => {
  process.env.OWNER_API_TOKEN = "test-owner";
  process.env.LOCAL_OWNER_ID = "user-123";
});
afterAll(() => {
  delete process.env.OWNER_API_TOKEN;
  delete process.env.LOCAL_OWNER_ID;
});

const AUTH_HEADERS = { Authorization: "Bearer test-owner", "Content-Type": "application/json" };
const SHEET_ID = "00000000-0000-4000-8000-000000000401";
const SOURCE_ID = "00000000-0000-4000-8000-000000000302";

/** 契约行夹具（l3SheetArchiveItemResponseSchema；strict——字段即全部）。 */
function archiveItem() {
  return {
    id: SHEET_ID,
    scope: "file" as const,
    source_id: SOURCE_ID,
    question_type: "reading_choice" as const,
    paper_id: null,
    status: "sealed" as const,
    seal_mode: "full" as const,
    sealed_at: "2026-09-18T00:10:00.000Z",
    created_at: "2026-09-18T00:00:00.000Z",
    graded_count: 3,
    venue_title: "WA 阅读理解文件",
  };
}

function makeServices(l3Sheets: Record<string, unknown>): Services {
  return { l3Sheets } as unknown as Services;
}

describe("GET /api/l3/sheets（F-1 题纸档案）", () => {
  it("returns the archive page and passes the parsed limit through", async () => {
    const listArchive = vi.fn(async () => ({ items: [archiveItem()] }));
    const app = createApp(makeServices({ listArchive }));
    const res = await app.request("/api/l3/sheets?limit=20", { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ graded_count: number; venue_title: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.graded_count).toBe(3);
    expect(body.items[0]!.venue_title).toBe("WA 阅读理解文件");
    expect(listArchive).toHaveBeenCalledWith("user-123", { limit: 20 });
  });

  it("applies the default limit (50) and rejects out-of-range limits with 400", async () => {
    const listArchive = vi.fn(async () => ({ items: [] }));
    const app = createApp(makeServices({ listArchive }));

    const ok = await app.request("/api/l3/sheets", { headers: AUTH_HEADERS });
    expect(ok.status).toBe(200);
    expect(listArchive).toHaveBeenCalledWith("user-123", { limit: 50 });

    const zero = await app.request("/api/l3/sheets?limit=0", { headers: AUTH_HEADERS });
    expect(zero.status).toBe(400);
    const tooMany = await app.request("/api/l3/sheets?limit=101", { headers: AUTH_HEADERS });
    expect(tooMany.status).toBe(400);
    const garbage = await app.request("/api/l3/sheets?limit=abc", { headers: AUTH_HEADERS });
    expect(garbage.status).toBe(400);
  });

  it("401s without a token and never touches the service（fail-closed）", async () => {
    const listArchive = vi.fn();
    const app = createApp(makeServices({ listArchive }));
    const res = await app.request("/api/l3/sheets");
    expect(res.status).toBe(401);
    expect(listArchive).not.toHaveBeenCalled();
  });
});
