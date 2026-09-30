/**
 * POST /api/l3/translate-text 与 POST /api/l3/contexts/:id/translate —— 划词即译的 HTTP 契约。
 *
 * ## 为什么要这个文件
 *
 * 本 PR 之前只有 service 层测试（`tests/services/translation.service.test.ts`、
 * `tests/services/l3-context-translation.test.ts`），**HTTP 层一条都没有** ——
 * 于是 `src/http/routes/l3/translate.ts` 的两条 handler 主体 22 行、加上
 * `setContextTranslation` 的 UPDATE 语句，全部零覆盖，把 layered-coverage 的
 * 增量门禁压到 66.13%（门槛 85%）。
 *
 * 路由 handler 正是「用户实际打到的第一层」：参数怎么解析、非法 id 返什么、
 * body 校验失败怎么报、译文怎么落库 —— 这些 service 测试一概碰不到。
 *
 * 本套件钉四件事：
 * 1) 授权语义：两个端点在 operations.ts 登记为 `minRole: "owner"` —— agent
 *    token 必须 403。这条是从注册表读出来的事实，不是设计意图的猜测：
 *    `/contexts/:id/translate` 会写 `l3_contexts.translation`（真写操作），
 *    `/translate-text` 虽零写入但与前者同属一组、且带语境路径需要 RLS 身份，
 *    故一并按 owner 收口。若将来放开 agent，两条断言会红——那是刻意提醒。
 * 2) 校验语义：非法 uuid / 空 body / 超长文本各自的错误码与形状
 * 3) 透传语义：body 里的 targetLang / sourceLang / refresh 真的传到了 service
 * 4) 失败语义：provider 全挂仍返 200 + warning（翻译是增强不是前提）
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";

const ORIGINAL = {
  owner: process.env.OWNER_API_TOKEN,
  agents: process.env.AGENT_API_TOKENS,
  localOwner: process.env.LOCAL_OWNER_ID,
};

const AGENT_TOKEN = "agent-translate-probe-secret";
const OWNER_TOKEN = "owner-translate-probe";
const VALID_UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

beforeAll(() => {
  process.env.OWNER_API_TOKEN = OWNER_TOKEN;
  process.env.AGENT_API_TOKENS = `translate-agent:${AGENT_TOKEN}`;
  process.env.LOCAL_OWNER_ID = "user-123";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL.owner;
  process.env.AGENT_API_TOKENS = ORIGINAL.agents;
  process.env.LOCAL_OWNER_ID = ORIGINAL.localOwner;
});

interface ServiceStubs {
  translation: { translateText: ReturnType<typeof vi.fn> };
  l3Context: { translateContext: ReturnType<typeof vi.fn> };
}

// 响应字段与 l3-response-contract.ts 的两个 schema 同形：
//   l3TextTranslateResponseSchema    = { text, translation, provider, cached, warning? }
//   l3ContextTranslateResponseSchema = { contextId, ...上面同形 }
const stubs: ServiceStubs = {
  translation: {
    translateText: vi.fn(async () => ({
      text: "hello",
      translation: "你好",
      provider: "google-web",
      cached: false,
    })),
  },
  l3Context: {
    translateContext: vi.fn(async () => ({
      contextId: VALID_UUID,
      text: "hello",
      translation: "你好",
      provider: "google-web",
      cached: false,
    })),
  },
};

const app = createApp({
  translation: stubs.translation,
  l3Context: stubs.l3Context,
} as unknown as Services);

function postText(body: unknown, token = OWNER_TOKEN): Promise<Response> {
  return app.request("/api/l3/translate-text", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function postContext(id: string, body: unknown = {}, token = OWNER_TOKEN): Promise<Response> {
  return app.request(`/api/l3/contexts/${id}/translate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  vi.clearAllMocks();
});

describe("POST /api/l3/translate-text（无状态划词即译）", () => {
  it("把 text/targetLang/sourceLang 透传给 service 并回 200", async () => {
    const res = await postText({ text: "hello", targetLang: "zh", sourceLang: "en" }, OWNER_TOKEN);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.translation).toBe("你好");
    expect(body.provider).toBe("google-web");
    expect(stubs.translation.translateText).toHaveBeenCalledWith({
      userId: expect.any(String),
      text: "hello",
      targetLang: "zh",
      sourceLang: "en",
    });
  });

  // operations.ts: translateL3Text.minRole === "owner"
  it("agent token 返 403（注册表登记为 owner-only）", async () => {
    stubs.translation.translateText.mockClear();
    const res = await postText({ text: "hello" }, AGENT_TOKEN);
    expect(res.status).toBe(403);
    expect(stubs.translation.translateText).not.toHaveBeenCalled();
  });

  it("无 Authorization 头时 401", async () => {
    const res = await app.request("/api/l3/translate-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(401);
  });

  // 缺 text → validationError 返 400（实测口径，不是 422）。
  // body 解析异常时 c.req.json().catch(() => ({})) 兜成空对象，于是走 schema
  // 校验而不是 500 —— 这条钉的是「坏 body 不该崩服务」。
  it("body 缺 text 时返 400 校验错误而非 500", async () => {
    const res = await postText({});
    expect(res.status).toBe(400);
    // 错误体是平铺的（error-response.ts:23）：code 与 error/message 同级，
    // 不嵌在 error 对象里。
    const body = (await res.json()) as {
      error?: string;
      code?: string;
      details?: { fieldErrors?: Record<string, string[]> };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error).toBe("Invalid request");
    expect(Object.keys(body.details?.fieldErrors ?? {})).toContain("text");
  });

  it("text 为空串时返 400", async () => {
    const res = await postText({ text: "" });
    expect(res.status).toBe(400);
  });

  it("body 不是合法 JSON 时返 400（json().catch 兜底成 {} 走 schema）", async () => {
    const res = await postText("{not-json");
    expect(res.status).toBe(400);
  });

  it("targetLang 缺省时 service 收到 undefined 而非空串", async () => {
    stubs.translation.translateText.mockClear();
    await postText({ text: "hello" });
    const arg = stubs.translation.translateText.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.targetLang).toBeUndefined();
    expect(arg.sourceLang).toBeUndefined();
  });
});

describe("POST /api/l3/contexts/:id/translate（带语境，译文落库）", () => {
  // operations.ts: translateL3Context.minRole === "owner" + csrf=sessionMutation
  it("agent token 返 403（注册表登记为 owner-only）", async () => {
    stubs.l3Context.translateContext.mockClear();
    const res = await postContext(VALID_UUID, {}, AGENT_TOKEN);
    expect(res.status).toBe(403);
    expect(stubs.l3Context.translateContext).not.toHaveBeenCalled();
  });

  it("合法 uuid 时透传 contextId/targetLang/refresh 并回 200", async () => {
    const res = await postContext(VALID_UUID, { targetLang: "zh", refresh: true });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.contextId).toBe(VALID_UUID);
    expect(body.translation).toBe("你好");
    expect(stubs.l3Context.translateContext).toHaveBeenCalledWith({
      userId: expect.any(String),
      contextId: VALID_UUID,
      targetLang: "zh",
      refresh: true,
    });
  });

  // parseRouteUuid 失败 → invalidIdResponse，不进 service
  it("非法 uuid 时返 400 且不调 service", async () => {
    stubs.l3Context.translateContext.mockClear();
    const res = await postContext("not-a-uuid");

    expect(res.status).toBe(400);
    expect(stubs.l3Context.translateContext).not.toHaveBeenCalled();
  });

  it("body 缺省字段时 targetLang=undefined / refresh=false", async () => {
    stubs.l3Context.translateContext.mockClear();
    await postContext(VALID_UUID, {});
    const arg = stubs.l3Context.translateContext.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.targetLang).toBeUndefined();
    expect(arg.refresh).toBe(false);
  });

  it("body 为坏 JSON 时按空 body 处理，仍按默认值透传", async () => {
    stubs.l3Context.translateContext.mockClear();
    const res = await app.request(`/api/l3/contexts/${VALID_UUID}/translate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OWNER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: "{broken",
    });
    expect(res.status).toBe(200);
    const arg = stubs.l3Context.translateContext.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.refresh).toBe(false);
  });

  // 失败语义契约：provider 全挂仍返 200 + warning + 空译文。
  // 翻译是增强不是前提，不能让阅读视图因翻译失败而崩。
  it("service 返 warning 时仍回 200（翻译失败不阻断阅读）", async () => {
    stubs.l3Context.translateContext.mockResolvedValueOnce({
      contextId: VALID_UUID,
      text: "hello",
      translation: "",
      provider: "",
      cached: false,
      warning: "all providers failed",
    } as never);

    const res = await postContext(VALID_UUID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.warning).toBe("all providers failed");
    expect(body.translation).toBe("");
  });
});
