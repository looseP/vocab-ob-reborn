/**
 * 学习笔记导出 · 版本冲突**真实链路**回归（Task 10 收口 C1）。
 *
 * 背景（为什么需要本文件）：`tests/http/study-note-export.test.ts` 里的 409 用例注入的是
 * 一个**直接抛 ConflictError 的 mock service**，它把「服务端会不会 409」当成既定输入，
 * 因此从不执行 `note.version !== expectedVersion` 这一比较。实测：注释掉该比较后，
 * 该用例**仍然通过**——它没有守住版本合同。
 *
 * 本文件改为把**真实的 L3StudyNoteExportService** 接到 app 上，只替换最底层仓储
 * （requireTx 的仓储实现），于是：
 *   请求 → 路由 → 真实 service → 真实比较 → 409 → 路由错误映射 → 响应
 * 整条链路都是真代码。删除/短路版本比较时，本文件的用例必然转红。
 *
 * 覆盖面：
 *  - 旧版本 → 409，只带 currentVersion，不含服务器正文（真实比较产生，非注入）；
 *  - 版本一致 → 200（同一探针的正向对照，证明 409 不是"永远 409"的假阳性）；
 *  - 缺 expectedVersion → 422（真实 service 的 ValidationError）；
 *  - 归档笔记同样核对、不豁免。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import { L3StudyNoteExportService } from "@/services/l3-study-note-export.service";
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
const OWNER_ID = "user-123";
const NOTE_ID = "00000000-0000-4000-8000-000000000101";

beforeAll(() => {
  process.env.OWNER_API_TOKEN = OWNER_TOKEN;
  process.env.LOCAL_OWNER_ID = OWNER_ID;
});
afterAll(() => {
  delete process.env.OWNER_API_TOKEN;
  delete process.env.LOCAL_OWNER_ID;
});

const AUTH_HEADERS = { Authorization: `Bearer ${OWNER_TOKEN}` };
const EXPORT_PATH = `/api/l3/study-notes/${NOTE_ID}/export`;

/** 持久化笔记行（renderer 读取 body_md / title / status / version）。 */
function noteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTE_ID,
    user_id: OWNER_ID,
    title: "版本合同回归笔记",
    body_md: "正文段落，无引用标记。",
    status: "active",
    pinned: false,
    version: 3,
    created_at: "2026-09-22T00:00:00.000Z",
    updated_at: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * 构造真实导出 service：只把两个仓储替换为受控假实现，其余（事务、比较、渲染、
 * 引用组装、错误类型）全部走生产代码。`txRunner` 直接以 undefined 作 tx 调用回调——
 * 仓储是假的，不需要真事务。
 */
function realExportService(note: Record<string, unknown> | null) {
  const calls = {
    lockForShare: 0,
    listVenues: 0,
    listForNote: 0,
  };
  const service = new L3StudyNoteExportService(
    (async (cb: (tx: undefined) => Promise<unknown>) => cb(undefined)) as never,
    (() => ({
      studyNotes: {
        lockForShare: async () => {
          calls.lockForShare += 1;
          return note;
        },
        listVenues: async () => {
          calls.listVenues += 1;
          return [];
        },
      },
      studyReferences: {
        listForNote: async () => {
          calls.listForNote += 1;
          return [];
        },
      },
    })) as never,
  );
  return { service, calls };
}

function appWith(service: L3StudyNoteExportService) {
  return createApp({
    studyNotes: {},
    studyReferences: {},
    l3StudyNoteExport: service,
  } as unknown as Services);
}

describe("版本冲突走真实 service 链路（不是注入的 mock）", () => {
  it("rejects a stale expectedVersion with 409 through the real comparison", async () => {
    // 持久化 version=3；请求 expectedVersion=2 → 必须由真实比较判定冲突。
    const { service, calls } = realExportService(noteRow({ version: 3 }));
    const res = await appWith(service).request(`${EXPORT_PATH}?expectedVersion=2`, {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(409);
    // 真实 service 被真正执行到锁与读引用的位置
    expect(calls.lockForShare).toBe(1);
    expect(calls.listForNote).toBe(1);

    const payload = (await res.json()) as Record<string, unknown>;
    // 只回 currentVersion（= 持久化的 3），且不回传服务器正文
    expect(JSON.stringify(payload)).toContain("3");
    expect(JSON.stringify(payload)).not.toContain("内容校验");
    expect(JSON.stringify(payload)).not.toContain("版本合同回归笔记");
    expect(JSON.stringify(payload)).not.toContain("正文段落");
  });

  it("accepts the matching expectedVersion with 200 (the same probe's positive control)", async () => {
    // 同一探针、同一持久化行，仅把 expectedVersion 改为一致值 → 200。
    // 这条证明上一条的 409 来自真实比较，而不是"永远 409"的假阳性。
    const { service, calls } = realExportService(noteRow({ version: 3 }));
    const res = await appWith(service).request(`${EXPORT_PATH}?expectedVersion=3`, {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="study-note-${NOTE_ID}.md"`,
    );
    expect(res.headers.get("X-Export-Schema-Version")).toBe("1");
    expect(calls.lockForShare).toBe(1);

    const body = await res.text();
    expect(body).toContain("版本合同回归笔记");
    // 响应头 hash 与正文校验行同值（真实双段渲染）。
    // 真实行形如：`- 内容校验: sha256:<64hex>（删除本行后可复算）`
    // （src/services/l3-study-note-export.service.ts:433，ASCII 冒号）。
    const inBody = body.split("\n").find((line) => line.includes("内容校验"));
    expect(inBody).toBeTruthy();
    const inBodyHash = /sha256:([0-9a-f]{64})/.exec(inBody!)![1]!;
    expect(inBodyHash).toBe(res.headers.get("X-Export-Sha256"));
  });

  it("rejects a missing expectedVersion with 422 from the real service", async () => {
    const { service } = realExportService(noteRow({ version: 3 }));
    const res = await appWith(service).request(EXPORT_PATH, { headers: AUTH_HEADERS });
    expect(res.status).toBe(422);
  });

  it("checks the version for an archived note too (no exemption)", async () => {
    const { service } = realExportService(noteRow({ version: 5, status: "archived" }));
    const res = await appWith(service).request(`${EXPORT_PATH}?expectedVersion=4`, {
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(409);
  });

  it("archived note with a matching version still exports", async () => {
    const { service } = realExportService(noteRow({ version: 5, status: "archived" }));
    const res = await appWith(service).request(`${EXPORT_PATH}?expectedVersion=5`, {
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
  });
});
