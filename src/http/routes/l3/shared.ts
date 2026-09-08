/**
 * L3 路由子模块共享助手（原 routes/l3.ts 内联助手，2026-09-08 拆分时上提）。
 * HTTP 保持薄层：解析 body/query、附加 auth userId、只调用 service。
 */
import type { Json } from "@/domain";
import { uuidSchema } from "@/schemas/http";
import { validationError } from "../../error-response";
import type { Context } from "hono";

export function asJson(value: unknown): Json {
  return value as Json;
}

export function parseRouteUuid(value: string): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** 路径参数 id 非 uuid 时的统一 400 响应。 */
export function invalidIdResponse(c: Context, field = "id") {
  return validationError(c, { fieldErrors: { [field]: ["Invalid uuid"] } });
}
