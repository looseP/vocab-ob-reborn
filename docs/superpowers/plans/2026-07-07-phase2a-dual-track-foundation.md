# Phase 2A: 双轨 FSRS 地基 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 L1/L2 双轨隔离地基——content_hash 分层 + L2 进度表 + 跃迁机制，让 L2 扩展只触发 L2 重卡不影响 L1。

**Architecture:** words 表加 l1/l2_content_hash 列；新建 user_word_l2_progress 表；拆分 markStaleForRecheck 为 L1/L2 版；saveAnswer 改写 l1_content_hash_snapshot；review_logs 加 track 字段；submitAnswer 末尾插入跃迁检查。所有改动向后兼容（保留 content_hash 全量列）。

**Tech Stack:** TypeScript 5 + drizzle-orm + pg + Vitest 4 + ts-fsrs + Node.js crypto（内置）

**Spec 依据:** `docs/superpowers/specs/2026-07-07-dual-track-fsrs-spec.md`（已整合 3 决策 + 10 漏洞修复）

**前置条件:**
- ✅ Phase 0（地基）+ Phase 1（HTTP 接线）完成
- ✅ 180 测试全过，arch:check 零违规，typecheck 零错误
- ✅ dual-track-fsrs-spec.md 已 review + commit

---

## File Structure

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/db/content-hash.ts` | computeL1Hash / computeL2Hash / computeFullHash |
| `src/repositories/l2-progress.repository.ts` | L2 进度表 CRUD |
| `src/services/l2-transition.service.ts` | L1→L2 跃迁检查 |
| `tests/db/content-hash.test.ts` | hash 计算测试 |
| `tests/repositories/l2-progress.test.ts` | L2 repo 测试 |
| `tests/services/l2-transition.test.ts` | 跃迁服务测试 |
| `scripts/backfill-content-hash.ts` | 离线回填脚本 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/db/schema.ts` | words 加 l1/l2_content_hash；user_word_progress 加 l1_content_hash_snapshot + recent_ratings + l1_weak_signal；新建 user_word_l2_progress 表；review_logs 加 track |
| `src/repositories/review.repository.ts` | markStaleForRecheck 拆 markL1Stale + markL2Stale；saveAnswer 改 l1_content_hash_snapshot + recent_ratings append |
| `src/repositories/interfaces.ts` | 加 IL2ProgressRepository 接口 |
| `src/repositories/factory.ts` | 加 l2Progress repo 实例化 |
| `src/services/review.service.ts` | submitAnswer 末尾插入跃迁检查（try-catch 只吞 23505） |
| `src/services/index.ts` | 加 L2TransitionService 到 createServices |
| `src/domain/index.ts` | 加 UserWordL2ProgressRow 类型 |
| `src/index.ts` | 导出新类型/repo/service |

---

## Task 1: content_hash 计算函数（TDD）

