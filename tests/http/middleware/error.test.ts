import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { handleError } from "@/http/middleware/error";
import {
  NotFoundError,
  BusinessRuleError,
  ValidationError,
  AppError,
} from "@/errors";

describe("handleError middleware", () => {
  function makeApp(error: Error) {
    const app = new Hono();
    app.onError(handleError);
    app.get("/*", () => {
      throw error;
    });
    return app;
  }

  it("maps NotFoundError to 404", async () => {
    const app = makeApp(new NotFoundError("Word", "slug"));
    const res = await app.request("/test");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: string; message: string; requestId: string };
    expect(body.code).toBe("NOT_FOUND");
    expect(body.error).toContain("Word");
    expect(body).toMatchObject({ message: expect.stringContaining("Word"), requestId: expect.any(String) });
    expect(res.headers.get("X-Request-ID")).toBe(body.requestId);
  });

  it("maps BusinessRuleError to 422", async () => {
    const app = makeApp(new BusinessRuleError("Cannot do this"));
    const res = await app.request("/test");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string; message: string; requestId: string };
    expect(body.code).toBe("BUSINESS_RULE");
    expect(body.error).toBe("Cannot do this");
  });

  it("maps ValidationError to 422", async () => {
    const app = makeApp(new ValidationError("Invalid input", "field1"));
    const res = await app.request("/test");
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      code: string;
      details?: { field: string };
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error).toBe("Invalid input");
    expect(body.details?.field).toBe("field1");
  });

  it("maps unknown error to 500", async () => {
    const app = makeApp(new Error("Something broke"));
    const res = await app.request("/test");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string; message: string; requestId: string };
    expect(body.code).toBe("INTERNAL");
    // Should not leak internals
    expect(body.error).toBe("Internal server error");
  });

  it("preserves meta in AppError response", async () => {
    // NotFoundError sets meta = { resourceType, identifier }
    const app = makeApp(new NotFoundError("Word", "slug"));
    const res = await app.request("/test");
    const body = (await res.json()) as {
      error: string;
      code: string;
      details?: { resourceType: string; identifier: string };
    };
    expect(body.details?.resourceType).toBe("Word");
    expect(body.details?.identifier).toBe("slug");
  });
});
