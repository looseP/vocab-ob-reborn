import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import {
  l2DrillQueueResponseSchema,
  l2SelfAssessResponseSchema,
  l2TaskAnswerResponseSchema,
  l2TaskPayloadSchema,
  l2UndoResponseSchema,
} from "@/http/l2-drill-response-contract";

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

const AUTH_HEADERS = {
  Authorization: "Bearer test-owner",
  "Content-Type": "application/json",
};

const PROGRESS_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const STEP_ID = "33333333-3333-4333-8333-333333333333";
const WORD_ID = "44444444-4444-4444-8444-444444444444";
const LOG_ID = "55555555-5555-4555-8555-555555555555";

const QUEUE = {
  items: [
    {
      progressId: PROGRESS_ID,
      stepId: STEP_ID,
      word: {
        id: WORD_ID,
        slug: "sustain",
        title: "sustain",
        lemma: "sustain",
        short_definition: null,
        ipa: null,
        pos: null,
        cefr: null,
      },
      l2DueAt: null,
      l2ReviewCount: 0,
      singleStep: true,
      task: {
        taskId: "t1",
        taskType: "production",
        prompt: "Use sustain in a sentence",
        stepIndex: 0,
        hintTranslation: "to maintain",
        referenceExample: "Sunlight sustains life.",
      },
    },
  ],
  session: { id: SESSION_ID, mode: "l2_drill" },
  stats: { total: 1, remaining: 1 },
};

function makeMockServices(): Services {
  return {
    authSessions: {} as never,
    words: {} as never,
    notes: {} as never,
    stats: {} as never,
    l2content: {} as never,
    l3Context: {} as never,
    l3Proposal: {} as never,
    l3Read: {} as never,
    l3Recommendation: {} as never,
    l3Import: {} as never,
    runtimeStatus: {} as never,
    authLoginRateLimit: {} as never,
    wordbooks: {
      getOrCreateDefault: vi.fn().mockResolvedValue({ id: "wb-1" }),
    },
    l2Drill: {
      getQueue: vi.fn().mockResolvedValue(QUEUE),
      submitTaskAnswer: vi.fn().mockResolvedValue({
        ok: true,
        outcome: "correct",
        mappedRating: "good",
        l2ReviewLogId: LOG_ID,
        l2NextDueAt: "2026-01-16T12:00:00Z",
        nextStep: { type: "done" },
      }),
      submitSelfAssessment: vi.fn().mockResolvedValue({ ok: true, productionStatus: "passed" }),
      undo: vi.fn().mockResolvedValue({ ok: true }),
    },
  } as unknown as Services;
}

describe("GET /api/l2-drill/queue", () => {
  it("returns a valid queue and forwards userId", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/l2-drill/queue?limit=10", {
      method: "GET",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(l2DrillQueueResponseSchema.parse(await res.json())).toEqual(QUEUE);
    expect(services.l2Drill.getQueue).toHaveBeenCalledWith("user-123", "wb-1", 10);
  });

  it("clamps over-max limit to 100", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/l2-drill/queue?limit=999", {
      method: "GET",
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(services.l2Drill.getQueue).toHaveBeenCalledWith("user-123", "wb-1", 100);
  });
});

// M2 契约红线（spec D8）：answerIndex 绝不允许出现在任何 API 响应。
  // .passthrough() 会透传未知字段，必须由 schema 显式拒绝 —— 防御纵深，
  // 红线不能只靠领域层 stripAnswer 单一保证。
  describe("l2TaskPayloadSchema answerIndex red-line (M2)", () => {
    it("accepts a clean stripped payload without answerIndex", () => {
      expect(
        l2TaskPayloadSchema.parse(QUEUE.items[0].task),
      ).toMatchObject({ taskId: "t1" });
    });

    it("rejects a discrimination payload that leaks answerIndex", () => {
      const leaked = {
        ...QUEUE.items[0].task,
        taskType: "cloze_mcq" as const,
        options: ["a", "b", "c", "d"],
        answerIndex: 2,
      };
      expect(() => l2TaskPayloadSchema.parse(leaked)).toThrow(/answerIndex/);
    });

    it("l2DrillQueueResponseSchema rejects a queue item whose task leaks answerIndex", () => {
      const leakedQueue = {
        ...QUEUE,
        items: [
          {
            ...QUEUE.items[0],
            task: { ...QUEUE.items[0].task, answerIndex: 0 },
          },
        ],
      };
      expect(() => l2DrillQueueResponseSchema.parse(leakedQueue)).toThrow(/answerIndex/);
    });
  });