**Files:**
- Create: `src/db/content-hash.ts`
- Test: `tests/db/content-hash.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/db/content-hash.test.ts
import { describe, it, expect } from "vitest";
import { computeL1Hash, computeL2Hash, computeFullHash } from "@/db/content-hash";

const SAMPLE_WORD = {
  definition_md: "**adj.** ①==大量存在==",
  core_definitions: [{ partOfSpeech: "adj.", senses: [{ def: "大量存在" }] }],
  prototype_text: "水从容器中溢出",
  metadata: {
    morphology: { parts: [{ kind: "root", text: "und", gloss: "波浪" }], raw: "", narrative: "词源叙事" },
    mnemonic: { etymology: "叙事化词源", breakdown: "词拆分" },
    semantic_chain: { oneWord: "溢", centerExtension: "延伸", chain: ["溢出", "大量"] },
  },
  collocations: [{ phrase: "abundant evidence", gloss: "充分证据" }],
  corpus_items: [{ text: "abundant rainfall", translation: "充沛降雨" }],
  synonym_items: [{ word: "plentiful", semanticDiff: "语感差异" }],
  antonym_items: [{ word: "scarce", note: "反义" }],
};

describe("computeL1Hash", () => {
  it("returns 64-char hex string", () => {
    const hash = computeL1Hash(SAMPLE_WORD as any);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic (same input → same hash)", () => {
    expect(computeL1Hash(SAMPLE_WORD as any)).toBe(computeL1Hash(SAMPLE_WORD as any));
  });

  it("changes when L1 content changes", () => {
    const modified = { ...SAMPLE_WORD, definition_md: "**adj.** ①==稀少==" } as any;
    expect(computeL1Hash(modified)).not.toBe(computeL1Hash(SAMPLE_WORD as any));
  });

  it("does NOT change when L2 content changes", () => {
    const modified = { ...SAMPLE_WORD, collocations: [{ phrase: "different", gloss: "x" }] } as any;
    expect(computeL1Hash(modified)).toBe(computeL1Hash(SAMPLE_WORD as any));
  });
});

describe("computeL2Hash", () => {
  it("returns 64-char hex string", () => {
    expect(computeL2Hash(SAMPLE_WORD as any)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does NOT change when L1 content changes", () => {
    const modified = { ...SAMPLE_WORD, definition_md: "different" } as any;
    expect(computeL2Hash(modified)).toBe(computeL2Hash(SAMPLE_WORD as any));
  });

  it("changes when L2 content changes", () => {
    const modified = { ...SAMPLE_WORD, collocations: [] } as any;
    expect(computeL2Hash(modified)).not.toBe(computeL2Hash(SAMPLE_WORD as any));
  });
});

describe("computeFullHash", () => {
  it("returns 64-char hex string", () => {
    expect(computeFullHash(SAMPLE_WORD as any)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when either L1 or L2 changes", () => {
    const l1Modified = { ...SAMPLE_WORD, definition_md: "different" } as any;
    const l2Modified = { ...SAMPLE_WORD, collocations: [] } as any;
    expect(computeFullHash(l1Modified)).not.toBe(computeFullHash(SAMPLE_WORD as any));
    expect(computeFullHash(l2Modified)).not.toBe(computeFullHash(SAMPLE_WORD as any));
  });
});
```

- [ ] **Step 2: 运行测试看失败**

```bash
npx vitest run tests/db/content-hash.test.ts
```

Expected: FAIL — `Cannot find module '@/db/content-hash'`

- [ ] **Step 3: 写最小实现**

```typescript
// src/db/content-hash.ts
import { createHash } from "node:crypto";

interface WordForHashing {
  definition_md?: string;
  core_definitions?: unknown;
  prototype_text?: string | null;
  metadata?: {
    morphology?: unknown;
    mnemonic?: unknown;
    semantic_chain?: unknown;
  };
  collocations?: unknown;
  corpus_items?: unknown;
  synonym_items?: unknown;
  antonym_items?: unknown;
}

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

/** L1 hash = hash(L1 字段：释义+词根+记忆锚点+语义链路) */
export function computeL1Hash(word: WordForHashing): string {
  const l1Data = JSON.stringify({
    definition_md: word.definition_md ?? "",
    core_definitions: word.core_definitions ?? [],
    prototype_text: word.prototype_text ?? "",
    morphology: word.metadata?.morphology ?? null,
    mnemonic: word.metadata?.mnemonic ?? null,
    semantic_chain: word.metadata?.semantic_chain ?? null,
  });
  return sha256(l1Data);
}

/** L2 hash = hash(L2 字段：搭配+语料+同义+反义) */
export function computeL2Hash(word: WordForHashing): string {
  const l2Data = JSON.stringify({
    collocations: word.collocations ?? [],
    corpus_items: word.corpus_items ?? [],
    synonym_items: word.synonym_items ?? [],
    antonym_items: word.antonym_items ?? [],
  });
  return sha256(l2Data);
}

/** 全量 hash = hash(L1 + L2)，兼容导入去重 */
export function computeFullHash(word: WordForHashing): string {
  return sha256(computeL1Hash(word) + computeL2Hash(word));
}
```

- [ ] **Step 4: 运行测试看通过**

```bash
npx vitest run tests/db/content-hash.test.ts
```

Expected: PASS（10 个测试）

- [ ] **Step 5: typecheck + arch:check**

```bash
npm run typecheck && npm run arch:check
```

- [ ] **Step 6: Commit**

