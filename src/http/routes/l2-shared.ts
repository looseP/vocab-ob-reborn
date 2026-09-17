/**
 * l2 路由族共享请求解析器（l2.ts / l2-candidates.ts 共用）。
 *
 * 从路由文件拆出以保持路由薄（route-complexity 棘轮，参照 l3/shared.ts 先例）：
 * 本文件不含任何路由注册，纯 body / path 解析。
 *
 * ADR-0017 §2：direction 为固定三值（通用/考研/雅思），非法值 fail-closed。
 */
import { directionSchema, uuidSchema } from "@/schemas/http";
import type { Direction } from "@/domain";
import {
  L2_DRAFT_MAX_COUNT,
  L2_OPTION_STRING_MAX_LENGTH,
  L2_USER_INSTRUCTION_MAX_LENGTH,
} from "@/schemas/resource-budget";

/** body.direction → 合法方向；非法返回 null（缺省由调用方跳过）。 */
export function parseDirection(value: unknown): Direction | null {
  const parsed = directionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** path param → 合法 uuid；非法返回 null。 */
export function parseUuid(value: string): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** draft / external-prompt 的选项解析（含 direction 校验）。非法 → null（调用方 400）。 */
export function parseDraftOptions(body: Record<string, unknown>, includeSource: boolean): Record<string, unknown> | null {
  const options: Record<string, unknown> = includeSource
    ? { source: body.source ?? "manual" }
    : {};

  if (body.source !== undefined && (typeof body.source !== "string" || body.source.length > L2_OPTION_STRING_MAX_LENGTH)) {
    return null;
  }
  if (body.direction !== undefined) {
    const direction = parseDirection(body.direction);
    if (direction === null) return null;
    options.direction = direction;
  }
  if (body.styleProfileId !== undefined) {
    if (typeof body.styleProfileId !== "string" || body.styleProfileId.length === 0 || body.styleProfileId.length > L2_OPTION_STRING_MAX_LENGTH) {
      return null;
    }
    options.styleProfileId = body.styleProfileId;
  }
  if (body.count !== undefined) {
    if (!Number.isInteger(body.count) || (body.count as number) < 1 || (body.count as number) > L2_DRAFT_MAX_COUNT) {
      return null;
    }
    options.count = body.count;
  }
  if (body.userInstruction !== undefined) {
    if (typeof body.userInstruction !== "string" || body.userInstruction.length > L2_USER_INSTRUCTION_MAX_LENGTH) {
      return null;
    }
    options.userInstruction = body.userInstruction;
  }
  return options;
}
