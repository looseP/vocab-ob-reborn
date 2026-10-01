/**
 * 划词译文的浏览器端缓存（2026-09-29）。
 *
 * ## 为什么缓存放浏览器而不是数据库
 *
 * 用户明确说过「一扫一读的不用存」。而落库会带来一个具体的坏处：凭空造出
 * 一批没有 `source_id` 归属语境统计价值、没有 occurrence 的 `l3_contexts` 行
 * （划词选中的句子多半不是任何一篇文章里的固定语境），污染按语境做的读模型。
 *
 * 但**完全不缓存**也有代价：免费端点随时可能消失/限流，而「重读同一段」是
 * 高频动作（回看、翻页、刷新页面）。所以缓存放 localStorage：
 *
 * - 不进数据库 → 不污染数据模型、不需要迁移
 * - 换设备/清缓存就丢 → 符合「读完就走」的定位
 * - 重复读不打网络 → 省配额、避开端点抖动
 *
 * ## 键的设计
 *
 * `targetLang` 必须进键：同一句话译成中文和日文是两回事，混在一起会串。
 * 源语言**不进键** —— provider 的语种猜测是它的内部实现，同一句话两次调用
 * 可能猜出不同源语言，但译文应当等价；把它进键只会降低命中率。
 *
 * ## 淘汰
 *
 * FIFO + 条数上限。翻译结果是不可变事实（同一句话的译文不会过期），所以
 * 不需要 TTL —— 只需要在超出上限时丢掉最久没写的那些。
 *
 * **顺序靠自增序号，而不是靠 localStorage 的键序**（2026-09-29 修正）：
 * 键是 `前缀+语言+哈希`，按键排序得到的是哈希顺序，与写入先后无关 —— 早期
 * 版本正因为「先按插入序拿到键、再 sort」而淘汰了随机条目。序号存在**值**里，
 * 因此不依赖任何存储实现的迭代顺序保证；命中缓存时也会重写（`put` 总是写），
 * 所以实际效果接近 LRU。
 */

/** localStorage 里所有划词译文缓存条目共用的前缀。 */
const KEY_PREFIX = "vocab.tr.v1.";

/**
 * 淘汰序号计数器的键。**刻意不带 `KEY_PREFIX`** —— 否则它会被当成一条译文
 * 计入条数上限、被 `clearTranslationCache` 一起清掉（清掉后计数器归零，
 * 新条目的序号会小于旧条目，淘汰方向就反了）。
 */
const SEQ_KEY = "vocab.tr.seq";

/**
 * 条数上限。实测一段 3000 词的文章大约产生 150~250 个不重复选区；取 500
 * 意味着「读几篇文章的量」都留在缓存里，而 500 条 × 平均 200 字节 ≈ 100KB，
 * 远低于 localStorage 的 5MB 预算。
 *
 * 导出是为了让淘汰逻辑本身可测 —— 不可测的淘汰策略就是没有淘汰策略。
 */
export const MAX_ENTRIES = 500;

/**
 * 文本哈希。刻意不用 crypto.subtle（异步 + headless 测试环境不可用），
 * 也不用完整原文当键（长句会撑爆键空间）。
 *
 * FNV-1a 32 位：冲突概率在 500 条规模下约 3e-5，且**冲突的后果仅是取到另一句
 * 的译文**，不会破坏数据。这里再拼上长度做二次区分，进一步降低该概率。
 */
function hashKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}-${text.length.toString(36)}`;
}

function storageKey(text: string, targetLang: string): string {
  return `${KEY_PREFIX}${targetLang}:${hashKey(text)}`;
}

export interface CachedTranslation {
  translation: string;
  provider: string;
}

/** 落盘形状：短键名（省字节），`s` 是淘汰用的自增序号。 */
interface StoredEntry {
  t: string;
  p: string;
  s: number;
}

/**
 * localStorage 不可用时的兜底。
 *
 * 隐私模式 / 配额满 / 存储被禁用都会让 `localStorage` 抛错。缓存只是优化，
 * 拿不到就该安静地退化成「每次都请求」，绝不能让划词翻译整个不可用。
 */
function safeStorage(): Storage | null {
  try {
    const probe = "__vocab_tr_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 下一个淘汰序号。读不到 / 坏掉都从 0 重新开始（不阻塞写入）。 */
function nextSeq(store: Storage): number {
  let current = 0;
  try {
    const parsed = Number.parseInt(store.getItem(SEQ_KEY) ?? "0", 10);
    if (Number.isFinite(parsed) && parsed > 0) current = parsed;
  } catch {
    /* 计数器坏掉就当从 0 开始 */
  }
  const next = current + 1;
  try {
    store.setItem(SEQ_KEY, String(next));
  } catch {
    /* 写不进计数器只影响淘汰顺序，不影响缓存可用性 */
  }
  return next;
}

export function readCachedTranslation(text: string, targetLang: string): CachedTranslation | null {
  const store = safeStorage();
  if (!store) return null;
  const key = storageKey(text, targetLang);
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredEntry>;
    if (typeof parsed?.t !== "string" || parsed.t.length === 0) return null;
    return { translation: parsed.t, provider: typeof parsed.p === "string" ? parsed.p : "unknown" };
  } catch {
    // 坏数据（手工改坏、跨版本结构变化）就当没命中，顺手清掉。
    try {
      store.removeItem(key);
    } catch {
      /* 忽略：清不掉也不影响下次 */
    }
    return null;
  }
}

export function writeCachedTranslation(
  text: string,
  targetLang: string,
  entry: CachedTranslation,
): void {
  const store = safeStorage();
  if (!store) return;
  try {
    const stored: StoredEntry = { t: entry.translation, p: entry.provider, s: nextSeq(store) };
    store.setItem(storageKey(text, targetLang), JSON.stringify(stored));
  } catch {
    // 配额满：放弃写入这一次，不影响本次翻译结果。
    return;
  }
  evictIfNeeded(store);
}

/** 列出所有缓存条目（键 + 序号），损坏的条目按序号 0 视为最旧。 */
function listEntries(store: Storage): Array<{ key: string; seq: number }> {
  const entries: Array<{ key: string; seq: number }> = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (!key?.startsWith(KEY_PREFIX)) continue;
    let seq = 0;
    try {
      const raw = store.getItem(key);
      const parsed = raw ? (JSON.parse(raw) as Partial<StoredEntry>) : null;
      if (typeof parsed?.s === "number") seq = parsed.s;
    } catch {
      /* 坏条目当最旧，优先淘汰 */
    }
    entries.push({ key, seq });
  }
  return entries;
}

function evictIfNeeded(store: Storage): void {
  try {
    const entries = listEntries(store);
    if (entries.length <= MAX_ENTRIES) return;
    entries.sort((a, b) => a.seq - b.seq);
    const excess = entries.length - MAX_ENTRIES;
    for (let i = 0; i < excess; i += 1) {
      store.removeItem(entries[i]!.key);
    }
  } catch {
    /* 淘汰失败只是缓存偏大，无害 */
  }
}

/**
 * 删掉单条缓存（「重新翻译」用）。
 *
 * 必须在请求前删：**读缓存是同步的**，如果先请求后删，这次点「重新翻译」拿到的
 * 还是旧译文，界面看着像没生效。
 */
export function clearOne(text: string, targetLang: string): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.removeItem(storageKey(text, targetLang));
  } catch {
    /* 删不掉则本次仍会命中缓存，退化为无操作 */
  }
}

/** 供设置页/调试用：清掉全部划词译文缓存，返回清掉的条数。 */
export function clearTranslationCache(): number {
  const store = safeStorage();
  if (!store) return 0;
  const doomed = listEntries(store).map((entry) => entry.key);
  for (const key of doomed) {
    try {
      store.removeItem(key);
    } catch {
      /* 忽略 */
    }
  }
  // 计数器一并归零：条目全清后继续用大序号只是浪费，且会让「刚清过缓存」
  // 这个状态在前端无从判断。
  try {
    store.removeItem(SEQ_KEY);
  } catch {
    /* 忽略 */
  }
  return doomed.length;
}

/** 缓存条数（设置页展示用）。 */
export function countTranslationCache(): number {
  const store = safeStorage();
  if (!store) return 0;
  return listEntries(store).length;
}
