/**
 * A1/I1：来源导航契约（writingNavigation origin）——先红后绿的规格测试。
 *
 * 覆盖：旧 URL 兼容；origin 往返；超长/未知字段/非法 UUID/外站值拒绝；
 * 换稿与对照保留 origin；同题不同来源返回不同位置；返回 URL 不携带写接口语义。
 */
import { describe, expect, it } from "vitest";
import {
  WRITING_ORIGIN_VERSION,
  buildWritingOriginReturnUrl,
  buildWritingUrl,
  decodeWritingOrigin,
  encodeWritingOrigin,
  parseWritingSearch,
  type WritingOrigin,
} from "@/frontend/viewModels/writingNavigation";

const TASK = "11111111-1111-4111-8111-111111111111";
const SHEET = "22222222-2222-4222-8222-222222222222";
const SHEET2 = "33333333-3333-4333-8333-333333333333";
const Q = "44444444-4444-4444-8444-444444444444";
const SRC = "55555555-5555-4555-8555-555555555555";
const PAPER = "66666666-6666-4666-8666-666666666666";
const SHEET_ORIGIN = "77777777-7777-4777-8777-777777777777";

const fileOriginKeyed: WritingOrigin = {
  v: 1,
  kind: "file",
  questionId: Q,
  questionType: "short_essay",
  fileKey: "translation:tag:2025-en2",
  sourceId: null,
  sheetId: null,
};
const fileOriginSourced: WritingOrigin = {
  v: 1,
  kind: "file",
  questionId: Q,
  questionType: "long_essay",
  fileKey: null,
  sourceId: SRC,
  sheetId: null,
};
const fileOriginBoth: WritingOrigin = {
  v: 1,
  kind: "file",
  questionId: Q,
  questionType: "short_essay",
  fileKey: "essay:tag:x",
  sourceId: SRC,
  sheetId: SHEET_ORIGIN,
};
const paperOrigin: WritingOrigin = {
  v: 1,
  kind: "paper",
  questionId: Q,
  questionType: "long_essay",
  paperId: PAPER,
  sheetId: null,
};

function roundtrip(origin: WritingOrigin): WritingOrigin | null {
  const encoded = encodeWritingOrigin(origin);
  if (encoded === null) return null;
  return decodeWritingOrigin(encoded);
}

describe("A1 · 旧 URL 兼容与解析扩展", () => {
  it("无 origin 的旧作文 URL 构造保持原样；解析给出 origin=null 且非非法", () => {
    const url = buildWritingUrl({ taskId: TASK, sheetId: SHEET });
    expect(url).toBe(`/l3?section=writing&writingTaskId=${TASK}&sheet=${SHEET}`);
    const parsed = parseWritingSearch(new URLSearchParams(url.split("?")[1]!));
    expect(parsed.origin).toBeNull();
    expect(parsed.originInvalid).toBe(false);
    expect(parsed.section).toBe("writing");
    expect(parsed.taskId).toBe(TASK);
    expect(parsed.sheetId).toBe(SHEET);
  });

  it("非法的 origin 参数不破坏其余参数解析，仅标记 originInvalid", () => {
    const parsed = parseWritingSearch(
      new URLSearchParams(`section=writing&writingTaskId=${TASK}&origin=not-valid-b64!!`),
    );
    expect(parsed.taskId).toBe(TASK);
    expect(parsed.origin).toBeNull();
    expect(parsed.originInvalid).toBe(true);
  });
});

describe("A1 · origin 序列化往返（version=1 判别联合）", () => {
  it("file（fileKey 型）往返一致", () => {
    expect(WRITING_ORIGIN_VERSION).toBe(1);
    expect(roundtrip(fileOriginKeyed)).toEqual(fileOriginKeyed);
  });

  it("file（sourceId 型）往返一致", () => {
    expect(roundtrip(fileOriginSourced)).toEqual(fileOriginSourced);
  });

  it("file（双携带 + 原 sheetId）往返一致", () => {
    expect(roundtrip(fileOriginBoth)).toEqual(fileOriginBoth);
  });

  it("paper（含原 sheetId）往返一致", () => {
    const origin: WritingOrigin = { ...paperOrigin, sheetId: SHEET_ORIGIN };
    expect(roundtrip(origin)).toEqual(origin);
  });

  it("随作文规范 URL 传递：build 携带 origin，parse 还原", () => {
    const url = buildWritingUrl({ taskId: TASK, sheetId: SHEET2, origin: fileOriginKeyed });
    expect(url).toContain("origin=");
    const parsed = parseWritingSearch(new URLSearchParams(url.split("?")[1]!));
    expect(parsed.origin).toEqual(fileOriginKeyed);
    expect(parsed.originInvalid).toBe(false);
  });

  it("换稿/对照保留来源：sheet 与 compareTo 变化不影响 origin", () => {
    const url = buildWritingUrl({
      taskId: TASK,
      sheetId: SHEET2,
      compareTo: SHEET,
      origin: fileOriginKeyed,
    });
    const parsed = parseWritingSearch(new URLSearchParams(url.split("?")[1]!));
    expect(parsed.sheetId).toBe(SHEET2);
    expect(parsed.compareTo).toBe(SHEET);
    expect(parsed.origin).toEqual(fileOriginKeyed);
  });
});

