/**
 * studyNotesClient 测试（Task 07）：契约校验的客户端行为——
 * 非法响应必须显式报错（绝不归一为「空笔记/空列表」）；服务端错误经
 * BrowserApiError 原样上抛（含 details / 状态 / headers）。
 *
 * 关键取证（与任务书两处校准绑定）：
 *  - preview 请求体 = ReferenceTarget 本体（无 {target} 包装）；
 *  - 列表布尔 query = "1"/"0"（非 true/false）。
 */
import { describe, expect, it, vi } from "vitest";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { createStudyNotesClient } from "@/frontend/api/studyNotesClient";

const REQ_ID = "00000000-0000-4000-8000-000000000501";
const NOTE_ID = "00000000-0000-4000-8000-000000000701";
const TOPIC_ID = "00000000-0000-4000-8000-000000000702";
const REF_ID = "00000000-0000-4000-8000-000000000801";
const SOURCE_ID = "00000000-0000-4000-8000-000000000901";
const QUESTION_ID = "00000000-0000-4000-8000-000000000902";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const noteSummary = {
  id: NOTE_ID,
  title: "笔记标题",
  venues: ["cloze"],
  pinned: false,
  status: "active",
  version: 3,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T01:00:00.000Z",
};

const referencePreview = {
  id: REF_ID,
  target: { kind: "source", sourceId: SOURCE_ID },
  status: "current",
  capturedAt: "2026-09-20T00:30:00.000Z",
  displaySnapshot: { kind: "source", title: "来源", excerpt: "摘录" },
  liveTitle: "来源",
};

const noteDto = { ...noteSummary, bodyMd: "我的判断是……", references: [referencePreview] };

const topicDto = {
  id: TOPIC_ID,
  questionType: "cloze",
  title: "专题",
  status: "active",
  version: 2,
  memberCount: 1,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:10:00.000Z",
};

function captureClient(responder: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responder(String(url), init ?? {});
  });
  const client = createStudyNotesClient({ fetch: fetchMock as unknown as typeof fetch });
  return { client, calls };
}

