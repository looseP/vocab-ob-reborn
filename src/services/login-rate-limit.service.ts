import { createHash } from "node:crypto";
import type { LoginRateLimitRepositoryPort } from "../repositories/login-rate-limit.repository";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_ATTEMPT_LIMIT = 8;

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export class LoginRateLimitService {
  constructor(
    private readonly repository: LoginRateLimitRepositoryPort,
    private readonly options: {
      windowMs?: number;
      attemptLimit?: number;
    } = {},
  ) {}

  async consume(clientKey: string): Promise<number | null> {
    const windowMs = boundedInteger("LOGIN_RATE_LIMIT_WINDOW_MS", this.options.windowMs ?? DEFAULT_WINDOW_MS, 1_000, 3_600_000);
    const attemptLimit = boundedInteger("LOGIN_RATE_LIMIT_ATTEMPTS", this.options.attemptLimit ?? DEFAULT_ATTEMPT_LIMIT, 1, 1_000);
    const result = await this.repository.consume({
      keyHash: this.hash(clientKey),
      windowMs,
    });
    if (result.attempts <= attemptLimit) return null;
    return result.retryAfterSeconds;
  }

  async clear(clientKey: string): Promise<void> {
    await this.repository.clear(this.hash(clientKey));
  }

  private hash(clientKey: string): string {
    return createHash("sha256").update(clientKey, "utf8").digest("hex");
  }
}