describe("POST /api/l2-drill/task/answer", () => {
  it("accepts a valid choice and returns the discriminated result", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/l2-drill/task/answer", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0 }),
    });
    expect(res.status).toBe(200);
    const body = l2TaskAnswerResponseSchema.parse(await res.json());
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe("correct");
    expect(services.l2Drill.submitTaskAnswer).toHaveBeenCalledWith(
      { sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0 },
      "user-123",
    );
  });

  it("rejects out-of-range choiceIndex with 400", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/l2-drill/task/answer", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 9 }),
    });
    expect(res.status).toBe(400);
    expect(services.l2Drill.submitTaskAnswer).not.toHaveBeenCalled();
  });

  // M9 契约对齐：前端会送 idempotencyKey，路由+schema 必须透传给 service
  it("forwards idempotencyKey to submitTaskAnswer (M9 contract alignment)", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/l2-drill/task/answer", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        sessionId: SESSION_ID,
        stepId: STEP_ID,
        choiceIndex: 1,
        idempotencyKey: "idem-route-1",
      }),
    });
    expect(res.status).toBe(200);
    expect(services.l2Drill.submitTaskAnswer).toHaveBeenCalledWith(
      { sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 1, idempotencyKey: "idem-route-1" },
      "user-123",
    );
  });
});

describe("POST /api/l2-drill/self-assess", () => {
  it("accepts a verdict and returns production status", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/l2-drill/self-assess", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ sessionId: SESSION_ID, stepId: STEP_ID, verdict: "passed" }),
    });
    expect(res.status).toBe(200);
    expect(l2SelfAssessResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      productionStatus: "passed",
    });
    expect(services.l2Drill.submitSelfAssessment).toHaveBeenCalledWith(
      { sessionId: SESSION_ID, stepId: STEP_ID, verdict: "passed" },
      "user-123",
    );
  });

  it("rejects unknown verdict with 400", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/l2-drill/self-assess", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ sessionId: SESSION_ID, stepId: STEP_ID, verdict: "meh" }),
    });
    expect(res.status).toBe(400);
  });

  // M6 契约对齐：schema 已接受 idempotencyKey，路由必须透传到 service
  it("forwards idempotencyKey to submitSelfAssessment (M6 contract alignment)", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/l2-drill/self-assess", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        sessionId: SESSION_ID,
        stepId: STEP_ID,
        verdict: "weak",
        idempotencyKey: "idem-self-route-1",
      }),
    });
    expect(res.status).toBe(200);
    expect(services.l2Drill.submitSelfAssessment).toHaveBeenCalledWith(
      { sessionId: SESSION_ID, stepId: STEP_ID, verdict: "weak", idempotencyKey: "idem-self-route-1" },
      "user-123",
    );
  });
});

describe("POST /api/l2-drill/undo", () => {
  it("undoes the session and forwards userId", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/l2-drill/undo", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    expect(res.status).toBe(200);
    expect(l2UndoResponseSchema.parse(await res.json())).toEqual({ ok: true });
    // M7 修复后路由总是透传第三参数 idempotencyKey（未提供时为 undefined）
    expect(services.l2Drill.undo).toHaveBeenCalledWith(SESSION_ID, "user-123", undefined);
  });

  // M9 契约对齐：撤销也接受并透传 idempotencyKey；M7 修复后路由必须
  // 把 idempotencyKey 作为第三个参数传给 service.undo()
  it("forwards idempotencyKey to undo path (M7+M9 contract alignment)", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/l2-drill/undo", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ sessionId: SESSION_ID, idempotencyKey: "idem-undo-1" }),
    });
    expect(res.status).toBe(200);
    expect(services.l2Drill.undo).toHaveBeenCalledWith(
      SESSION_ID,
      "user-123",
      "idem-undo-1",
    );
  });

  // M7 契约对齐：撤销幂等命中时返回 idempotent: true
  it("returns idempotent flag when undo service reports idempotent replay", async () => {
    const services = makeMockServices();
    services.l2Drill.undo = vi.fn().mockResolvedValue({ ok: true, idempotent: true });
    const app = createApp(services);
    const res = await app.request("/api/l2-drill/undo", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ sessionId: SESSION_ID, idempotencyKey: "idem-undo-2" }),
    });
    expect(res.status).toBe(200);
    expect(l2UndoResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      idempotent: true,
    });
  });
});
