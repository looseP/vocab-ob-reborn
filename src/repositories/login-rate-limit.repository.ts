import { BaseRepository } from "./base";

export interface LoginRateLimitRepositoryPort {
  consume(input: {
    keyHash: string;
    windowMs: number;
  }): Promise<{ attempts: number; retryAfterSeconds: number }>;
  clear(keyHash: string): Promise<void>;
}

type LoginRateLimitRow = {
  attempts: number;
  retry_after_seconds: number;
};

export class LoginRateLimitRepository extends BaseRepository implements LoginRateLimitRepositoryPort {
  async consume(input: {
    keyHash: string;
    windowMs: number;
  }): Promise<{ attempts: number; retryAfterSeconds: number }> {
    const row = await this.queryOne<LoginRateLimitRow>(
      `WITH db_clock AS (
         SELECT clock_timestamp() AS now_at
       ), window_clock AS (
         SELECT now_at,
                to_timestamp(floor(extract(epoch FROM now_at) * 1000 / $2::double precision) * $2::double precision / 1000) AS window_started_at
         FROM db_clock
       ), cleanup_candidates AS (
         SELECT login_rate_limits.key_hash
         FROM login_rate_limits, window_clock
         WHERE window_expires_at < window_clock.now_at
           AND login_rate_limits.key_hash <> $1
         ORDER BY window_expires_at
         FOR UPDATE OF login_rate_limits SKIP LOCKED
         LIMIT 100
       ), cleanup AS (
         DELETE FROM login_rate_limits
         USING cleanup_candidates
         WHERE login_rate_limits.key_hash = cleanup_candidates.key_hash
       ), consumed AS (
         INSERT INTO login_rate_limits (key_hash, window_started_at, window_expires_at, attempts)
         SELECT $1, window_started_at, window_started_at + ($2::double precision * interval '1 millisecond'), 1
         FROM window_clock
         ON CONFLICT (key_hash) DO UPDATE
         SET window_started_at = CASE
               WHEN login_rate_limits.window_started_at < EXCLUDED.window_started_at
                 THEN EXCLUDED.window_started_at
               ELSE login_rate_limits.window_started_at
             END,
             window_expires_at = CASE
               WHEN login_rate_limits.window_started_at < EXCLUDED.window_started_at
                 THEN EXCLUDED.window_expires_at
               ELSE login_rate_limits.window_expires_at
             END,
             attempts = CASE
               WHEN login_rate_limits.window_started_at < EXCLUDED.window_started_at
                 THEN 1
               ELSE login_rate_limits.attempts + 1
             END
         RETURNING attempts, window_expires_at
       )
       SELECT consumed.attempts,
              greatest(1, ceil(extract(epoch FROM (consumed.window_expires_at - window_clock.now_at))))::int AS retry_after_seconds
       FROM consumed CROSS JOIN window_clock`,
      [input.keyHash, input.windowMs],
    );
    if (!row) throw new Error("Failed to consume login rate limit");
    return { attempts: row.attempts, retryAfterSeconds: row.retry_after_seconds };
  }

  async clear(keyHash: string): Promise<void> {
    await this.query("DELETE FROM login_rate_limits WHERE key_hash = $1", [keyHash]);
  }
}
