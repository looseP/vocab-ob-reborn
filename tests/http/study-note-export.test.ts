/**
 * 学习笔记导出端点（Task 10 · P2）——端点级验收。
 *
 * 本文件在任务书的「证明」列中被点名（§3.1 A6/A13/A14、§3.2 B4），但实现轮
 * 未落盘；由验收轮补齐作为**独立端点证据**（与服务层 `l3-study-note-export.test.ts`
 * 分属两层：服务层证明渲染与事务，本层证明 HTTP 合同与错误映射）。
 *
 * 覆盖：
 *  - 200 四件响应头（Content-Type / Content-Disposition 安全文件名 /
 *    X-Export-Schema-Version / X-Export-Sha256）；
 *  - `X-Export-Sha256` 与正文「内容校验」行同值；
 *  - 正文末尾 JSON 块可 `JSON.parse`；
 *  - 缺 `expectedVersion` / 非数字 → **422**（ValidationError.httpStatus = 422，
 *    `src/errors/index.ts:52`；与题纸导出先例 `tests/http/l3-sheet.test.ts:305`
 *    同口径）。**注：任务书 §1 P3 与 §3.2 B4 写的是「400」**，实现与任务书不一致；
 *    本用例钉住的是**实现的可观测行为**，任务书偏差已在验收结果中单列；
 *  - 旧版本 → 409 且**不含服务器正文**、只带 currentVersion；
 *  - 非本人 / 不存在 → 404（service NotFoundError）；
 *  - 路由顺序：`/study-notes/:noteId/export` 不被 `/:noteId` 详情路由吞掉；
 *  - 未认证 401 / agent 403（端点点名，授权矩阵之外再加一条定点断言）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import { ConflictError, NotFoundError, ValidationError } from "@/errors";
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

const OWNER_TOKEN = "test-owner";
const AGENT_TOKEN = "test-agent-token";
const NOTE_ID = "00000000-0000-4000-8000-000000000101";

beforeAll(() => {
  process.env.OWNER_API_TOKEN = OWNER_TOKEN;
  process.env.LOCAL_OWNER_ID = "user-123";
  process.env.AGENT_API_TOKENS = `agent-a:${AGENT_TOKEN}`;
});
afterAll(() => {
  delete process.env.OWNER_API_TOKEN;
  delete process.env.LOCAL_OWNER_ID;
  delete process.env.AGENT_API_TOKENS;
});

const AUTH_HEADERS = { Authorization: `Bearer ${OWNER_TOKEN}` };
const EXPORT_PATH = `/api/l3/study-notes/${NOTE_ID}/export`;

const CHECKSUM_LINE =
  "内容校验（sha256，删除本行后重算应等于此值）：aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** 与 service 渲染同形的终稿：正文 + 内容校验行 + JSON 块。 */
const MARKDOWN = [
  "# 学习笔记档案（study-note v1）",
  "",
  "正文",
  "",
  CHECKSUM_LINE,
  "",
  "```json",
  '{"exportSchemaVersion":1,"kind":"study-note"}',
  "```",
  "",
].join("\n");

const SHA256 = "a".repeat(64);

function exportResult(overrides: Record<string, unknown> = {}) {
  return {
    markdown: MARKDOWN,
    filename: `study-note-${NOTE_ID}.md`,
    sha256: SHA256,
    schemaVersion: 1,
    version: 3,
    ...overrides,
  };
}

function makeServices(bundle: { l3StudyNoteExport?: Record<string, unknown>; studyNotes?: Record<string, unknown> }): Services {
  return { studyNotes: {}, studyReferences: {}, ...bundle } as unknown as Services;
}