```bash
git add src/db/content-hash.ts tests/db/content-hash.test.ts
git commit -m "feat(db): add content_hash layering (L1/L2/full)"
```

---

## Task 2: drizzle schema 加新列 + 新表（migration）

**Files:**
- Modify: `src/db/schema.ts`
- Generated: `drizzle/0002_*.sql`（由 db:generate 生成）

- [ ] **Step 1: 在 schema.ts 追加列定义**

在 words 表定义里加：
```typescript
l1ContentHash: text("l1_content_hash"),
l2ContentHash: text("l2_content_hash"),
```

在 user_word_progress 表定义里加：
```typescript
l1ContentHashSnapshot: text("l1_content_hash_snapshot"),
recentRatings: jsonb("recent_ratings").default([]).notNull(),
l1WeakSignal: boolean("l1_weak_signal").default(false).notNull(),
```

在 review_logs 表定义里加：
```typescript
track: text("track").default("l1").notNull(),
```

追加新表 `userWordL2Progress`（按 spec 3.3 节，retention=0.900，CHECK>=0.900）。

- [ ] **Step 2: 生成 migration**

```bash
npm run db:generate
```

Expected: 生成 `drizzle/0002_*.sql`，包含 ALTER TABLE + CREATE TABLE

- [ ] **Step 3: 检查生成的 SQL**

```bash
cat drizzle/0002_*.sql
```

确认：
- words 加 l1_content_hash / l2_content_hash
- user_word_progress 加 l1_content_hash_snapshot / recent_ratings / l1_weak_signal
- review_logs 加 track + 索引
- user_word_l2_progress 新建（含所有 CHECK 约束 + 索引）

- [ ] **Step 4: typecheck**

```bash
npm run typecheck
```

- [ ] **Step 5: arch:check**

```bash
npm run arch:check
```

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): add dual-track schema (L2 progress table + content_hash layering)"
```

---

## Task 3: L2 domain 类型（TDD）

**Files:**
- Modify: `src/domain/index.ts`
- Test: `tests/domain.test.ts`（追加）

- [ ] **Step 1: 追加类型测试**

```typescript
// 追加到 tests/domain.test.ts
import type { UserWordL2ProgressRow } from "@/domain";

describe("UserWordL2ProgressRow", () => {
  it("has required FSRS fields", () => {
    expectTypeOf<UserWordL2ProgressRow>().toMatchTypeOf<{
      id: string;
      user_id: string;
      word_id: string;
      l2_stability: number | null;
      l2_difficulty: number | null;
      l2_state: string;
      l2_desired_retention: number;
      l2_due_at: string | null;
      l2_review_count: number;
      l2_paused: boolean;
      l2_inherited_from_l1: boolean;
    }>();
  });
});
```

- [ ] **Step 2: 运行测试看失败**（typecheck 失败，类型不存在）

- [ ] **Step 3: 在 domain/index.ts 追加类型**

```typescript
export interface UserWordL2ProgressRow {
  id: string;
  user_id: string;
  word_id: string;
  l2_stability: number | null;
  l2_difficulty: number | null;
  l2_retrievability: number | null;
  l2_state: string;
  l2_desired_retention: number;
  l2_due_at: string | null;
  l2_last_reviewed_at: string | null;
  l2_last_rating: string | null;
  l2_review_count: number;
  l2_lapse_count: number;
  l2_interval_days: number | null;
  l2_scheduler_payload: unknown;
  l2_again_count: number;
  l2_hard_count: number;
  l2_good_count: number;
  l2_easy_count: number;
  l2_content_hash_snapshot: string | null;
  recent_ratings: string[];
  l2_paused: boolean;
  l2_paused_at: string | null;
  l2_paused_reason: string | null;
  l2_inherited_from_l1: boolean;
  l2_weights_source: string;
  l2_predicted_retrievability: number | null;
  l3_pending: boolean;
  l3_self_assessments: unknown[];
  created_at: string;
}
```

- [ ] **Step 4: 运行测试看通过**

- [ ] **Step 5: Commit**

```bash
git add src/domain/index.ts tests/domain.test.ts
git commit -m "feat(domain): add UserWordL2ProgressRow type"
```

---

## Task 4: L2 progress repository（TDD）

**Files:**
- Create: `src/repositories/l2-progress.repository.ts`
- Modify: `src/repositories/interfaces.ts`, `src/repositories/factory.ts`
- Test: `tests/repositories/l2-progress.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/repositories/l2-progress.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: any) => cb({})),
}));