describe("studyNotesClient（响应契约）", () => {
  it("合法响应解析通过并回传（create / get / save）", async () => {
    const created = captureClient(() => jsonResponse({ item: noteDto, created: true }, 201));
    const createResult = await created.client.create({ requestId: REQ_ID, venue: "cloze" });
    expect(createResult.created).toBe(true);
    expect(createResult.item.id).toBe(NOTE_ID);
    expect(createResult.item.references[0]!.status).toBe("current");

    const got = captureClient(() => jsonResponse({ item: noteDto }));
    await expect(got.client.get(NOTE_ID)).resolves.toMatchObject({ item: { id: NOTE_ID, version: 3 } });

    const saved = captureClient(() => jsonResponse({ item: { ...noteDto, version: 4 } }));
    const saveResult = await saved.client.save(NOTE_ID, {
      expectedVersion: 3,
      requestId: REQ_ID,
      title: "笔记标题",
      bodyMd: "我的判断是……",
      venues: ["cloze"],
      pinned: false,
      status: "active",
      references: [{ id: REF_ID, action: "keep" }],
    });
    expect(saveResult.item.version).toBe(4);
  });

  it("非法 200：缺 item → INVALID_RESPONSE（不归一为空笔记）", async () => {
    const { client } = captureClient(() => jsonResponse({ created: true }));
    await expect(client.create({ requestId: REQ_ID, venue: "cloze" })).rejects.toMatchObject({
      name: "BrowserApiError",
      code: "INVALID_RESPONSE",
    });
  });

  it("非法 200：references 元素缺 status / 列表 total 类型不符 → INVALID_RESPONSE", async () => {
    const { status: _status, ...referenceWithoutStatus } = referencePreview;
    const badDetail = captureClient(() =>
      jsonResponse({ item: { ...noteDto, references: [referenceWithoutStatus] } }),
    );
    await expect(badDetail.client.get(NOTE_ID)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const badTotal = captureClient(() => jsonResponse({ items: [], total: "3", nextCursor: null }));
    await expect(badTotal.client.list({ venue: "cloze" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("非法 200：列表 items 元素形状不符 → INVALID_RESPONSE（不截断成空列表）", async () => {
    const { client } = captureClient(() =>
      jsonResponse({ items: [{ id: NOTE_ID }], total: 1, nextCursor: null }),
    );
    await expect(client.list({ venue: "cloze" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("合法列表保留 nextCursor（不截断、不重建）", async () => {
    const { client } = captureClient(() =>
      jsonResponse({ items: [noteSummary], total: 21, nextCursor: "cursor-abc" }),
    );
    const page = await client.list({ venue: "cloze" });
    expect(page.nextCursor).toBe("cursor-abc");
    expect(page.total).toBe(21);
    expect(page.items).toHaveLength(1);
  });

  it("409 版本冲突：status/code/details.currentVersion 原样传递，不被吞", async () => {
    const { client } = captureClient(() =>
      jsonResponse(
        {
          error: "Study note version conflict",
          code: "CONFLICT",
          message: "Study note version conflict",
          details: { noteId: NOTE_ID, currentVersion: 5 },
          requestId: "req-409",
        },
        409,
      ),
    );
    const failure = client.save(NOTE_ID, {
      expectedVersion: 3,
      requestId: REQ_ID,
      title: "t",
      bodyMd: "",
      venues: ["cloze"],
      pinned: false,
      status: "active",
      references: [],
    });
    await expect(failure).rejects.toBeInstanceOf(BrowserApiError);
    await expect(failure).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      details: { noteId: NOTE_ID, currentVersion: 5 },
    });
  });

  it("无 currentVersion 的 409（幂等冲突）不制造版本号", async () => {
    const { client } = captureClient(() =>
      jsonResponse(
        { error: "Idempotency conflict", code: "CONFLICT", details: { noteId: NOTE_ID } },
        409,
      ),
    );
    const caught = await client
      .save(NOTE_ID, {
        expectedVersion: 3,
        requestId: REQ_ID,
        title: "t",
        bodyMd: "",
        venues: ["cloze"],
        pinned: false,
        status: "active",
        references: [],
      })
      .catch((err: unknown) => err as BrowserApiError);
    expect(caught).toBeInstanceOf(BrowserApiError);
    const details = caught.details as Record<string, unknown>;
    expect(details.currentVersion).toBeUndefined();
  });

  it("422 字段级 details 原样传递", async () => {
    const { client } = captureClient(() =>
      jsonResponse(
        {
          error: "Invalid request",
          code: "VALIDATION_ERROR",
          message: "Invalid request",
          details: { formErrors: [], fieldErrors: { bodyMd: ["引用标记与引用集合不一致"] } },
        },
        422,
      ),
    );
    await expect(
      client.save(NOTE_ID, {
        expectedVersion: 3,
        requestId: REQ_ID,
        title: "t",
        bodyMd: "",
        venues: ["cloze"],
        pinned: false,
        status: "active",
        references: [],
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { fieldErrors: { bodyMd: ["引用标记与引用集合不一致"] } },
    });
  });

  it("401/403/404 状态与 code 保留", async () => {
    const cases: Array<[number, string]> = [
      [401, "UNAUTHORIZED"],
      [403, "FORBIDDEN"],
      [404, "NOT_FOUND"],
    ];
    for (const [status, code] of cases) {
      const { client } = captureClient(() => jsonResponse({ error: code, code }, status));
      await expect(client.get(NOTE_ID)).rejects.toMatchObject({ status, code });
    }
  });

  it("非 JSON 500：不崩溃、错误可读", async () => {
    const { client } = captureClient(
      () => new Response("<html>gateway error</html>", { status: 500, headers: { "Content-Type": "text/html" } }),
    );
    await expect(client.get(NOTE_ID)).rejects.toMatchObject({
      status: 500,
      message: "<html>gateway error</html>",
      body: "<html>gateway error</html>",
    });
  });

  it("429：Retry-After 经错误对象保留（控制器有界重试的输入）", async () => {
    const { client } = captureClient(() =>
      jsonResponse({ error: "Too many requests", code: "RATE_LIMITED" }, 429, { "Retry-After": "7" }),
    );
    const caught = await client.get(NOTE_ID).catch((err: unknown) => err as BrowserApiError);
    expect(caught).toBeInstanceOf(BrowserApiError);
    expect(caught.status).toBe(429);
    expect(caught.headers?.get("Retry-After")).toBe("7");
  });
});

describe("studyNotesClient（请求构建）", () => {
  it("list：布尔以 \"1\"/\"0\" 序列化；undefined 省略；cursor 原样透传", async () => {
    const { client, calls } = captureClient(() => jsonResponse({ items: [], total: 0, nextCursor: null }));

    await client.list({ venue: "reading_choice", q: "fox", pinned: true, limit: 20 });
    expect(calls[0]!.url).toBe("/api/l3/study-notes?venue=reading_choice&q=fox&pinned=1&limit=20");

    await client.list({ venue: "cloze", pinned: false, unfiled: true });
    expect(calls[1]!.url).toBe("/api/l3/study-notes?venue=cloze&pinned=0&unfiled=1");

    const cursor = "eyJ2IjoxLCJpZCI6ImFiYyJ9";
    await client.list({ venue: "cloze", cursor });
    const parsed = new URL(calls[2]!.url, "http://local");
    expect(parsed.searchParams.get("cursor")).toBe(cursor);
    expect(calls[2]!.url).not.toContain("pinned=");
    expect(calls[2]!.url).not.toContain("unfiled=");
  });

  it("searchTargets：kind 必发、undefined 省略", async () => {
    const { client, calls } = captureClient(() => jsonResponse({ items: [], total: 0, nextCursor: null }));
    await client.searchTargets({ kind: "source", q: "abc" });
    expect(calls[0]!.url).toBe("/api/l3/study-notes/reference-targets?kind=source&q=abc");
    await client.searchTargets({ kind: "question", venue: "cloze", limit: 10 });
    expect(calls[1]!.url).toBe("/api/l3/study-notes/reference-targets?kind=question&venue=cloze&limit=10");
  });

  it("preview：POST body = ReferenceTarget 本体（无 {target} 包装）", async () => {
    const { client, calls } = captureClient(() =>
      jsonResponse({
        preview: {
          target: { kind: "source", sourceId: SOURCE_ID },
          displaySnapshot: { kind: "source", title: "来源", excerpt: "摘录" },
          liveTitle: null,
        },
      }),
    );
    const result = await client.preview({ kind: "source", sourceId: SOURCE_ID });
    expect(calls[0]!.init.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ kind: "source", sourceId: SOURCE_ID });
    expect(body).not.toHaveProperty("target");
    expect(result.liveTitle).toBeNull();
  });

  it("preview：非法响应（缺 preview）→ INVALID_RESPONSE", async () => {
    const { client } = captureClient(() => jsonResponse({}));
    await expect(client.preview({ kind: "question", questionId: QUESTION_ID })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("DELETE 成员操作：JSON body + DELETE 方法；PUT 成员含 beforeNoteId:null", async () => {
    const { client, calls } = captureClient((url, init) =>
      jsonResponse({ item: topicDto }, init.method === "PUT" && url.endsWith(TOPIC_ID) ? 200 : 200),
    );
    await client.removeTopicMember(TOPIC_ID, NOTE_ID, { requestId: REQ_ID, expectedVersion: 4 });
    expect(calls[0]!.url).toBe(`/api/l3/study-topics/${TOPIC_ID}/members/${NOTE_ID}`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ requestId: REQ_ID, expectedVersion: 4 });

    await client.moveTopicMember(TOPIC_ID, NOTE_ID, {
      requestId: REQ_ID,
      expectedVersion: 4,
      beforeNoteId: null,
    });
    expect(calls[1]!.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      requestId: REQ_ID,
      expectedVersion: 4,
      beforeNoteId: null,
    });
  });

  it("路径参数编码（encodeURIComponent）", async () => {
    const { client, calls } = captureClient(() => jsonResponse({ item: noteDto }));
    await client.get("a/b c").catch(() => undefined);
    expect(calls[0]!.url).toBe("/api/l3/study-notes/a%2Fb%20c");
  });

  it("12 操作路径与方法全表核对", async () => {
    const { client, calls } = captureClient((url, init) => {
      const method = init.method ?? "GET";
      const path = url.split("?")[0]!;
      if (url.includes("reference-targets")) {
        return jsonResponse({ items: [{ id: SOURCE_ID, title: "T", createdAt: "x" }], total: 1, nextCursor: null });
      }
      if (url.includes("reference-preview")) {
        return jsonResponse({
          preview: {
            target: { kind: "source", sourceId: SOURCE_ID },
            displaySnapshot: { kind: "source", title: "T", excerpt: "E" },
            liveTitle: null,
          },
        });
      }
      if (url.includes("backlinks")) {
        return jsonResponse({ items: [], total: 0, nextCursor: null });
      }
      if (path.includes("/study-topics")) {
        if (method === "GET") return jsonResponse({ items: [topicDto], total: 1, nextCursor: null });
        return jsonResponse(method === "POST" ? { item: topicDto, created: true } : { item: topicDto });
      }
      if (path.endsWith("/study-notes")) {
        if (method === "GET") return jsonResponse({ items: [noteSummary], total: 1, nextCursor: null });
        return jsonResponse({ item: noteDto, created: false });
      }
      return jsonResponse({ item: noteDto });
    });

    await client.create({ requestId: REQ_ID, venue: "cloze" });
    await client.list({ venue: "cloze" });
    await client.get(NOTE_ID);
    await client.save(NOTE_ID, {
      expectedVersion: 1, requestId: REQ_ID, title: "", bodyMd: "", venues: ["cloze"],
      pinned: false, status: "active", references: [],
    });
    await client.searchTargets({ kind: "source" });
    await client.preview({ kind: "source", sourceId: SOURCE_ID });
    await client.backlinks({ targetKind: "source", targetId: SOURCE_ID });
    await client.createTopic({ requestId: REQ_ID, venue: "cloze", title: "专题" });
    await client.listTopics({ venue: "cloze" });
    await client.saveTopic(TOPIC_ID, { requestId: REQ_ID, expectedVersion: 1, title: "专题", status: "active" });
    await client.moveTopicMember(TOPIC_ID, NOTE_ID, { requestId: REQ_ID, expectedVersion: 1, beforeNoteId: null });
    await client.removeTopicMember(TOPIC_ID, NOTE_ID, { requestId: REQ_ID, expectedVersion: 1 });

    const table = calls.map((call) => `${call.init.method} ${call.url.split("?")[0]}`);
    expect(table).toEqual([
      "POST /api/l3/study-notes",
      "GET /api/l3/study-notes",
      `GET /api/l3/study-notes/${NOTE_ID}`,
      `PUT /api/l3/study-notes/${NOTE_ID}`,
      "GET /api/l3/study-notes/reference-targets",
      "POST /api/l3/study-notes/reference-preview",
      "GET /api/l3/study-notes/backlinks",
      "POST /api/l3/study-topics",
      "GET /api/l3/study-topics",
      `PUT /api/l3/study-topics/${TOPIC_ID}`,
      `PUT /api/l3/study-topics/${TOPIC_ID}/members/${NOTE_ID}`,
      `DELETE /api/l3/study-topics/${TOPIC_ID}/members/${NOTE_ID}`,
    ]);
  });
});

describe("studyNotesClient（负向约束）", () => {
  it("不提供 export/未实现端点的客户端函数；方法面 = 12 个既有操作", () => {
    const client = createStudyNotesClient();
    const keys = Object.keys(client).sort();
    expect(keys).toEqual(
      [
        "backlinks", "create", "createTopic", "get", "list", "listTopics",
        "moveTopicMember", "preview", "removeTopicMember", "save", "saveTopic", "searchTargets",
      ].sort(),
    );
    expect("exportSheet" in client).toBe(false);
    expect("exportNote" in client).toBe(false);
    expect("export" in client).toBe(false);
  });
});
