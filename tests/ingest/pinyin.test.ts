import { describe, expect, it } from "vitest";
import { computePinyinFromCjk } from "@/domain/ingest/pinyin";

describe("computePinyinFromCjk", () => {
  it("returns nulls for text without Chinese characters", () => {
    expect(computePinyinFromCjk("exist in large numbers")).toEqual({
      pinyin: null,
      pinyinInitial: null,
    });
    expect(computePinyinFromCjk(null, undefined, "")).toEqual({
      pinyin: null,
      pinyinInitial: null,
    });
  });

  it("computes full pinyin and initials from Chinese, ignoring punctuation and non-CJK chars", () => {
    expect(computePinyinFromCjk("勇气，胆量")).toEqual({
      pinyin: "yongqidanliang",
      pinyinInitial: "yqdl",
    });
  });

  it("concatenates multiple source fields and dedupes repeated characters before converting", () => {
    expect(computePinyinFromCjk("勇气", "1. 胆量", "courage")).toEqual({
      pinyin: "yongqidanliang",
      pinyinInitial: "yqdl",
    });
    // 重复汉字去重：short_definition 与 definition_md 常见重复
    expect(computePinyinFromCjk("加速", "1. 加速", "to speed up")).toEqual({
      pinyin: "jiasu",
      pinyinInitial: "js",
    });
  });
});
