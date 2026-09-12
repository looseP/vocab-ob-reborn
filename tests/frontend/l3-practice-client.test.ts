/**
 * T11 前端契约层测试：createL3FrontendClient 的新增方法（练习 / 会话）
 * 直接执行 contract.ts 的装配 + 校验分支（页面测试走 mock 客户端，不经这里）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createL3FrontendClient,
  validateErrorBookParams,
  validateOccurrenceListParams,
  validatePracticeAttemptCreateInput,
  validatePracticeAttemptListParams,
  validateSessionCreateInput,
  validateSessionEndInput,
} from "@/l3/frontend/contract";

function makeTransport() {
  const fetchImpl = vi.fn(async (_input: string, _init?: { method?: string; body?: string }) => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }));
  return { transport: { fetch: fetchImpl as never }, fetchImpl };
}

function makeFailingTransport(status: number, body: unknown) {
  const fetchImpl = vi.fn(async () => ({ ok: false, status, json: async () => body }));
  return { transport: { fetch: fetchImpl as never }, fetchImpl };
}

const PAYLOAD = { taskId: "essay_dictation:0123456789abcdef" };

describe("L3 client: practice methods", () => {
  it("records an attempt with POST and a JSON body", async () => {
    const { transport, fetchImpl } = makeTransport();
    const client = createL3FrontendClient(transport);

    await client.recordAttempt({
      contextId: "ctx-1",
      occurrenceId: "occ-1",
      practiceType: "essay_dictation",
      outcome: "wrong",
      payload: PAYLOAD,
    });

    expect(fetchImpl).toHaveBeenCalledWith("/api/l3-practice/attempts", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        contextId: "ctx-1",
        occurrenceId: "occ-1",
        practiceType: "essay_dictation",
        outcome: "wrong",
        payload: PAYLOAD,
      }),
    }));
  });

  it("rejects a payload without taskId before any request", async () => {
    const { transport, fetchImpl } = makeTransport();
    const client = createL3FrontendClient(transport);

    let caught: unknown = null;
    try {
      await client.recordAttempt({ contextId: "ctx-1", practiceType: "context_quiz", outcome: "correct", payload: { other: 1 } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ status: 400, code: "FRONTEND_VALIDATION_ERROR" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lists attempts with the two-axis filters and pagination", async () => {
    const { transport, fetchImpl } = makeTransport();
    const client = createL3FrontendClient(transport);

    await client.listAttempts({ practiceType: "context_quiz", outcome: "wrong", space: "阅读", direction: "考研", limit: 10, offset: 5 });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/l3-practice/attempts?practiceType=context_quiz&outcome=wrong&space=%E9%98%85%E8%AF%BB&direction=%E8%80%83%E7%A0%94&limit=10&offset=5",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("lists the error book with space/direction filters", async () => {
    const { transport, fetchImpl } = makeTransport();
    const client = createL3FrontendClient(transport);

    await client.listErrorBook({ space: "语法", direction: "雅思" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/l3-practice/error-book?space=%E8%AF%AD%E6%B3%95&direction=%E9%9B%85%E6%80%9D",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("lists occurrences with cursor pagination", async () => {
    const { transport, fetchImpl } = makeTransport();
    const client = createL3FrontendClient(transport);

    await client.listOccurrences({ space: "作文", limit: 20, cursor: "c1" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/l3/occurrences?space=%E4%BD%9C%E6%96%87&limit=20&cursor=c1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("normalizes a transport error thrown by the server", async () => {
    const { transport } = makeFailingTransport(422, { error: "payload.taskId is required", code: "VALIDATION_ERROR" });
    const client = createL3FrontendClient(transport);

    await expect(
      client.recordAttempt({ contextId: "ctx-1", practiceType: "context_quiz", outcome: "correct", payload: PAYLOAD }),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR", kind: "validation" });
  });
});

describe("L3 client: session methods", () => {
  it("creates a session with POST and a JSON body", async () => {
    const { transport, fetchImpl } = makeTransport();
    const client = createL3FrontendClient(transport);

    await client.createSession({ type: "cram_pack", title: "考前", space: "阅读", direction: "考研", contextCount: 20, days: 7 });

    expect(fetchImpl).toHaveBeenCalledWith("/api/l3-sessions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ type: "cram_pack", title: "考前", space: "阅读", direction: "考研", contextCount: 20, days: 7 }),
    }));
  });

  it("gets a session by explicit id", async () => {
    const { transport, fetchImpl } = makeTransport();
    const client = createL3FrontendClient(transport);

    await client.getSession("sess-1");
    expect(fetchImpl).toHaveBeenCalledWith("/api/l3-sessions/sess-1", expect.objectContaining({ method: "GET" }));

    let caught: unknown = null;
    try {
      await client.getSession("  ");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ status: 400, code: "FRONTEND_VALIDATION_ERROR" });
  });

  it("ends a session with the given status", async () => {
    const { transport, fetchImpl } = makeTransport();
    const client = createL3FrontendClient(transport);

    await client.endSession("sess-1", "abandoned");
    expect(fetchImpl).toHaveBeenCalledWith("/api/l3-sessions/sess-1/end", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ status: "abandoned" }),
    }));
  });
});

describe("L3 client: validators", () => {
  /** 校验失败的字段名（归一化错误的 fieldErrors 键）。 */
  function fieldNames(fn: () => unknown): string[] {
    try {
      fn();
    } catch (error) {
      const normalized = error as { fieldErrors?: Record<string, string[]> };
      return Object.keys(normalized.fieldErrors ?? {});
    }
    return [];
  }

  it("validates practice attempt input", () => {
    expect(fieldNames(() => validatePracticeAttemptCreateInput({ contextId: "ctx-1", practiceType: "bogus" as never, outcome: "correct", payload: PAYLOAD }))).toEqual(["practiceType"]);
    expect(fieldNames(() => validatePracticeAttemptCreateInput({ contextId: "ctx-1", practiceType: "context_quiz", outcome: "meh" as never, payload: PAYLOAD }))).toEqual(["outcome"]);
    expect(fieldNames(() => validatePracticeAttemptCreateInput({ contextId: "", practiceType: "context_quiz", outcome: "correct", payload: PAYLOAD }))).toEqual(["contextId"]);
    expect(fieldNames(() => validatePracticeAttemptCreateInput({ contextId: "ctx-1", practiceType: "context_quiz", outcome: "correct", payload: {} }))).toEqual(["payload.taskId"]);
    expect(validatePracticeAttemptCreateInput({ contextId: "ctx-1", occurrenceId: "occ-1", practiceType: "context_quiz", outcome: "correct", payload: PAYLOAD })).toMatchObject({ occurrenceId: "occ-1" });
  });

  it("bounds list and error-book params", () => {
    expect(fieldNames(() => validatePracticeAttemptListParams({ space: "nope" as never }))).toEqual(["space"]);
    expect(fieldNames(() => validatePracticeAttemptListParams({ direction: "nope" as never }))).toEqual(["direction"]);
    expect(fieldNames(() => validatePracticeAttemptListParams({ limit: 101 }))).toEqual(["limit"]);
    expect(fieldNames(() => validatePracticeAttemptListParams({ offset: -1 }))).toEqual(["offset"]);
    expect(fieldNames(() => validateErrorBookParams({ space: "nope" as never }))).toEqual(["space"]);
    expect(fieldNames(() => validateErrorBookParams({ limit: 0 }))).toEqual(["limit"]);
    expect(fieldNames(() => validateErrorBookParams({ offset: 1.5 }))).toEqual(["offset"]);
  });

  it("bounds occurrence list params", () => {
    expect(fieldNames(() => validateOccurrenceListParams({ slug: " " }))).toEqual(["slug"]);
    expect(fieldNames(() => validateOccurrenceListParams({ wordId: "" }))).toEqual(["wordId"]);
    expect(fieldNames(() => validateOccurrenceListParams({ contextId: "" }))).toEqual(["contextId"]);
    expect(fieldNames(() => validateOccurrenceListParams({ cursor: " " }))).toEqual(["cursor"]);
    expect(fieldNames(() => validateOccurrenceListParams({ direction: "nope" as never }))).toEqual(["direction"]);
    expect(fieldNames(() => validateOccurrenceListParams({ limit: 0 }))).toEqual(["limit"]);
  });

  it("validates session create input", () => {
    expect(fieldNames(() => validateSessionCreateInput({ type: "nope" as never }))).toEqual(["type"]);
    expect(fieldNames(() => validateSessionCreateInput({ type: "cram_pack", title: " " }))).toEqual(["title"]);
    expect(fieldNames(() => validateSessionCreateInput({ type: "cram_pack", title: "x".repeat(501) }))).toEqual(["title"]);
    expect(fieldNames(() => validateSessionCreateInput({ type: "cram_pack", seed: " " }))).toEqual(["seed"]);
    expect(fieldNames(() => validateSessionCreateInput({ type: "cram_pack", space: "nope" as never }))).toEqual(["space"]);
    expect(fieldNames(() => validateSessionCreateInput({ type: "cram_pack", direction: "nope" as never }))).toEqual(["direction"]);
    expect(fieldNames(() => validateSessionCreateInput({ type: "cram_pack", contextCount: 0 }))).toEqual(["contextCount"]);
    expect(fieldNames(() => validateSessionCreateInput({ type: "cram_pack", contextCount: 201 }))).toEqual(["contextCount"]);
    expect(fieldNames(() => validateSessionCreateInput({ type: "cram_pack", days: 91 }))).toEqual(["days"]);
    expect(fieldNames(() => validateSessionCreateInput({ type: "cram_pack", days: 2.5 }))).toEqual(["days"]);
  });

  it("validates session end status and passes valid input through", () => {
    expect(validateSessionEndInput({ status: "completed" })).toEqual({ status: "completed" });
    expect(fieldNames(() => validateSessionEndInput({ status: "active" as never }))).toEqual(["status"]);
    expect(validatePracticeAttemptListParams({ space: "阅读" })).toEqual({ space: "阅读" });
    expect(validateOccurrenceListParams({ limit: 10 })).toEqual({ limit: 10 });
  });
});
