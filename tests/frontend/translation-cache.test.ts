// @vitest-environment jsdom

/**
 * 划词译文缓存（2026-09-29）。
 *
 * ## 这些不变量为什么重要
 *
 * 缓存的定位是「不写数据库、但别反复打已经消失的免费端点」。因此：
 *
 * 1. **目标语言必须进键** —— 同一句译成中/日是两条，混了会串。
 * 2. **源语言不进键** —— provider 的语种猜测是内部实现，同一句两次猜不同源语言
 *    但译文应当等价；进键只会降低命中率。
 * 3. **坏数据不能炸** —— 手工改坏、跨版本结构变化都必须退化成「未命中」。
 * 4. **存储不可用必须静默降级** —— 隐私模式/配额满会让 localStorage 抛错；
 *    缓存是优化，拿不到就该每次请求，绝不能让划词翻译整个不可用。
 * 5. **超限要淘汰** —— 译文是不可变事实，不需要 TTL，只需要条数上限。
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  readCachedTranslation,
  writeCachedTranslation,
  clearOne,
  clearTranslationCache,
  countTranslationCache,
  MAX_ENTRIES,
} from "@/frontend/utils/translationCache";

const KEY_PREFIX = "vocab.tr.v1.";

function countKeys(): number {
  let n = 0;
  for (let i = 0; i < window.localStorage.length; i += 1) {
    if (window.localStorage.key(i)?.startsWith(KEY_PREFIX)) n += 1;
  }
  return n;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("读缓存 · 命中与隔离", () => {
  it("写入后能读回译文与 provider", () => {
    writeCachedTranslation("The court ruled.", "zh-CN", { translation: "法院裁定。", provider: "google-web" });
    expect(readCachedTranslation("The court ruled.", "zh-CN")).toEqual({
      translation: "法院裁定。",
      provider: "google-web",
    });
  });

  it("目标语言进键：同句不同语言互不串味", () => {
    writeCachedTranslation("hello", "zh-CN", { translation: "你好", provider: "google-web" });
    writeCachedTranslation("hello", "ja", { translation: "こんにちは", provider: "google-web" });
    expect(readCachedTranslation("hello", "zh-CN")?.translation).toBe("你好");
    expect(readCachedTranslation("hello", "ja")?.translation).toBe("こんにちは");
  });

  it("源语言不进键：换个源语言仍命中同一译文", () => {
    writeCachedTranslation("hello", "zh-CN", { translation: "你好", provider: "google-web" });
    // 键只看 文本 + 目标语言，所以「源语言不同」不产生第二条记录
    expect(readCachedTranslation("hello", "zh-CN")).not.toBeNull();
    expect(countKeys()).toBe(1);
  });

  it("不同文本不共用键", () => {
    writeCachedTranslation("alpha", "zh-CN", { translation: "甲", provider: "p" });
    writeCachedTranslation("beta", "zh-CN", { translation: "乙", provider: "p" });
    expect(readCachedTranslation("alpha", "zh-CN")?.translation).toBe("甲");
    expect(readCachedTranslation("beta", "zh-CN")?.translation).toBe("乙");
  });

  it("未写入时返回 null（不是空对象）", () => {
    expect(readCachedTranslation("never seen", "zh-CN")).toBeNull();
  });
});

describe("坏数据不炸", () => {
  /** 覆盖某条缓存的落盘内容（模拟手工改坏 / 跨版本结构变化）。 */
  function corruptAll(raw: string): void {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(KEY_PREFIX)) window.localStorage.setItem(key, raw);
    }
  }

  it("非 JSON → 当未命中，并清掉坏条目", () => {
    writeCachedTranslation("broken", "zh-CN", { translation: "x", provider: "p" });
    corruptAll("{not json");
    expect(readCachedTranslation("broken", "zh-CN")).toBeNull();
    expect(countKeys()).toBe(0);
  });

  it("译文非字符串 → 当未命中", () => {
    writeCachedTranslation("bad-type", "zh-CN", { translation: "x", provider: "p" });
    corruptAll(JSON.stringify({ t: 42, p: "p", s: 1 }));
    expect(readCachedTranslation("bad-type", "zh-CN")).toBeNull();
  });

  it("译文凭空 → 当未命中（空串是「翻译失败」的落盘，绝不能当成有效译文）", () => {
    writeCachedTranslation("empty", "zh-CN", { translation: "x", provider: "p" });
    corruptAll(JSON.stringify({ t: "", p: "p", s: 1 }));
    expect(readCachedTranslation("empty", "zh-CN")).toBeNull();
  });

  it("provider 字段缺失时补默认值，不让整条作废", () => {
    writeCachedTranslation("no-provider", "zh-CN", { translation: "译文", provider: "p" });
    corruptAll(JSON.stringify({ t: "译文", s: 1 }));
    expect(readCachedTranslation("no-provider", "zh-CN")).toEqual({ translation: "译文", provider: "unknown" });
  });
});

