/**
 * 学习笔记分页游标（N1）——base64url(JSON{sortKind,lastSort,id,filter})。
 *
 * 与 l3-cursor.ts 的 (createdAt,id) 单族语义不同：本域两种排序
 * （时间列表 updatedAt DESC / 专题成员列表 position ASC）共用一族游标，
 * 且携带**过滤指纹**防止跨过滤/跨专题复用（设计 §7：不能将 A 专题的 cursor
 * 用于 B 专题）。任何格式/长度异常一律抛 ValidationError(field=cursor)。
 *
 * F4：新增 createdAt 族（引用目标搜索。设计 §7「source/question 采用
 * createdAt/id」）——同样携带过滤指纹（绑定目标搜索族/kind/规范化 q/有效
 * venue）；旧的、不绑定条件的 l3-cursor 格式不被本族接受。
 */

import { createHash } from "node:crypto";
import { ValidationError } from "../errors";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILTER_RE = /^[0-9a-f]{16}$/;
const MAX_CURSOR_LENGTH = 800;

export type StudyCursorSortKind = "updatedAt" | "position" | "createdAt";

export interface StudyCursor {
  sortKind: StudyCursorSortKind;
  /** 排序键的字符串形态：updatedAt/createdAt 为 ISO 时间；position 为整数字符串。 */
  lastSort: string;
  id: string;
  /** 过滤指纹（studyFilterFingerprint 产物）：绑定 venue/status/pinned/topic/ unfiled/q 或目标搜索条件。 */
  filter: string;
}

/** 过滤指纹：对规范序的过滤条件数组做 SHA256 截断（确定性、可比对）。 */
export function studyFilterFingerprint(
  parts: readonly (string | number | boolean | null)[],
): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export function encodeStudyCursor(cursor: StudyCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * 解码并校验游标：
 * - 超长/坏 JSON/坏字段（sortKind、id、lastSort 按 sortKind 语义、filter）→ 400；
 * - 空值返回 null（首页）。
 */
export function decodeStudyCursor(raw: string | null | undefined): StudyCursor | null {
  if (!raw) return null;
  if (raw.length > MAX_CURSOR_LENGTH) {
    throw new ValidationError("Invalid pagination cursor", "cursor");
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<StudyCursor>;
    const sortKindOk =
      parsed.sortKind === "updatedAt"
      || parsed.sortKind === "position"
      || parsed.sortKind === "createdAt";
    const idOk = typeof parsed.id === "string" && UUID_RE.test(parsed.id);
    const filterOk = typeof parsed.filter === "string" && FILTER_RE.test(parsed.filter);
    const lastSortOk =
      typeof parsed.lastSort === "string" &&
      parsed.lastSort.length > 0 &&
      parsed.lastSort.length <= 64;
    const lastSortValid =
      sortKindOk &&
      lastSortOk &&
      (parsed.sortKind === "position"
        ? /^\d+$/.test(parsed.lastSort as string)
        : !Number.isNaN(Date.parse(parsed.lastSort as string)));
    if (sortKindOk && idOk && filterOk && lastSortValid) {
      return parsed as StudyCursor;
    }
  } catch {
    // 落入统一错误出口（不泄露解析细节）
  }
  throw new ValidationError("Invalid pagination cursor", "cursor");
}