describe("GET /api/l3/study-notes/:noteId/export（200 四件响应头）", () => {
  it("sets content-disposition with study-note uuid filename", async () => {
    const exportNote = vi.fn(async () => exportResult());
    const app = createApp(makeServices({ l3StudyNoteExport: { export: exportNote } }));
    const res = await app.request(`${EXPORT_PATH}?expectedVersion=3`, { headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="study-note-${NOTE_ID}.md"`,
    );
    expect(res.headers.get("X-Export-Schema-Version")).toBe("1");
    expect(res.headers.get("X-Export-Sha256")).toBe(SHA256);
    expect(exportNote).toHaveBeenCalledWith("user-123", NOTE_ID, { expectedVersion: 3 });
  });

  it("X-Export-Sha256 equals the in-body checksum", async () => {
    const app = createApp(makeServices({ l3StudyNoteExport: { export: vi.fn(async () => exportResult()) } }));
    const res = await app.request(`${EXPORT_PATH}?expectedVersion=3`, { headers: AUTH_HEADERS });
    const body = await res.text();

    const inBody = body.split("\n").find((line) => line.startsWith("内容校验"));
    expect(inBody).toBeTruthy();
    const inBodyHash = inBody!.split("：").pop()!.trim();
    expect(inBodyHash).toBe(res.headers.get("X-Export-Sha256"));
  });

  it("response body json block parses", async () => {
    const app = createApp(makeServices({ l3StudyNoteExport: { export: vi.fn(async () => exportResult()) } }));
    const res = await app.request(`${EXPORT_PATH}?expectedVersion=3`, { headers: AUTH_HEADERS });
    const body = await res.text();

    const fenced = body.match(/```json\n([\s\S]*?)\n```/);
    expect(fenced).toBeTruthy();
    const parsed = JSON.parse(fenced![1]!) as Record<string, unknown>;
    expect(parsed.exportSchemaVersion).toBe(1);
    expect(parsed.kind).toBe("study-note");
  });
});

describe("expectedVersion 合同（P3）：缺/非法 422；旧版 409", () => {
  it("rejects missing expectedVersion (service ValidationError → 422)", async () => {
    const exportNote = vi.fn(async () => {
      throw new ValidationError("导出必须携带 expectedVersion（客户端已保存版本）", "expectedVersion");
    });
    const app = createApp(makeServices({ l3StudyNoteExport: { export: exportNote } }));
    const res = await app.request(EXPORT_PATH, { headers: AUTH_HEADERS });
    expect(res.status).toBe(422);
  });

  it("rejects a non-numeric expectedVersion with 422 without touching the service", async () => {
    const exportNote = vi.fn(async () => exportResult());
    const app = createApp(makeServices({ l3StudyNoteExport: { export: exportNote } }));
    const res = await app.request(`${EXPORT_PATH}?expectedVersion=abc`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(422);
    expect(exportNote).not.toHaveBeenCalled();
  });

  it("rejects stale expectedVersion with 409 and currentVersion only", async () => {
    const exportNote = vi.fn(async () => {
      throw new ConflictError("Note version conflict: export aborted", undefined, {
        noteId: NOTE_ID,
        currentVersion: 9,
      });
    });
    const app = createApp(makeServices({ l3StudyNoteExport: { export: exportNote } }));
    const res = await app.request(`${EXPORT_PATH}?expectedVersion=2`, { headers: AUTH_HEADERS });

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { meta?: Record<string, unknown>; error?: unknown };
    expect(JSON.stringify(payload)).toContain("9");
    // 409 不回传服务器正文：既无 markdown 也无校验行
    expect(JSON.stringify(payload)).not.toContain("内容校验");
    expect(JSON.stringify(payload)).not.toContain("# 学习笔记档案");
  });
});

describe("owner-only：非本人 / 不存在 404；未认证 401；agent 403", () => {
  it("maps NotFoundError to 404", async () => {
    const exportNote = vi.fn(async () => {
      throw new NotFoundError("StudyNote", NOTE_ID);
    });
    const app = createApp(makeServices({ l3StudyNoteExport: { export: exportNote } }));
    expect((await app.request(`${EXPORT_PATH}?expectedVersion=1`, { headers: AUTH_HEADERS })).status).toBe(404);
  });

  it("unauthenticated is 401 and agent is 403", async () => {
    const exportNote = vi.fn(async () => exportResult());
    const app = createApp(makeServices({ l3StudyNoteExport: { export: exportNote } }));

    expect((await app.request(`${EXPORT_PATH}?expectedVersion=1`)).status).toBe(401);
    const agent = await app.request(`${EXPORT_PATH}?expectedVersion=1`, {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(agent.status).toBe(403);
    expect(exportNote).not.toHaveBeenCalled();
  });
});

describe("路由顺序：export 不被 /:noteId 详情路由吞掉", () => {
  it("routes the export subpath to exportL3StudyNote, not getL3StudyNote", async () => {
    const exportNote = vi.fn(async () => exportResult());
    const get = vi.fn(async () => ({ item: { id: NOTE_ID } }));
    const app = createApp(makeServices({ l3StudyNoteExport: { export: exportNote }, studyNotes: { get } }));
    const res = await app.request(`${EXPORT_PATH}?expectedVersion=3`, { headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    expect(exportNote).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });
});
