/**
 * PlazaCache — 词汇广场聚合结果的进程内 TTL 缓存（P4 性能优化 P0）。
 *
 * 背景：语义场/词根聚合是每次访问都全表重算（实测 66ms / 201ms，且每次访问跑
 * 两次 total+showing）。聚合数据只随词库变更（导入/批量/采集）而变，因此进程内
 * 短 TTL 缓存能把广场从「每次全表扫」降为「首访一次、后续 0ms」。
 *
 * 失效：所有写 words 的服务（VocabImportService / WordService.batchCreate /
 * CaptureService）在写入后调用 invalidateAll()，保证导入后最多 TTL 内反映。
 *
 * 注意：聚合结果按当前 owner 事务查询（RLS 隔离）。当前为单 owner 架构，进程内
 * 共享缓存安全；若引入多用户，须把 userId 纳入缓存 key。
 */

interface PlazaCacheEntry {
  value: unknown;
  expiresAt: number;
}

export class PlazaCache {
  private readonly entries = new Map<string, PlazaCacheEntry>();

  constructor(
    /** 聚合缓存存活时间（毫秒）。默认 5 分钟。 */
    private readonly ttlMs = 300_000,
  ) {}

  get<T>(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** 词库变更后清空全部聚合缓存（导入 / 批量 / 采集后调用）。 */
  invalidateAll(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** 全局单例：PlazaService 读、写词服务失效。 */
export const plazaCache = new PlazaCache();
