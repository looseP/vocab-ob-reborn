/**
 * L3 分页游标编解码（2026-09-08 自三个 L3 仓库的去重提取）。
 *
 * 约定：cursor = base64url(JSON{createdAt,id})；id 必须是合法 uuid、
 * createdAt 必须可解析——任何格式异常一律抛 ValidationError(field=cursor)。
 * 三个仓库（context/proposal/recommendation）的 (created_at, id) 双列游标
 * 排序语义一致，共用同一实现。
 */

import { ValidationError } from "../errors";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string" &&
      UUID_RE.test(parsed.id) &&
      !Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    throw new ValidationError("Invalid pagination cursor", "cursor");
  }
  throw new ValidationError("Invalid pagination cursor", "cursor");
}
