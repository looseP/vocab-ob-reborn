/**
 * 学习笔记分页游标单元测试：编码往返、过滤指纹确定性、
 * 非法输入（超长/坏 JSON/坏字段）→ ValidationError(cursor)。
 */
import { describe, expect, it } from "vitest";
import {
  decodeStudyCursor,
  encodeStudyCursor,
  studyFilterFingerprint,
  type StudyCursor,
} from "@/repositories/l3-study-cursor";
import { ValidationError } from "@/errors";

const CURSOR: StudyCursor = {
  sortKind: "updatedAt",
  lastSort: "2026-09-19T00:00:00.000Z",
  id: "00000000-0000-4000-8000-000000000101",
  filter: "0123456789abcdef",
};

describe("encode/decode roundtrip", () => {
  it("时间列表游标往返一致", () => {
    expect(decodeStudyCursor(encodeStudyCursor(CURSOR))).toEqual(CURSOR);
  });

  it("专题 position 游标往返一致（lastSort 为整数字符串）", () => {
    const cursor: StudyCursor = { ...CURSOR, sortKind: "position", lastSort: "5" };
    expect(decodeStudyCursor(encodeStudyCursor(cursor))).toEqual(cursor);
  });

  it("空值返回 null（首页）", () => {
    expect(decodeStudyCursor(null)).toBeNull();
    expect(decodeStudyCursor(undefined)).toBeNull();
    expect(decodeStudyCursor("")).toBeNull();
  });
});

describe("非法输入 → ValidationError(cursor)", () => {
  const cases: [string, string][] = [
    ["非 base64 的乱码", "!!!!not-json!!!",],
    ["sortKind 未知", encodeStudyCursor({ ...CURSOR, sortKind: "bad" as never })],
    ["id 非 uuid", encodeStudyCursor({ ...CURSOR, id: "abc" })],
    ["filter 非 16 hex", encodeStudyCursor({ ...CURSOR, filter: "xyz" })],
    ["updatedAt 的 lastSort 非时间", encodeStudyCursor({ ...CURSOR, lastSort: "not-a-date" })],
    ["position 的 lastSort 非整数", encodeStudyCursor({ ...CURSOR, sortKind: "position", lastSort: "1.5" })],
    ["超长载荷", "A".repeat(801)],
  ];
  for (const [label, raw] of cases) {
    it(label, () => {
      expect(() => decodeStudyCursor(raw)).toThrow(ValidationError);
    });
  }
});

describe("studyFilterFingerprint", () => {
  it("同过滤条件指纹一致；条件不同（topic 或 q 变）指纹不同", () => {
    const a = studyFilterFingerprint(["reading_choice", "active", null, null, false, null]);
    const same = studyFilterFingerprint(["reading_choice", "active", null, null, false, null]);
    const diffTopic = studyFilterFingerprint(["reading_choice", "active", null, "topic-1", false, null]);
    const diffQ = studyFilterFingerprint(["reading_choice", "active", null, null, false, "fox"]);
    expect(a).toBe(same);
    expect(a).not.toBe(diffTopic);
    expect(a).not.toBe(diffQ);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