import { L2ProgressRepository } from "@/repositories/l2-progress.repository";

describe("L2ProgressRepository", () => {
  it("findByWordAndUser returns null when not found", async () => {
    const repo = new L2ProgressRepository();
    // mock queryOne to return null
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    const result = await repo.findByWordAndUser("user-1", "word-1");
    expect(result).toBeNull();
  });

  it("insert creates L2 progress row", async () => {
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue({ id: "l2-1", l2_state: "review" });
    const result = await repo.insert({
      user_id: "user-1",
      word_id: "word-1",
      l2_stability: 5.25,
      l2_difficulty: 7.0,
      l2_state: "review",
      l2_desired_retention: 0.9,
      l2_due_at: new Date().toISOString(),
      l2_inherited_from_l1: true,
      l2_weights_source: "inherited",
    });
    expect(result.id).toBe("l2-1");
  });

  it("markL2StaleForRecheck only affects l2_paused=false rows", async () => {
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([{ id: "l2-1" }]);
    const count = await repo.markL2StaleForRecheck("word-1", "newhash");
    expect(count).toBe(1);
    // 验证 SQL 里 WHERE l2_paused = false（通过 mock 的 call args 检查）
    const sqlCall = (repo as any).query.mock.calls[0][0];
    expect(sqlCall).toContain("l2_paused = false");
  });
});
```

- [ ] **Step 2: 运行测试看失败**

- [ ] **Step 3: 实现接口 + repository + factory 注册**

```typescript
// src/repositories/interfaces.ts 追加
export interface IL2ProgressRepository {
  findByWordAndUser(userId: string, wordId: string): Promise<UserWordL2ProgressRow | null>;
  insert(data: NewL2Progress): Promise<UserWordL2ProgressRow>;
  markL2StaleForRecheck(wordId: string, newL2Hash: string): Promise<number>;
  pause(userId: string, wordId: string, reason: string): Promise<void>;
  unpauseByReason(userId: string, wordId: string, reason: string): Promise<void>;
}
```

```typescript
// src/repositories/l2-progress.repository.ts
export class L2ProgressRepository extends BaseRepository implements IL2ProgressRepository {
  async findByWordAndUser(userId: string, wordId: string) {
    return this.queryOne<UserWordL2ProgressRow>(
      `SELECT * FROM user_word_l2_progress WHERE user_id = $1 AND word_id = $2::uuid`,
      [userId, wordId],
    );
  }

