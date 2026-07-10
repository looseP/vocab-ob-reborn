import { BaseRepository } from "./base";

export type AuthSessionRecord = {
  id: string;
  user_id: string;
  role: "owner" | "agent";
  token_hash: string;
  csrf_hash: string;
  expires_at: string;
  revoked_at: string | null;
};

export class AuthSessionRepository extends BaseRepository {
  async create(input: {
    userId: string;
    role: "owner" | "agent";
    tokenHash: string;
    csrfHash: string;
    expiresAt: string;
  }): Promise<AuthSessionRecord> {
    const row = await this.queryOne<AuthSessionRecord>(
      `INSERT INTO auth_sessions (user_id, role, token_hash, csrf_hash, expires_at)
       VALUES ($1::uuid, $2, $3, $4, $5::timestamptz)
       RETURNING id, user_id, role, token_hash, csrf_hash, expires_at, revoked_at`,
      [input.userId, input.role, input.tokenHash, input.csrfHash, input.expiresAt],
    );
    if (!row) throw new Error("Failed to create auth session");
    return row;
  }

  async findActiveByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
    return this.queryOne<AuthSessionRecord>(
      `SELECT id, user_id, role, token_hash, csrf_hash, expires_at, revoked_at
       FROM auth_sessions
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND expires_at > now()`,
      [tokenHash],
    );
  }

  async revokeByTokenHash(tokenHash: string): Promise<boolean> {
    const row = await this.queryOne<{ id: string }>(
      `UPDATE auth_sessions
       SET revoked_at = now(), updated_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL
       RETURNING id`,
      [tokenHash],
    );
    return row !== null;
  }

  async deleteExpiredOrRevoked(): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `DELETE FROM auth_sessions
       WHERE expires_at <= now() OR revoked_at IS NOT NULL
       RETURNING id`,
    );
    return rows.length;
  }
}
