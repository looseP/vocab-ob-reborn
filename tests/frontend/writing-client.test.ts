/**
 * writingClient 测试（W6）：契约校验的客户端行为——非法响应必须显式报错，
 * 绝不归一为「成功空值」；服务端错误经 BrowserApiError 原样上抛（含 details）。
 */
import { describe, expect, it, vi } from "vitest";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { createWritingClient } from "@/frontend/api/writingClient";

const TASK_ID = "00000000-0000-4000-8000-000000000701";
const SHEET_ID = "00000000-0000-4000-8000-000000000801";
const QUESTION_ID = "00000000-0000-4000-8000-000000000101";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const taskDto = {
  id: TASK_ID,
  questionId: QUESTION_ID,
  title: "任务",
  prompt: "自由写作",
  kind: "free",
  direction: "通用",
  status: "active",
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};

describe("writingClient（契约校验）", () => {
  it("合法响应解析通过并回传", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      task: taskDto,
      draft: null,
      created: false,
    }));
    const client = createWritingClient({ fetch: fetchMock as unknown as typeof fetch });
    const result = await client.createTask({ requestId: SHEET_ID, kind: "free", direction: "通用" });
    expect(result.created).toBe(false);
    expect(result.task.id).toBe(TASK_ID);
  });

  it("非法响应（形状/字段不符）→ BrowserApiError(INVALID_RESPONSE)，不返回假成功", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ task: { id: TASK_ID }, draft: null, created: true }));
    const client = createWritingClient({ fetch: fetchMock as unknown as typeof fetch });
    await expect(client.createTask({ requestId: SHEET_ID, kind: "free", direction: "通用" }))
      .rejects.toMatchObject({ name: "BrowserApiError", code: "INVALID_RESPONSE" });

    const feedbackMock = vi.fn(async () => jsonResponse({ state: "processing", feedback: null }));
    const client2 = createWritingClient({ fetch: feedbackMock as unknown as typeof fetch });
    await expect(client2.getFeedback(TASK_ID, SHEET_ID)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("服务端错误（409）经 BrowserApiError 上抛且 details 保留", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(
      { error: "draft version conflict", code: "CONFLICT", details: { code: "DRAFT_VERSION_CONFLICT", actualVersion: 2 } },
      409,
    ));
    const client = createWritingClient({ fetch: fetchMock as unknown as typeof fetch });
    const failure = client.saveDraft(TASK_ID, SHEET_ID, { expectedVersion: 1, text: "x" });
    await expect(failure).rejects.toBeInstanceOf(BrowserApiError);
    await expect(failure).rejects.toMatchObject({
      status: 409,
      details: { code: "DRAFT_VERSION_CONFLICT", actualVersion: 2 },
    });
  });

  it("exportSheet 返回原文；空响应 → INVALID_RESPONSE（不产生空文件假成功）", async () => {
    const markdown = "# L3 作文档案（v1）\n\n- 任务: x\n\n## 正文\n";
    const okMock = vi.fn(async () => new Response(markdown, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    }));
    const okClient = createWritingClient({ fetch: okMock as unknown as typeof fetch });
    await expect(okClient.exportSheet(TASK_ID, SHEET_ID)).resolves.toBe(markdown);

    const emptyMock = vi.fn(async () => new Response("", { status: 200, headers: { "Content-Type": "text/markdown" } }));
    const emptyClient = createWritingClient({ fetch: emptyMock as unknown as typeof fetch });
    await expect(emptyClient.exportSheet(TASK_ID, SHEET_ID)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("clearSheetContent：DELETE 请求并解析 sheet DTO", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({
        sheet: {
          id: SHEET_ID, taskId: TASK_ID, status: "sealed", draftVersion: 3, revisionNo: 1,
          parentSheetId: null, createdAt: "x", updatedAt: "x", sealedAt: "x",
        },
      });
    });
    const client = createWritingClient({ fetch: fetchMock as unknown as typeof fetch });
    // 路由直接返回 sheet DTO（不包 {sheet} 包装）——这里回包 {sheet:{...}} 应判 INVALID_RESPONSE。
    await expect(client.clearSheetContent(TASK_ID, SHEET_ID)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(calls[0]!.init.method).toBe("DELETE");

    const direct = vi.fn(async () => jsonResponse({
      id: SHEET_ID, taskId: TASK_ID, status: "sealed", draftVersion: 3, revisionNo: 1,
      parentSheetId: null, createdAt: "x", updatedAt: "x", sealedAt: "x",
    }));
    const directClient = createWritingClient({ fetch: direct as unknown as typeof fetch });
    const cleared = await directClient.clearSheetContent(TASK_ID, SHEET_ID);
    expect(cleared.id).toBe(SHEET_ID);
  });

  it("请求构造：路径、方法与 JSON body 正确（保存与反馈 PUT）", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).includes("/feedback")) {
        return jsonResponse({
          feedback: {
            schemaVersion: 1, summary: "s", strengths: [],
            dimensions: {
              task_response: { applicable: true, comment: "c" },
              organization: { applicable: true, comment: "c" },
              language: { applicable: true, comment: "c" },
              expression: { applicable: false, comment: "本稿不评。" },
            },
            priorities: [],
          },
          version: 1, textSha256: "a".repeat(64), lastEditor: "agent-a", updatedAt: "2026-09-18T00:00:00.000Z",
        });
      }
      return jsonResponse({ sheet: { id: SHEET_ID, taskId: TASK_ID, status: "draft", draftVersion: 1, revisionNo: null, parentSheetId: null, createdAt: "x", updatedAt: "x", sealedAt: null }, textSha256: "a".repeat(64) });
    });
    const client = createWritingClient({ fetch: fetchMock as unknown as typeof fetch });

    await client.saveDraft(TASK_ID, SHEET_ID, { expectedVersion: 0, text: "初稿" });
    expect(calls[0]!.url).toBe(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}`);
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ expectedVersion: 0, text: "初稿" });

    await client.putFeedback(TASK_ID, SHEET_ID, {
      expectedVersion: 0,
      textSha256: "a".repeat(64),
      requestId: SHEET_ID,
      feedback: {
        schemaVersion: 1, summary: "s", strengths: [],
        dimensions: {
          task_response: { applicable: true, comment: "c" },
          organization: { applicable: true, comment: "c" },
          language: { applicable: true, comment: "c" },
          expression: { applicable: false, comment: "本稿不评。" },
        },
        priorities: [],
      },
    });
    expect(calls[1]!.url).toBe(`/api/l3/writing/tasks/${TASK_ID}/sheets/${SHEET_ID}/feedback`);
    expect(calls[1]!.init.method).toBe("PUT");
  });
});