  async insert(data: NewL2Progress) {
    return this.queryOne<UserWordL2ProgressRow>(
      `INSERT INTO user_word_l2_progress (user_id, word_id, l2_stability, l2_difficulty, l2_state, l2_desired_retention, l2_due_at, l2_inherited_from_l1, l2_weights_source)
       VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [data.user_id, data.word_id, data.l2_stability, data.l2_difficulty, data.l2_state, data.l2_desired_retention, data.l2_due_at, data.l2_inherited_from_l1, data.l2_weights_source],
    );
  }

  async markL2StaleForRecheck(wordId: string, newL2Hash: string) {
    const rows = await this.query<{ id: string }>(
      `UPDATE user_word_l2_progress
       SET l2_content_hash_snapshot = $1, l2_due_at = now()
       WHERE word_id = $2::uuid
         AND l2_content_hash_snapshot IS NOT NULL
         AND l2_content_hash_snapshot != $1
         AND l2_paused = false
       RETURNING id`,
      [newL2Hash, wordId],
    );
    return rows.length;
  }

  async pause(userId: string, wordId: string, reason: string) {
    await this.query(
      `UPDATE user_word_l2_progress SET l2_paused = true, l2_paused_at = now(), l2_paused_reason = $3
       WHERE user_id = $1 AND word_id = $2::uuid`,
      [userId, wordId, reason],
    );
  }

  async unpauseByReason(userId: string, wordId: string, reason: string) {
    await this.query(
      `UPDATE user_word_l2_progress
       SET l2_paused = false, l2_paused_at = NULL, l2_paused_reason = NULL, l2_due_at = now()
       WHERE user_id = $1 AND word_id = $2::uuid AND l2_paused_reason = $3`,
      [userId, wordId, reason],
    );
  }
}
```

在 factory.ts 加 `l2Progress: new L2ProgressRepository(tx)`。

- [ ] **Step 4: 运行测试看通过**

- [ ] **Step 5: arch:check（确认新 repo 在 repositories 层）**

- [ ] **Step 6: Commit**

```bash
git add src/repositories/ tests/repositories/l2-progress.test.ts
git commit -m "feat(repositories): add L2ProgressRepository"
```

---

## Task 5: markStaleForRecheck 拆分 L1/L2 版（TDD）

**Files:**
- Modify: `src/repositories/review.repository.ts`
- Modify: `tests/repositories.test.ts`（追加）

- [ ] **Step 1: 追加测试——L1 版只改 l1_content_hash_snapshot，L2 版不调**

```typescript
describe("markL1StaleForRecheck", () => {
  it("updates l1_content_hash_snapshot and needs_recheck", async () => {
    // mock + 验证 SQL 含 l1_content_hash_snapshot（不含 l2）
  });

  it("does NOT touch user_word_l2_progress", async () => {
    // 验证不调 L2 表
  });
});
```

- [ ] **Step 2: 实现拆分**

在 review.repository.ts 新增 `markL1StaleForRecheck`（用 l1_content_hash_snapshot）和 `markL2StaleForRecheck`（委托 L2ProgressRepository）。

保留原 `markStaleForRecheck` 标注 deprecated（兼容）。

- [ ] **Step 3: 运行测试看通过**

- [ ] **Step 4: 确认现有 60 个 repository 测试不回归**

```bash
npx vitest run tests/repositories.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/repositories/review.repository.ts tests/repositories.test.ts
git commit -m "feat(repositories): split markStaleForRecheck into L1/L2 versions"
```

---

## Task 6: saveAnswer 改造（TDD）

**Files:**
- Modify: `src/repositories/review.repository.ts`
- Modify: `tests/repositories.test.ts` / `tests/review-service.test.ts`

- [ ] **Step 1: 追加测试——验证 l1_content_hash_snapshot + recent_ratings 写入**

```typescript
describe("saveAnswer dual-track changes", () => {
  it("writes l1_content_hash_snapshot (not content_hash_snapshot as primary)", async () => {
    // mock + 验证 SQL 含 l1_content_hash_snapshot
  });

  it("appends rating to recent_ratings and slices to last 5", async () => {
    // 验证 recent_ratings 更新
  });
});
```

- [ ] **Step 2: 改造 saveAnswer SQL**

- 加 `l1_content_hash_snapshot = $N`
- 保留 `content_hash_snapshot = $N`（兼容）
- 加 `recent_ratings = ...`（append + slice 5）
- **参数编号位移**——逐个核对 $1-$14

- [ ] **Step 3: 运行全量测试确认不回归**

```bash
npx vitest run tests/repositories.test.ts tests/review-service.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/repositories/review.repository.ts tests/
git commit -m "feat(repositories): saveAnswer writes l1_content_hash_snapshot + recent_ratings"
```

---

## Task 7: L2 跃迁服务（TDD）

**Files:**
- Create: `src/services/l2-transition.service.ts`
- Modify: `src/services/index.ts`
- Test: `tests/services/l2-transition.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
describe("L2TransitionService.checkAndTransition", () => {
  it("transitions when L1_S >= 21 and review_count >= 5 and last_rating is good", async () => {
    // mock L1 progress with stability=25, review_count=6, last_rating='good'
    // mock l2Progress.findByWordAndUser returns null (no existing L2)
    // expect l2Progress.insert called with l2_stability = max(25 * 0.5 * 25/46, 1.0)
  });

  it("does NOT transition when stability < 21", async () => {});
  it("does NOT transition when review_count < 5", async () => {});
  it("does NOT transition when last_rating is 'again'", async () => {});
  it("is idempotent (skips if L2 progress exists)", async () => {});
  it("catches 23505 unique violation without rolling back L1", async () => {});
  it("re-throws non-23505 errors", async () => {});
  it("L2_S has absolute floor of 1.0", async () => {
    // L1_S = 21 → ratio = 0.25 → L2_S = max(5.25, 1.0) = 5.25
    // L1_S = 0.5 (edge) → ratio = 0.012 → L2_S = max(0.006, 1.0) = 1.0
  });
});
```

- [ ] **Step 2: 运行测试看失败**

- [ ] **Step 3: 实现 L2TransitionService**

```typescript
// src/services/l2-transition.service.ts
export class L2TransitionService {
  constructor(private l2ProgressRepo: L2ProgressRepository) {}

  async checkAndTransition(progress: L1ProgressSnapshot): Promise<void> {
    if (Number(progress.stability) < 21) return;
    if (progress.review_count < 5) return;
    if (!['good', 'easy'].includes(progress.last_rating ?? '')) return;

    const l1S = Number(progress.stability);
    const inheritRatio = 0.5 * l1S / (l1S + 21);
    const l2Stability = Math.max(l1S * inheritRatio, 1.0);  // 漏洞1修复
    const l2Difficulty = Math.min(10, (Number(progress.difficulty) ?? 5) + 2.0);
    const l2DueAt = new Date(Date.now() + l2Stability * 86400000);

    try {
      await this.l2ProgressRepo.insert({
        user_id: progress.user_id,
        word_id: progress.word_id,
        l2_stability: l2Stability,
        l2_difficulty: l2Difficulty,
        l2_state: 'review',
        l2_desired_retention: 0.9,
        l2_due_at: l2DueAt.toISOString(),
        l2_inherited_from_l1: true,
        l2_weights_source: 'inherited',
      });
    } catch (err: any) {
      if (err.code === '23505') return;  // 幂等：L2 progress 已存在
      throw err;  // 漏洞2修复：不吞其他错误
    }
  }
}
```

在 services/index.ts 注入 L2TransitionService。

- [ ] **Step 4: 运行测试看通过**

- [ ] **Step 5: Commit**

```bash
git add src/services/l2-transition.service.ts src/services/index.ts tests/services/l2-transition.test.ts
git commit -m "feat(services): add L2 transition service (L1→L2 with inherit_ratio)"
```

---

## Task 8: submitAnswer 插入跃迁检查（TDD）

**Files:**
- Modify: `src/services/review.service.ts`
- Modify: `tests/review-service.test.ts`

- [ ] **Step 1: 追加测试——submitAnswer 后调 checkAndTransition**

```typescript
describe("submitAnswer L2 transition", () => {
  it("calls checkAndTransition after saveAnswer", async () => {
    // mock submitAnswer flow + verify checkAndTransition called with progress
  });

  it("does not fail L1 if transition throws non-23505", async () => {
    // transition throws → L1 result still returned
  });
});
```

- [ ] **Step 2: 在 ReviewService.submitAnswer 末尾（saveAnswer 后、return 前）插入**

```typescript
// Step 7.5: L2 跃迁检查（失败不影响 L1）
try {
  await this.deps.checkAndTransition(progress);
} catch (err) {
  logger.warn("review", "L2 transition failed", err);
}
```

注意：ReviewServiceDeps 加 `checkAndTransition` 可选字段。

- [ ] **Step 3: 运行测试看通过**

- [ ] **Step 4: 全量测试确认不回归**

```bash
npx vitest run tests/review-service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/services/review.service.ts tests/review-service.test.ts
git commit -m "feat(services): submitAnswer triggers L2 transition check"
```

---

## Task 9: review_logs track 字段适配（TDD）

**Files:**
- Modify: `src/repositories/review.repository.ts`（saveAnswer 的 INSERT review_logs 加 track='l1'）
- Modify: `tests/repositories.test.ts`

- [ ] **Step 1: 追加测试——saveAnswer 写 review_logs 时 track='l1'**

- [ ] **Step 2: 修改 saveAnswer 的 INSERT review_logs SQL 加 `track` 列**

- [ ] **Step 3: 运行测试看通过**

- [ ] **Step 4: Commit**

```bash
git add src/repositories/review.repository.ts tests/repositories.test.ts
git commit -m "feat(repositories): review_logs writes track='l1' for L1 reviews"
```

---

## Task 10: content_hash 回填脚本

**Files:**
- Create: `scripts/backfill-content-hash.ts`

- [ ] **Step 1: 写回填脚本**

```typescript
// scripts/backfill-content-hash.ts
// 分批 1000 词/批，每词 computeL1Hash + computeL2Hash 回填
import { getPool } from "../src/db/connection";
import { computeL1Hash, computeL2Hash, computeFullHash } from "../src/db/content-hash";

const BATCH_SIZE = 1000;

async function backfill() {
  const pool = getPool();
  let offset = 0;
  let total = 0;

  while (true) {
    const { rows } = await pool.query(
      `SELECT id, definition_md, core_definitions, prototype_text, metadata,
              collocations, corpus_items, synonym_items, antonym_items
       FROM words
       WHERE l1_content_hash IS NULL
       ORDER BY id
       LIMIT $1`,
      [BATCH_SIZE],
    );
    if (rows.length === 0) break;

    for (const word of rows) {
      const l1Hash = computeL1Hash(word);
      const l2Hash = computeL2Hash(word);
      const fullHash = computeFullHash(word);
      await pool.query(
        `UPDATE words SET l1_content_hash = $1, l2_content_hash = $2, content_hash = $3 WHERE id = $4`,
        [l1Hash, l2Hash, fullHash, word.id],
      );
      total++;
    }
    offset += rows.length;
    console.log(`Backfilled ${total} words...`);
  }
  console.log(`Done. Total: ${total}`);
}

backfill().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: 加 npm script**

```json
"db:script:backfill-hashes": "tsx scripts/backfill-content-hash.ts"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-content-hash.ts package.json
git commit -m "feat(scripts): add content_hash backfill script"
```

---

## Task 11: 全量验收

- [ ] **Step 1: 全量测试**

```bash
npm run verify:check
```

Expected: typecheck + 全部测试 PASS（180+ 新增测试）

- [ ] **Step 2: arch:check**

```bash
npm run arch:check
```

Expected: 零违规

- [ ] **Step 3: db:generate 确认零 diff（schema 和 migration 同步）**

```bash
npm run db:generate
```

Expected: "No schema changes" 或只有预期的 0002 migration

- [ ] **Step 4: 隔离验证测试**

手写一个临时测试验证"L2 扩展后 L1 needs_recheck 不变"：
- 模拟 L2 内容变更 → 调 markL2StaleForRecheck
- 断言 user_word_progress.needs_recheck 仍为 false

- [ ] **Step 5: Commit + Phase 2A 完成**

```bash
git add -A
git commit -m "chore: Phase 2A complete - dual-track FSRS foundation"
```

---

## 验收 Checklist

- [ ] `src/db/content-hash.ts` — computeL1Hash / computeL2Hash / computeFullHash
- [ ] `src/db/schema.ts` — words 加 l1/l2_content_hash；user_word_progress 加 l1_content_hash_snapshot + recent_ratings + l1_weak_signal；review_logs 加 track；user_word_l2_progress 新建
- [ ] `drizzle/0002_*.sql` — migration 生成
- [ ] `src/repositories/l2-progress.repository.ts` — L2 CRUD + markL2StaleForRecheck + pause/unpause
- [ ] `src/repositories/review.repository.ts` — markL1StaleForRecheck + saveAnswer 改造（l1_content_hash_snapshot + recent_ratings + track='l1'）
- [ ] `src/services/l2-transition.service.ts` — checkAndTransition（inherit_ratio + 下限 1.0 + 只吞 23505）
- [ ] `src/services/review.service.ts` — submitAnswer 末尾插入跃迁检查
- [ ] `scripts/backfill-content-hash.ts` — 回填脚本
- [ ] **L1 隔离验证**：L2 扩展 → markL2StaleForRecheck → user_word_progress.needs_recheck 不变
- [ ] **跃迁验证**：L1_S≥21 + review_count≥5 + good/easy → 自动创建 L2 progress（state=review, retention=0.9）
- [ ] **幂等验证**：重复跃迁不报错（23505 被吞）
- [ ] `npm run verify:check` 全绿
- [ ] `npm run arch:check` 零违规
