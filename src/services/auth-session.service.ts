import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthSessionRepository, AuthSessionRecord } from "../repositories/auth-session.repository";

export type BrowserPrincipal = {
  actorId: string;
  role: "owner" | "agent";
  authMethod: "session";
  sessionId: string;
};

export type BrowserSessionIssue = {
  principal: BrowserPrincipal;
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
};

const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class AuthSessionService {
  constructor(
    private readonly repository: AuthSessionRepository,
    private readonly ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  ) {}

  async exchangeOwnerToken(ownerToken: string): Promise<BrowserSessionIssue | null> {
    const configuredToken = process.env.OWNER_API_TOKEN;
    const actorId = process.env.LOCAL_OWNER_ID;
    if (!configuredToken || !actorId || !constantTimeEqual(ownerToken, configuredToken)) return null;

    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000).toISOString();
    const session = await this.repository.create({
      userId: actorId,
      role: "owner",
      tokenHash: sha256(sessionToken),
      csrfHash: sha256(csrfToken),
      expiresAt,
    });

    return {
      principal: this.toPrincipal(session),
      sessionToken,
      csrfToken,
      expiresAt,
    };
  }

  async authenticate(sessionToken: string | undefined): Promise<{ principal: BrowserPrincipal; csrfHash: string } | null> {
    if (!sessionToken) return null;
    const session = await this.repository.findActiveByTokenHash(sha256(sessionToken));
    if (!session) return null;
    return { principal: this.toPrincipal(session), csrfHash: session.csrf_hash };
  }

  verifyCsrf(csrfToken: string | undefined, expectedHash: string): boolean {
    if (!csrfToken) return false;
    return constantTimeEqual(sha256(csrfToken), expectedHash);
  }

  async revoke(sessionToken: string | undefined): Promise<boolean> {
    if (!sessionToken) return false;
    return this.repository.revokeByTokenHash(sha256(sessionToken));
  }

  private toPrincipal(session: AuthSessionRecord): BrowserPrincipal {
    return {
      actorId: session.user_id,
      role: session.role,
      authMethod: "session",
      sessionId: session.id,
    };
  }
}
