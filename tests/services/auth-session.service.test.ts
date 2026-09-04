import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { AuthSessionService } from "@/services/auth-session.service";
import type { AuthSessionRecord, AuthSessionRepository } from "@/repositories/auth-session.repository";

const originalOwnerToken = process.env.OWNER_API_TOKEN;
const originalOwnerId = process.env.LOCAL_OWNER_ID;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function session(overrides: Partial<AuthSessionRecord> = {}): AuthSessionRecord {
  return {
    id: "session-1",
    user_id: "owner-1",
    role: "owner",
    token_hash: "stored-token-hash",
    csrf_hash: "stored-csrf-hash",
    expires_at: "2026-07-12T12:00:00.000Z",
    revoked_at: null,
    ...overrides,
  };
}

function repository(overrides: Partial<AuthSessionRepository> = {}): AuthSessionRepository {
  return {
    create: vi.fn(async (input) => session({
      user_id: input.userId,
      role: input.role,
      token_hash: input.tokenHash,
      csrf_hash: input.csrfHash,
      expires_at: input.expiresAt,
    })),
    findActiveByTokenHash: vi.fn(async () => null),
    revokeByTokenHash: vi.fn(async () => false),
    deleteExpiredOrRevoked: vi.fn(async () => 0),
    ...overrides,
  } as AuthSessionRepository;
}

afterEach(() => {
  if (originalOwnerToken === undefined) delete process.env.OWNER_API_TOKEN;
  else process.env.OWNER_API_TOKEN = originalOwnerToken;
  if (originalOwnerId === undefined) delete process.env.LOCAL_OWNER_ID;
  else process.env.LOCAL_OWNER_ID = originalOwnerId;
  vi.restoreAllMocks();
});

describe("AuthSessionService", () => {
  it("exchanges a valid owner token and persists only hashes", async () => {
    process.env.OWNER_API_TOKEN = "owner-secret";
    process.env.LOCAL_OWNER_ID = "owner-1";
    const repo = repository();
    const service = new AuthSessionService(repo, 60);
    const before = Date.now();

    const result = await service.exchangeOwnerToken("owner-secret");

    expect(result?.principal).toEqual({
      actorId: "owner-1",
      role: "owner",
      authMethod: "session",
      sessionId: "session-1",
    });
    expect(result?.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result?.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(result!.expiresAt)).toBeGreaterThanOrEqual(before + 59_000);
    const input = vi.mocked(repo.create).mock.calls[0][0];
    expect(input.tokenHash).toBe(hash(result!.sessionToken));
    expect(input.csrfHash).toBe(hash(result!.csrfToken));
    expect(JSON.stringify(input)).not.toContain("owner-secret");
  });

  it.each([
    [undefined, "owner-1", "owner-secret"],
    ["owner-secret", undefined, "owner-secret"],
    ["owner-secret", "owner-1", "short"],
    ["owner-secret", "owner-1", "wrong-secret"],
  ])("rejects missing or invalid owner credentials", async (configured, actorId, provided) => {
    if (configured === undefined) delete process.env.OWNER_API_TOKEN;
    else process.env.OWNER_API_TOKEN = configured;
    if (actorId === undefined) delete process.env.LOCAL_OWNER_ID;
    else process.env.LOCAL_OWNER_ID = actorId;
    const repo = repository();

    expect(await new AuthSessionService(repo).exchangeOwnerToken(provided)).toBeNull();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("authenticates only active hashed sessions", async () => {
    const repo = repository();
    const service = new AuthSessionService(repo);
    expect(await service.authenticate(undefined)).toBeNull();
    expect(repo.findActiveByTokenHash).not.toHaveBeenCalled();

    expect(await service.authenticate("missing")).toBeNull();
    expect(repo.findActiveByTokenHash).toHaveBeenLastCalledWith(hash("missing"));

    vi.mocked(repo.findActiveByTokenHash).mockResolvedValueOnce(session());
    expect(await service.authenticate("valid")).toEqual({
      principal: { actorId: "owner-1", role: "owner", authMethod: "session", sessionId: "session-1" },
      csrfHash: "stored-csrf-hash",
    });
  });

  it("verifies CSRF tokens without accepting absent or mismatched values", () => {
    const service = new AuthSessionService(repository());
    const expected = hash("csrf-token");
    expect(service.verifyCsrf(undefined, expected)).toBe(false);
    expect(service.verifyCsrf("csrf-token", expected)).toBe(true);
    expect(service.verifyCsrf("wrong-token", expected)).toBe(false);
    expect(service.verifyCsrf("csrf-token", "short")).toBe(false);
  });

  it("revokes by token hash and rejects an absent token", async () => {
    const repo = repository({ revokeByTokenHash: vi.fn(async () => true) });
    const service = new AuthSessionService(repo);
    expect(await service.revoke(undefined)).toBe(false);
    expect(repo.revokeByTokenHash).not.toHaveBeenCalled();
    expect(await service.revoke("session-token")).toBe(true);
    expect(repo.revokeByTokenHash).toHaveBeenCalledWith(hash("session-token"));
  });
});