describe("存储不可用 → 静默降级", () => {
  it("localStorage 抛错时读返回 null、写不抛", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeCachedTranslation("x", "zh-CN", { translation: "y", provider: "p" })).not.toThrow();
    expect(readCachedTranslation("x", "zh-CN")).toBeNull();
  });

  it("getItem 抛错时读返回 null（不冒泡到界面）", () => {
    writeCachedTranslation("x", "zh-CN", { translation: "y", provider: "p" });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readCachedTranslation("x", "zh-CN")).toBeNull();
  });
});

describe("淘汰与清理", () => {
  it("超过上限时淘汰最旧的条目，总数收敛到上限", () => {
    // 只灌到上限+10，验证收敛（灌 500+ 条会让单测明显变慢，故按上限语义等比验证）
    const overflow = 10;
    for (let i = 0; i < MAX_ENTRIES + overflow; i += 1) {
      writeCachedTranslation(`sentence number ${i}`, "zh-CN", { translation: `t${i}`, provider: "p" });
    }
    expect(countKeys()).toBe(MAX_ENTRIES);
    // 最旧的（i=0）被淘汰，最新的仍在
    expect(readCachedTranslation("sentence number 0", "zh-CN")).toBeNull();
    expect(readCachedTranslation(`sentence number ${MAX_ENTRIES + overflow - 1}`, "zh-CN")?.translation)
      .toBe(`t${MAX_ENTRIES + overflow - 1}`);
  });

  it("clearOne 只删指定条目", () => {
    writeCachedTranslation("a", "zh-CN", { translation: "甲", provider: "p" });
    writeCachedTranslation("b", "zh-CN", { translation: "乙", provider: "p" });
    clearOne("a", "zh-CN");
    expect(readCachedTranslation("a", "zh-CN")).toBeNull();
    expect(readCachedTranslation("b", "zh-CN")).not.toBeNull();
  });

  it("clearOne 只影响对应目标语言（重新翻译日文不清中文缓存）", () => {
    writeCachedTranslation("a", "zh-CN", { translation: "甲", provider: "p" });
    writeCachedTranslation("a", "ja", { translation: "あ", provider: "p" });
    clearOne("a", "ja");
    expect(readCachedTranslation("a", "ja")).toBeNull();
    expect(readCachedTranslation("a", "zh-CN")).not.toBeNull();
  });

  it("clearTranslationCache 清掉全部且返回条数，不碰无关键", () => {
    writeCachedTranslation("a", "zh-CN", { translation: "甲", provider: "p" });
    writeCachedTranslation("b", "ja", { translation: "い", provider: "p" });
    window.localStorage.setItem("unrelated.key", "keep me");
    expect(clearTranslationCache()).toBe(2);
    expect(countTranslationCache()).toBe(0);
    expect(window.localStorage.getItem("unrelated.key")).toBe("keep me");
  });

  it("淘汰序号计数器不算作译文条目（否则会挤掉一条真译文）", () => {
    writeCachedTranslation("a", "zh-CN", { translation: "甲", provider: "p" });
    // 计数器键刻意不在 KEY_PREFIX 下：它若被计入条数，MAX_ENTRIES 就会少存一条真译文
    expect(countTranslationCache()).toBe(1);
  });

  it("清空后计数器归零，新条目序号从头开始（否则淘汰方向会反）", () => {
    for (let i = 0; i < 5; i += 1) {
      writeCachedTranslation(`old ${i}`, "zh-CN", { translation: "旧", provider: "p" });
    }
    clearTranslationCache();
    writeCachedTranslation("fresh", "zh-CN", { translation: "新", provider: "p" });
    expect(readCachedTranslation("fresh", "zh-CN")?.translation).toBe("新");
  });
});