describe("A1 · 拒绝非法 origin（超长/字符/结构/UUID/外站）", () => {
  const b64 = (json: unknown): string =>
    Buffer.from(JSON.stringify(json), "utf8").toString("base64url");

  it("超长参数拒绝（> 1024）", () => {
    expect(decodeWritingOrigin("A".repeat(2000))).toBeNull();
  });

  it("非 base64url 字符与 URL/脚本外站值拒绝", () => {
    for (const raw of [
      "http://evil.com/return",
      "https://x.example/?a=1",
      "javascript:alert(1)",
      "//evil.example",
      "abc:def",
      "../../etc/passwd",
      "<script>x</script>",
    ]) {
      expect(decodeWritingOrigin(raw)).toBeNull();
    }
  });

  it("可解码但不是对象/JSON 拒绝", () => {
    expect(decodeWritingOrigin(Buffer.from("not json", "utf8").toString("base64url"))).toBeNull();
    expect(decodeWritingOrigin(Buffer.from("12345", "utf8").toString("base64url"))).toBeNull();
  });

  it("未知字段拒绝（strict）", () => {
    const withExtra = { v: 1, k: "file", q: Q, t: "short_essay", s: SRC, extra: true };
    expect(decodeWritingOrigin(b64(withExtra))).toBeNull();
  });

  it("版本、kind、题型、UUID、必需字段逐一拒绝", () => {
    expect(decodeWritingOrigin(b64({ v: 2, k: "file", q: Q, t: "short_essay", s: SRC }))).toBeNull();
    expect(decodeWritingOrigin(b64({ v: 1, k: "exam", q: Q, t: "short_essay", s: SRC }))).toBeNull();
    expect(decodeWritingOrigin(b64({ v: 1, k: "file", q: Q, t: "reading_choice", s: SRC }))).toBeNull();
    expect(decodeWritingOrigin(b64({ v: 1, k: "file", q: "not-a-uuid", t: "short_essay", s: SRC }))).toBeNull();
    expect(decodeWritingOrigin(b64({ v: 1, k: "file", q: Q, t: "short_essay", s: "nope" }))).toBeNull();
    expect(decodeWritingOrigin(b64({ v: 1, k: "file", q: Q, t: "short_essay" }))).toBeNull(); // file 需 f 或 s
    expect(decodeWritingOrigin(b64({ v: 1, k: "paper", q: Q, t: "long_essay" }))).toBeNull(); // paper 需 p
    expect(decodeWritingOrigin(b64({ v: 1, k: "file", q: Q, t: "short_essay", f: "x".repeat(300) }))).toBeNull();
  });

  it("编码侧：结构不完整返回 null，且 URL 不携带 origin 参数", () => {
    const broken = { ...fileOriginKeyed, fileKey: null } as WritingOrigin; // f/s 皆空
    expect(encodeWritingOrigin(broken)).toBeNull();
    const url = buildWritingUrl({ taskId: TASK, sheetId: SHEET, origin: broken });
    expect(url).not.toContain("origin=");
  });
});

describe("A1 · 返回原题 URL（按来源构建，禁用任意 returnUrl）", () => {
  it("fileKey 型：venue + file + question 锚点，无 sheet 时不带 resumeSheet", () => {
    const url = buildWritingOriginReturnUrl(fileOriginKeyed);
    const params = new URLSearchParams(url.split("?")[1]!);
    expect(url.startsWith("/l3?")).toBe(true);
    expect(params.get("venue")).toBe("short_essay");
    expect(params.get("file")).toBe("translation:tag:2025-en2");
    expect(params.get("question")).toBe(Q);
    expect(params.get("resumeSheet")).toBeNull();
    expect(params.get("writingTaskId")).toBeNull();
    expect(params.get("origin")).toBeNull();
  });

  it("sourceId 型：venue + source + question", () => {
    const params = new URLSearchParams(buildWritingOriginReturnUrl(fileOriginSourced).split("?")[1]!);
    expect(params.get("venue")).toBe("long_essay");
    expect(params.get("source")).toBe(SRC);
    expect(params.get("file")).toBeNull();
    expect(params.get("question")).toBe(Q);
  });

  it("携带原 sheet 时以 resumeSheet 表达（同题纸返回；不借 ?sheet= 只读语义）", () => {
    const params = new URLSearchParams(buildWritingOriginReturnUrl(fileOriginBoth).split("?")[1]!);
    expect(params.get("resumeSheet")).toBe(SHEET_ORIGIN);
    expect(params.get("sheet")).toBeNull();
  });

  it("paper 型：paper + question（+ resumeSheet）", () => {
    const origin: WritingOrigin = { ...paperOrigin, sheetId: SHEET_ORIGIN };
    const params = new URLSearchParams(buildWritingOriginReturnUrl(origin).split("?")[1]!);
    expect(params.get("paper")).toBe(PAPER);
    expect(params.get("question")).toBe(Q);
    expect(params.get("resumeSheet")).toBe(SHEET_ORIGIN);
    expect(params.get("venue")).toBeNull();
  });

  it("同题不同来源返回不同位置（多卷/多文件不混淆）", () => {
    const a = buildWritingOriginReturnUrl(fileOriginKeyed);
    const b = buildWritingOriginReturnUrl(fileOriginSourced);
    const c = buildWritingOriginReturnUrl(paperOrigin);
    const set = new Set([a, b, c]);
    expect(set.size).toBe(3);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
  });
});
