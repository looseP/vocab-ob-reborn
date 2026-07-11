import { describe, expect, it, vi } from "vitest";
import { LoginRateLimitService } from "@/services/login-rate-limit.service";
import type { LoginRateLimitRepositoryPort } from "@/repositories/login-rate-limit.repository";

describe("LoginRateLimitService", () => {
  it("hashes the client key before storage and reports fixed-window retry time", async () => {
    const consume = vi.fn<LoginRateLimitRepositoryPort["consume"]>(async () => ({ attempts: 9, retryAfterSeconds: 15 }));
    const repository: LoginRateLimitRepositoryPort = { consume, clear: vi.fn(async () => undefined) };
    const service = new LoginRateLimitService(repository);

    await expect(service.consume("203.0.113.42")).resolves.toBe(15);
    const stored = consume.mock.calls[0]?.[0];
    expect(stored.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.keyHash).not.toContain("203.0.113.42");
    expect(stored.windowMs).toBe(60_000);
  });

  it("clears by the same SHA-256 key", async () => {
    const clear = vi.fn<LoginRateLimitRepositoryPort["clear"]>(async () => undefined);
    const repository: LoginRateLimitRepositoryPort = {
      consume: vi.fn(async () => ({ attempts: 1, retryAfterSeconds: 60 })),
      clear,
    };
    const service = new LoginRateLimitService(repository);

    await service.clear("direct-client");
    expect(clear).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(clear.mock.calls[0]?.[0]).not.toContain("direct-client");
  });
});
