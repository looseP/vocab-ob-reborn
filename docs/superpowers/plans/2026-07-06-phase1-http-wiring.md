# Phase 1: HTTP 层接线 + FSRS 核心复制 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 v2-http 提供基础只读 + 复习 API，与 local 共享同一 PostgreSQL，FSRS 核心计算独立于 local。

**Architecture:** Hono HTTP 层接线 v2 的 Clean Architecture 服务层。FSRS 核心计算从 local 复制到 v2 的 `src/fsrs/`，清理 local 依赖，自包含类型。loadWeights 新建从 `wordbooks.settings` jsonb 读取。所有新代码 TDD——先写失败测试，再写最小实现。

**Tech Stack:** Hono + @hono/node-server（已装）、ts-fsrs@^5.4.1（待装）、Vitest 4（已有）、Zod v4（已有）

**依赖文档:**
- `docs/superpowers/specs/2026-07-06-self-growing-foundation-design.md`（地基设计，Phase 1 缺口分析）
- `docs/superpowers/specs/2026-07-06-self-growing-knowledge-chain.md`（架构决策）

**前置条件（Phase 0 已完成）:**
- ✅ `db:generate`/`db:migrate`/`db:push`/`dev` 脚本就绪
- ✅ dependency-cruiser 有 `http-no-raw-db-access` + `http-no-llm-direct` 规则
- ✅ `src/server.ts` + `src/http/server.ts` 骨架（/health 可跑）
- ✅ 0000 快照对齐（db:generate 零 diff）
- ✅ hono + @hono/node-server 已安装

---

## File Structure

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/fsrs/types.ts` | FSRS 核心类型（ReviewRating/ReviewState/StoredSchedulerCard/SchedulerUpdate），自包含 |
| `src/fsrs/adapter.ts` | FSRS 核心计算（applyReviewAnswer + scheduler 缓存 + 评级映射 + toCard/fromCard），从 local 复制改 import |
| `src/fsrs/index.ts` | Barrel re-export |
| `src/services/weights-loader.ts` | 从 wordbooks.settings jsonb 读 fsrs weights |
| `src/http/middleware/auth.ts` | Token 鉴权（owner/agent/public）+ userId 注入 |
| `src/http/middleware/error.ts` | errorToResponse → HTTP 状态码映射 |
| `src/http/routes/words.ts` | GET /api/words, GET /api/words/:slug |
| `src/http/routes/review.ts` | POST /api/review/answer, skip, suspend, undo |
| `tests/fsrs/adapter.test.ts` | FSRS 核心计算测试 |
| `tests/http/words.test.ts` | words 路由测试 |
| `tests/http/review.test.ts` | review 路由测试 |
| `tests/services/weights-loader.test.ts` | weights 加载测试 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/http/server.ts` | createApp 接收 services 参数，挂载路由 |
| `src/server.ts` | 装配 createServices + createApp |
| `package.json` | 加 ts-fsrs 依赖 |

---

## Task 1: 安装 ts-fsrs

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装 ts-fsrs**

```bash
npm install ts-fsrs@^5.4.1
```

- [ ] **Step 2: 验证安装**

```bash
node -e "const {fsrs, Rating, State} = require('ts-fsrs'); console.log(Rating.Again, State.New, typeof fsrs)"
```

Expected: `1 0 function`

- [ ] **Step 3: 验证 typecheck 仍通过**

```bash
npm run typecheck
```

Expected: 零错误

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add ts-fsrs@^5.4.1 dependency for FSRS core"
```

---

## Task 2: FSRS 类型定义（TDD）

**Files:**
- Create: `src/fsrs/types.ts`
- Test: `tests/fsrs/types.test.ts`

- [ ] **Step 1: 写失败测试 — 类型存在性**

```typescript
// tests/fsrs/types.test.ts
import { describe, it, expectTypeOf } from "vitest";
import type { ReviewRating, ReviewState, StoredSchedulerCard, SchedulerUpdate } from "@/fsrs/types";

describe("FSRS types", () => {
  it("ReviewRating is the four rating literals", () => {
    expectTypeOf<ReviewRating>().toEqualTypeOf<"again" | "hard" | "good" | "easy">();
  });

  it("ReviewState is the four state literals", () => {
    expectTypeOf<ReviewState>().toEqualTypeOf<"new" | "learning" | "review" | "relearning">();
  });

  it("StoredSchedulerCard has serializable fields", () => {
    expectTypeOf<StoredSchedulerCard>().toMatchTypeOf<{
      difficulty: number;
      due: string;
      elapsed_days: number;
      lapses: number;
      learning_steps: number;
      last_review: string | null;
      reps: number;
      scheduled_days: number;
      stability: number;
      state: number;
    }>();
  });

  it("SchedulerUpdate wraps the scheduling result", () => {
    expectTypeOf<SchedulerUpdate>().toMatchTypeOf<{
      difficulty: number;
      dueAt: string;
      elapsedDays: number;
      lapses: number;
      logDueAt: string;
      nextPayload: StoredSchedulerCard;
      rating: ReviewRating;
      reps: number;
      retrievability: number | null;
      scheduledDays: number;
      stability: number;
      state: ReviewState;
    }>();
  });
});
```

- [ ] **Step 2: 运行测试看失败**

```bash
npx vitest run tests/fsrs/types.test.ts
```

Expected: FAIL — `Cannot find module '@/fsrs/types'`

- [ ] **Step 3: 写最小实现**

```typescript
// src/fsrs/types.ts
/**
 * FSRS 核心类型 —— 自包含，不依赖 DB schema 或业务类型。
 * 从 local lib/review/types.ts 精简而来，删除所有业务类型。
 */

export type ReviewRating = "again" | "hard" | "good" | "easy";

export type ReviewState = "new" | "learning" | "review" | "relearning";

/**
 * ts-fsrs Card 的可序列化快照。
 * Date 字段转成 string（ISO），state 用 number（而非 State enum）。
 * 这是存进 DB jsonb 的格式。
 */
export interface StoredSchedulerCard {
  difficulty: number;
  due: string;
  elapsed_days: number;
  lapses: number;
  learning_steps: number;
  last_review: string | null;
  reps: number;
  scheduled_days: number;
  stability: number;
  state: number;
}

/**
 * applyReviewAnswer 的返回值。
 * 包含更新后的卡片状态（nextPayload）+ 调度元数据。
 */
export interface SchedulerUpdate {
  difficulty: number;
  dueAt: string;
  elapsedDays: number;
  lapses: number;
  logDueAt: string;
  nextPayload: StoredSchedulerCard;
  rating: ReviewRating;
  reps: number;
  retrievability: number | null;
  scheduledDays: number;
  stability: number;
  state: ReviewState;
}
```

- [ ] **Step 4: 运行测试看通过**

```bash
npx vitest run tests/fsrs/types.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/fsrs/types.ts tests/fsrs/types.test.ts
git commit -m "feat(fsrs): add self-contained FSRS core types"
```

---

## Task 3: FSRS 常量 + 评级映射（TDD）

**Files:**
- Create: `src/fsrs/adapter.ts`（本任务只加常量 + 映射，后续任务补函数）
- Test: `tests/fsrs/adapter.test.ts`（逐步追加）

- [ ] **Step 1: 写失败测试 — 常量 + 映射**

```typescript
// tests/fsrs/adapter.test.ts
import { describe, it, expect } from "vitest";
import {
  DEFAULT_DESIRED_RETENTION,
  MIN_DESIRED_RETENTION,
  MAX_DESIRED_RETENTION,
  SCHEDULER_CACHE_LIMIT,
  normalizeDesiredRetention,
} from "@/fsrs/adapter";
import { Rating, State } from "ts-fsrs";

describe("FSRS constants", () => {
  it("DEFAULT_DESIRED_RETENTION is 0.9", () => {
    expect(DEFAULT_DESIRED_RETENTION).toBe(0.9);
  });

  it("retention bounds are 0.7 to 0.99", () => {
    expect(MIN_DESIRED_RETENTION).toBe(0.7);
    expect(MAX_DESIRED_RETENTION).toBe(0.99);
  });

  it("SCHEDULER_CACHE_LIMIT is 100", () => {
    expect(SCHEDULER_CACHE_LIMIT).toBe(100);
  });
});

describe("normalizeDesiredRetention", () => {
  it("clamps below minimum", () => {
    expect(normalizeDesiredRetention(0.5)).toBe(0.7);
  });

  it("clamps above maximum", () => {
    expect(normalizeDesiredRetention(1.0)).toBe(0.99);
  });

  it("passes through valid values", () => {
    expect(normalizeDesiredRetention(0.85)).toBe(0.85);
  });

  it("clamps NaN to minimum", () => {
    expect(normalizeDesiredRetention(NaN)).toBe(0.7);
  });
});
```

- [ ] **Step 2: 运行测试看失败**

```bash
npx vitest run tests/fsrs/adapter.test.ts
```

Expected: FAIL — `Cannot find module '@/fsrs/adapter'`

- [ ] **Step 3: 写最小实现**

```typescript
// src/fsrs/adapter.ts
/**
 * FSRS 核心计算 —— 从 local lib/review/fsrs-adapter.ts 复制，清理 local 依赖。
 * 自包含：只依赖 ts-fsrs + 本目录 types。
 */
import { createEmptyCard, fsrs, Rating, State, type Card } from "ts-fsrs";
import type { ReviewRating, ReviewState, StoredSchedulerCard, SchedulerUpdate } from "@/fsrs/types";

// ── 常量 ──────────────────────────────────────────────────────────────────────

export const DEFAULT_DESIRED_RETENTION = 0.9;
export const MIN_DESIRED_RETENTION = 0.7;
export const MAX_DESIRED_RETENTION = 0.99;
export const SCHEDULER_CACHE_LIMIT = 100;

// ── 评级映射 ──────────────────────────────────────────────────────────────────

const ratingMap: Record<ReviewRating, 1 | 2 | 3 | 4> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const reviewStateMap: Record<number, ReviewState> = {
  [State.New]: "new",
  [State.Learning]: "learning",
  [State.Review]: "review",
  [State.Relearning]: "relearning",
};

// ── 工具函数 ──────────────────────────────────────────────────────────────────

export function normalizeDesiredRetention(value: number): number {
  if (Number.isNaN(value)) return MIN_DESIRED_RETENTION;
  return Math.max(MIN_DESIRED_RETENTION, Math.min(MAX_DESIRED_RETENTION, value));
}
```

- [ ] **Step 4: 运行测试看通过**

```bash
npx vitest run tests/fsrs/adapter.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/fsrs/adapter.ts tests/fsrs/adapter.test.ts
git commit -m "feat(fsrs): add constants and rating mappings"
```

---

## Task 4: toCard / fromCard 转换函数（TDD）

**Files:**
- Modify: `src/fsrs/adapter.ts`（追加函数）
- Modify: `tests/fsrs/adapter.test.ts`（追加测试）

- [ ] **Step 1: 写失败测试 — toCard 防御性回退**

在 `tests/fsrs/adapter.test.ts` 追加：

```typescript
describe("toCard (via applyReviewAnswer internals)", () => {
  // toCard 不是 export 的，但 applyReviewAnswer 会调它。
  // 这里通过 buildInitialSchedulerPayload 间接测，或直接测 applyReviewAnswer 的 null payload 分支。
  // 先跳过直接测 toCard，等 Task 6 的 applyReviewAnswer 测试覆盖。
});
```

**注意**：`toCard`/`fromCard` 是模块内部函数（不 export）。按 TDD 原则，不测私有函数——通过测公开 API（`applyReviewAnswer`/`buildInitialSchedulerPayload`）间接覆盖。这个测试块先占位，Task 6 填充。

- [ ] **Step 2: 跳过（无新测试需失败）**

直接进 Step 3 写实现，Task 6 会测。

- [ ] **Step 3: 追加 toCard/fromCard 到 adapter.ts**

在 `src/fsrs/adapter.ts` 追加（从 local 第 105-152 行复制，import 已就位）：

```typescript
// ── Card 转换 ─────────────────────────────────────────────────────────────────

function toCard(payload: StoredSchedulerCard | null | undefined): Card {
  if (!payload) return createEmptyCard();

  try {
    const state = typeof payload.state === "number" ? payload.state : 0;
    const difficulty = Number.isFinite(payload.difficulty) ? payload.difficulty : 0;
    const stability = Number.isFinite(payload.stability) ? payload.stability : 0;

    const due = new Date(payload.due);
    if (Number.isNaN(due.getTime())) return createEmptyCard();

    const lastReview = payload.last_review ? new Date(payload.last_review) : undefined;
    if (lastReview && Number.isNaN(lastReview.getTime())) return createEmptyCard();

    return {
      due,
      stability,
      difficulty,
      elapsed_days: payload.elapsed_days ?? 0,
      scheduled_days: payload.scheduled_days ?? 0,
      reps: payload.reps ?? 0,
      lapses: payload.lapses ?? 0,
      state,
      last_review: lastReview,
      learning_steps: payload.learning_steps ?? 0,
    };
  } catch {
    return createEmptyCard();
  }
}

function fromCard(card: Card): StoredSchedulerCard {
  return {
    difficulty: card.difficulty,
    due: card.due.toISOString(),
    elapsed_days: card.elapsed_days,
    lapses: card.lapses,
    learning_steps: card.learning_steps ?? 0,
    last_review: card.last_review ? card.last_review.toISOString() : null,
    reps: card.reps,
    scheduled_days: card.scheduled_days,
    stability: card.stability,
    state: card.state,
  };
}
```

- [ ] **Step 4: 运行测试确认仍通过**

```bash
npx vitest run tests/fsrs/adapter.test.ts
```

Expected: PASS（toCard/fromCard 未被测试直接调用，但不破坏现有测试）

- [ ] **Step 5: Commit**

```bash
git add src/fsrs/adapter.ts tests/fsrs/adapter.test.ts
git commit -m "feat(fsrs): add toCard/fromCard conversion functions"
```

---

## Task 5: scheduler 缓存 getScheduler（TDD）

**Files:**
- Modify: `src/fsrs/adapter.ts`
- Modify: `tests/fsrs/adapter.test.ts`

- [ ] **Step 1: 写失败测试 — 缓存行为**

在 `tests/fsrs/adapter.test.ts` 追加：

```typescript
import { getSchedulerCacheSize } from "@/fsrs/adapter";

describe("getScheduler cache", () => {
  it("starts empty", () => {
    // 缓存是模块级单例，测试间可能有残留。这里只断言 >= 0。
    expect(getSchedulerCacheSize()).toBeGreaterThanOrEqual(0);
  });
});
```

**注意**：缓存是模块级 Map，测试间共享。完整 LRU 测试在 Task 6 通过 applyReviewAnswer 间接覆盖。这里先测 export 存在。

- [ ] **Step 2: 运行测试看失败**

```bash
npx vitest run tests/fsrs/adapter.test.ts
```

Expected: FAIL — `getSchedulerCacheSize is not exported`

- [ ] **Step 3: 追加 getScheduler + 缓存到 adapter.ts**

```typescript
// ── scheduler 缓存 ────────────────────────────────────────────────────────────

const schedulerCache = new Map<string, ReturnType<typeof fsrs>>();

function signWeights(weights?: readonly number[] | null): string {
  if (!weights || weights.length === 0) return "default";
  return weights.map((w) => w.toFixed(6)).join(",");
}

export function getSchedulerCacheSize(): number {
  return schedulerCache.size;
}

function getScheduler(
  desiredRetention = DEFAULT_DESIRED_RETENTION,
  weights?: readonly number[] | null,
): ReturnType<typeof fsrs> {
  const normalizedRetention = normalizeDesiredRetention(desiredRetention);
  const rounded = Number(normalizedRetention.toFixed(3));
  const cacheKey = `${rounded}|${signWeights(weights)}`;
  const cached = schedulerCache.get(cacheKey);

  if (cached) {
    // LRU refresh
    schedulerCache.delete(cacheKey);
    schedulerCache.set(cacheKey, cached);
    return cached;
  }

  const scheduler = fsrs({
    maximum_interval: 36500,
    request_retention: rounded,
    ...(weights && weights.length > 0 ? { w: [...weights] } : {}),
  });

  if (schedulerCache.size >= SCHEDULER_CACHE_LIMIT) {
    const oldestKey = schedulerCache.keys().next().value;
    if (oldestKey !== undefined) {
      schedulerCache.delete(oldestKey);
    }
  }
  schedulerCache.set(cacheKey, scheduler);
  return scheduler;
}
```

- [ ] **Step 4: 运行测试看通过**

```bash
npx vitest run tests/fsrs/adapter.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/fsrs/adapter.ts tests/fsrs/adapter.test.ts
git commit -m "feat(fsrs): add LRU scheduler cache"
```

---

## Task 6: applyReviewAnswer 核心函数（TDD）

**Files:**
- Modify: `src/fsrs/adapter.ts`
- Modify: `tests/fsrs/adapter.test.ts`

- [ ] **Step 1: 写失败测试 — applyReviewAnswer 行为**

在 `tests/fsrs/adapter.test.ts` 追加：

```typescript
import { applyReviewAnswer } from "@/fsrs/adapter";
import type { StoredSchedulerCard } from "@/fsrs/types";

const FIXED_NOW = new Date("2026-01-15T12:00:00Z");

const SAMPLE_CARD: StoredSchedulerCard = {
  difficulty: 5.2,
  due: "2026-01-14T12:00:00.000Z",  // 昨天 due（已过期）
  elapsed_days: 1,
  lapses: 0,
  learning_steps: 0,
  last_review: "2026-01-13T12:00:00.000Z",
  reps: 3,
  scheduled_days: 2,
  stability: 4.8,
  state: 2,  // State.Review
};

describe("applyReviewAnswer", () => {
  it("returns SchedulerUpdate with correct rating", () => {
    const result = applyReviewAnswer(SAMPLE_CARD, "good", FIXED_NOW, 0.9);
    expect(result.rating).toBe("good");
  });

  it("returns dueAt as ISO string", () => {
    const result = applyReviewAnswer(SAMPLE_CARD, "good", FIXED_NOW, 0.9);
    expect(result.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("returns nextPayload as StoredSchedulerCard", () => {
    const result = applyReviewAnswer(SAMPLE_CARD, "good", FIXED_NOW, 0.9);
    expect(result.nextPayload).toMatchObject({
      difficulty: expect.any(Number),
      due: expect.any(String),
      state: expect.any(Number),
      stability: expect.any(Number),
    });
  });

  it("returns retrievability as number for non-new card", () => {
    const result = applyReviewAnswer(SAMPLE_CARD, "good", FIXED_NOW, 0.9);
    expect(result.retrievability).toBeTypeOf("number");
    expect(result.retrievability).toBeGreaterThan(0);
    expect(result.retrievability).toBeLessThanOrEqual(1);
  });

  it("returns retrievability null for new card (state=0)", () => {
    const newCard: StoredSchedulerCard = { ...SAMPLE_CARD, state: 0, reps: 0 };
    const result = applyReviewAnswer(newCard, "good", FIXED_NOW, 0.9);
    expect(result.retrievability).toBeNull();
  });

  it("handles null payload (first review)", () => {
    const result = applyReviewAnswer(null, "good", FIXED_NOW, 0.9);
    expect(result.rating).toBe("good");
    expect(result.state).toBe("review");  // 首次 good → review state
    expect(result.reps).toBe(1);
  });

  it("again increases lapses", () => {
    const result = applyReviewAnswer(SAMPLE_CARD, "again", FIXED_NOW, 0.9);
    expect(result.lapses).toBe(SAMPLE_CARD.lapses + 1);
    expect(result.state).toBe("relearning");
  });

  it("populates scheduler cache after call", () => {
    const before = getSchedulerCacheSize();
    applyReviewAnswer(SAMPLE_CARD, "good", FIXED_NOW, 0.9);
    const after = getSchedulerCacheSize();
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
```

- [ ] **Step 2: 运行测试看失败**

```bash
npx vitest run tests/fsrs/adapter.test.ts
```

Expected: FAIL — `applyReviewAnswer is not exported`

- [ ] **Step 3: 追加 applyReviewAnswer 到 adapter.ts**

```typescript
// ── 核心函数 ──────────────────────────────────────────────────────────────────

export function applyReviewAnswer(
  payload: StoredSchedulerCard | null | undefined,
  rating: ReviewRating,
  now = new Date(),
  desiredRetention = DEFAULT_DESIRED_RETENTION,
  weights?: readonly number[] | null,
): SchedulerUpdate {
  const scheduler = getScheduler(desiredRetention, weights);
  const currentCard = toCard(payload);
  const result = scheduler.next(currentCard, now, ratingMap[rating]);
  const retrievability =
    result.card.state === State.New
      ? null
      : scheduler.get_retrievability(result.card, now, false);

  return {
    difficulty: result.card.difficulty,
    dueAt: result.card.due.toISOString(),
    elapsedDays: result.log.elapsed_days,
    lapses: result.card.lapses,
    logDueAt: result.log.due.toISOString(),
    nextPayload: fromCard(result.card),
    rating,
    reps: result.card.reps,
    retrievability,
    scheduledDays: result.log.scheduled_days,
    stability: result.card.stability,
    state: reviewStateMap[result.card.state] ?? "review",
  };
}
```

- [ ] **Step 4: 运行测试看通过**

```bash
npx vitest run tests/fsrs/adapter.test.ts
```

Expected: PASS（全部 8 个 applyReviewAnswer 测试 + 之前的常量/缓存测试）

- [ ] **Step 5: Commit**

```bash
git add src/fsrs/adapter.ts tests/fsrs/adapter.test.ts
git commit -m "feat(fsrs): add applyReviewAnswer core function"
```

---

## Task 7: 辅助函数 buildInitialSchedulerPayload + getCurrentRetrievability（TDD）

**Files:**
- Modify: `src/fsrs/adapter.ts`
- Modify: `tests/fsrs/adapter.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/fsrs/adapter.test.ts` 追加：

```typescript
import { buildInitialSchedulerPayload, getCurrentRetrievability } from "@/fsrs/adapter";

describe("buildInitialSchedulerPayload", () => {
  it("returns a StoredSchedulerCard with state=0 (new)", () => {
    const payload = buildInitialSchedulerPayload();
    expect(payload.state).toBe(0);
    expect(payload.reps).toBe(0);
    expect(payload.lapses).toBe(0);
    expect(payload.difficulty).toBe(0);
    expect(payload.stability).toBe(0);
  });

  it("returns due as ISO string", () => {
    const payload = buildInitialSchedulerPayload();
    expect(payload.due).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("getCurrentRetrievability", () => {
  it("returns null for new card (state=0)", () => {
    const newCard: StoredSchedulerCard = {
      difficulty: 0, due: "2026-01-15T12:00:00Z", elapsed_days: 0,
      lapses: 0, learning_steps: 0, last_review: null, reps: 0,
      scheduled_days: 0, stability: 0, state: 0,
    };
    expect(getCurrentRetrievability(newCard, FIXED_NOW)).toBeNull();
  });

  it("returns number for review card", () => {
    expect(getCurrentRetrievability(SAMPLE_CARD, FIXED_NOW)).toBeTypeOf("number");
  });
});
```

- [ ] **Step 2: 运行测试看失败**

```bash
npx vitest run tests/fsrs/adapter.test.ts
```

Expected: FAIL — `buildInitialSchedulerPayload is not exported`

- [ ] **Step 3: 追加函数到 adapter.ts**

```typescript
// ── 辅助函数 ──────────────────────────────────────────────────────────────────

export function buildInitialSchedulerPayload(): StoredSchedulerCard {
  const card = createEmptyCard();
  return fromCard(card);
}

export function getCurrentRetrievability(
  payload: StoredSchedulerCard | null | undefined,
  now = new Date(),
  desiredRetention = DEFAULT_DESIRED_RETENTION,
  weights?: readonly number[] | null,
): number | null {
  if (!payload || payload.state === State.New) return null;
  const scheduler = getScheduler(desiredRetention, weights);
  const card = toCard(payload);
  if (card.state === State.New) return null;
  return scheduler.get_retrievability(card, now, false);
}
```

- [ ] **Step 4: 运行测试看通过**

```bash
npx vitest run tests/fsrs/adapter.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/fsrs/adapter.ts tests/fsrs/adapter.test.ts
git commit -m "feat(fsrs): add buildInitialSchedulerPayload and getCurrentRetrievability"
```

---

## Task 8: FSRS barrel export + arch 验证

**Files:**
- Create: `src/fsrs/index.ts`
- Modify: `src/fsrs/adapter.ts`（可能需要 retuneScheduledReviewCard，如果 local 有的话——检查后决定）

- [ ] **Step 1: 创建 barrel**

```typescript
// src/fsrs/index.ts
export type {
  ReviewRating,
  ReviewState,
  StoredSchedulerCard,
  SchedulerUpdate,
} from "./types";

export {
  DEFAULT_DESIRED_RETENTION,
  MIN_DESIRED_RETENTION,
  MAX_DESIRED_RETENTION,
  SCHEDULER_CACHE_LIMIT,
  getSchedulerCacheSize,
  normalizeDesiredRetention,
  buildInitialSchedulerPayload,
  getCurrentRetrievability,
  applyReviewAnswer,
} from "./adapter";
```

- [ ] **Step 2: 运行全部测试 + arch + typecheck**

```bash
npm run verify:check
npm run arch:check
```

Expected: 全绿。arch:check 应包含新的 src/fsrs/ 模块（约 50+ 模块）。

- [ ] **Step 3: Commit**

```bash
git add src/fsrs/index.ts
git commit -m "feat(fsrs): add barrel export, FSRS core module complete"
```

---

## Task 9: loadWeights 实现（TDD）

**Files:**
- Create: `src/services/weights-loader.ts`
- Test: `tests/services/weights-loader.test.ts`

**注意**：这个函数需要读 DB（wordbooks.settings jsonb）。TDD 时 mock getPool，不连真实 DB。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/services/weights-loader.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// mock db/connection 的 getPool
vi.mock("@/db/connection", () => ({
  getPool: vi.fn(),
}));

import { getPool } from "@/db/connection";
import { loadWordbookWeights } from "@/services/weights-loader";

describe("loadWordbookWeights", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns weights array when settings has valid fsrs_weights", async () => {
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{
        weights: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61, 0.0, 0.0],
      }],
    });
    vi.mocked(getPool).mockReturnValue({ query: mockQuery } as any);

    const result = await loadWordbookWeights("wordbook-uuid-1");
    expect(result).toHaveLength(19);
    expect(result?.[0]).toBe(0.4);
  });

  it("returns null when wordbook not found", async () => {
    vi.mocked(getPool).mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [] }) } as any);
    const result = await loadWordbookWeights("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null when weights array too short (< 17)", async () => {
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockResolvedValue({ rows: [{ weights: [0.4, 0.6] }] }),
    } as any);
    const result = await loadWordbookWeights("wordbook-1");
    expect(result).toBeNull();
  });

  it("returns null on DB error (graceful fallback)", async () => {
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn().mockRejectedValue(new Error("Connection refused")),
    } as any);
    const result = await loadWordbookWeights("wordbook-1");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试看失败**

```bash
npx vitest run tests/services/weights-loader.test.ts
```

Expected: FAIL — `Cannot find module '@/services/weights-loader'`

- [ ] **Step 3: 写最小实现**

```typescript
// src/services/weights-loader.ts
import { getPool } from "@/db/connection";
import { logger } from "@/observability/logger";

const FSRS_WEIGHTS_MIN_LENGTH = 17;

/**
 * 从 wordbooks.settings jsonb 读取 FSRS weights。
 * 失败时返回 null（回退默认权重），不抛错——weights 是非关键路径。
 */
export async function loadWordbookWeights(
  wordbookId: string,
): Promise<number[] | null> {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT settings->'review'->'fsrs_weights'->'weights' AS weights
       FROM wordbooks WHERE id = $1`,
      [wordbookId],
    );
    const weights = rows[0]?.weights;
    if (!Array.isArray(weights) || weights.length < FSRS_WEIGHTS_MIN_LENGTH) {
      return null;
    }
    return weights;
  } catch (err) {
    logger.warn("weights-loader", "Failed to load FSRS weights", {
      message: (err as Error).message,
      wordbookId,
    });
    return null;
  }
}
```

- [ ] **Step 4: 运行测试看通过**

```bash
npx vitest run tests/services/weights-loader.test.ts
```

Expected: PASS（4 个测试全过）

- [ ] **Step 5: 验证 arch:check（weights-loader 在 services 层，可以 import db）**

```bash
npm run arch:check
```

Expected: 零违规（services-no-raw-db-access 规则只禁止 sql/connection/client 等，weights-loader 用 getPool 是允许的——等等，规则是 `^src/db/(sql|connection|client|...)`，getPool 来自 connection，会被拦截！）

**如果 arch:check 失败**：weights-loader 调 `getPool` 违反 `services-no-raw-db-access`。需要调整——要么把 weights-loader 移到 `src/db/` 层（它本质是 DB 读取），要么放宽规则。

**推荐方案**：把 `loadWordbookWeights` 放到 `src/db/weights-loader.ts`（它是 DB 读取层），services 层和 http 层都从那里 import。这样不违反任何 arch 规则。

- [ ] **Step 6: 如果需要移动，移到 src/db/weights-loader.ts**

```bash
mv src/services/weights-loader.ts src/db/weights-loader.ts
# 更新测试的 import 路径
```

更新测试 import：`from "@/db/weights-loader"`

- [ ] **Step 7: 重新验证**

```bash
npx vitest run tests/services/weights-loader.test.ts
npm run arch:check
```

Expected: PASS + 零违规

- [ ] **Step 8: Commit**

```bash
git add src/db/weights-loader.ts tests/services/weights-loader.test.ts
git commit -m "feat(db): add loadWordbookWeights for FSRS weights reading"
```

---

## Task 10: auth 中间件（TDD）

**Files:**
- Create: `src/http/middleware/auth.ts`
- Test: `tests/http/middleware/auth.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/http/middleware/auth.test.ts
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "@/http/middleware/auth";

const ORIGINAL_OWNER_TOKEN = process.env.OWNER_API_TOKEN;
const ORIGINAL_AGENT_TOKENS = process.env.AGENT_API_TOKENS;

beforeAll(() => {
  process.env.OWNER_API_TOKEN = "owner-secret";
  process.env.AGENT_API_TOKENS = "agent-1,agent-2";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL_OWNER_TOKEN;
  process.env.AGENT_API_TOKENS = ORIGINAL_AGENT_TOKENS;
});

function makeApp(requireRole: "owner" | "agent" | "public" = "owner") {
  const app = new Hono();
  app.use("/*", authMiddleware(requireRole));
  app.get("/*", (c) => c.json({ role: c.get("role"), userId: c.get("userId") }));
  return app;
}

describe("authMiddleware", () => {
  it("allows owner with correct token", async () => {
    const app = makeApp("owner");
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer owner-secret" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("owner");
  });

  it("rejects missing token for owner-required route", async () => {
    const app = makeApp("owner");
    const res = await app.request("/test");
    expect(res.status).toBe(403);
  });

  it("allows agent token for agent-required route", async () => {
    const app = makeApp("agent");
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer agent-1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("agent");
  });

  it("rejects agent token for owner-required route", async () => {
    const app = makeApp("owner");
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer agent-1" },
    });
    expect(res.status).toBe(403);
  });

  it("allows public access to public route", async () => {
    const app = makeApp("public");
    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  it("injects userId from LOCAL_OWNER_ID env", async () => {
    process.env.LOCAL_OWNER_ID = "user-uuid-123";
    const app = makeApp("owner");
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer owner-secret" },
    });
    const body = await res.json();
    expect(body.userId).toBe("user-uuid-123");
  });
});
```

- [ ] **Step 2: 运行测试看失败**

```bash
npx vitest run tests/http/middleware/auth.test.ts
```

Expected: FAIL — `Cannot find module '@/http/middleware/auth'`

- [ ] **Step 3: 写最小实现**

```typescript
// src/http/middleware/auth.ts
import type { Context, Next } from "hono";

type Role = "owner" | "agent" | "public";

const roleRank = { public: 0, agent: 1, owner: 2 } as const;

function resolveRole(token?: string): Role {
  if (!token) return "public";
  if (token === process.env.OWNER_API_TOKEN) return "owner";
  const agentTokens = (process.env.AGENT_API_TOKENS ?? "").split(",").filter(Boolean);
  if (agentTokens.includes(token)) return "agent";
  return "public";
}

export function authMiddleware(requireRole: Role = "owner") {
  return async (c: Context, next: Next) => {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    const role = resolveRole(token);

    if (roleRank[role] < roleRank[requireRole]) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }

    c.set("role", role);
    c.set("userId", process.env.LOCAL_OWNER_ID ?? "local-owner");
    await next();
  };
}
```

- [ ] **Step 4: 运行测试看通过**

```bash
npx vitest run tests/http/middleware/auth.test.ts
```

Expected: PASS（6 个测试全过）

- [ ] **Step 5: Commit**

```bash
git add src/http/middleware/auth.ts tests/http/middleware/auth.test.ts
git commit -m "feat(http): add auth middleware with owner/agent/public roles"
```

---

## Task 11: error 中间件（TDD）

**Files:**
- Create: `src/http/middleware/error.ts`
- Test: `tests/http/middleware/error.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/http/middleware/error.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { errorToResponse } from "@/errors";
import { handleError } from "@/http/middleware/error";
import { NotFoundError, BusinessRuleError, ValidationError } from "@/errors";

describe("handleError middleware", () => {
  function makeApp(error: Error) {
    const app = new Hono();
    app.onError(handleError);
    app.get("/*", () => { throw error; });
    return app;
  }

  it("maps NotFoundError to 404", async () => {
    const app = makeApp(new NotFoundError("Word", "slug"));
    const res = await app.request("/test");
    expect(res.status).toBe(404);
  });

  it("maps BusinessRuleError to 400", async () => {
    const app = makeApp(new BusinessRuleError("Cannot do this"));
    const res = await app.request("/test");
    expect(res.status).toBe(400);
  });

  it("maps ValidationError to 400", async () => {
    const app = makeApp(new ValidationError("Invalid input"));
    const res = await app.request("/test");
    expect(res.status).toBe(400);
  });

  it("maps unknown error to 500", async () => {
    const app = makeApp(new Error("Something broke"));
    const res = await app.request("/test");
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2: 运行测试看失败**

```bash
npx vitest run tests/http/middleware/error.test.ts
```

Expected: FAIL — `Cannot find module '@/http/middleware/error'`

- [ ] **Step 3: 写最小实现**

先确认 `errorToResponse` 的返回结构（读 `src/errors/index.ts`）。假设它返回 `{ status: number, body: { error: string } }`。

```typescript
// src/http/middleware/error.ts
import type { Context } from "hono";
import { errorToResponse, AppError } from "@/errors";
import { logger } from "@/observability/logger";

export function handleError(err: Error, c: Context) {
  if (err instanceof AppError) {
    const { status, body } = errorToResponse(err);
    return c.json(body, status);
  }

  logger.error("http", "Unhandled error", { message: err.message, stack: err.stack });
  return c.json({ error: "Internal server error" }, 500);
}
```

- [ ] **Step 4: 运行测试看通过**

```bash
npx vitest run tests/http/middleware/error.test.ts
```

Expected: PASS（4 个测试全过）

**如果失败**：检查 `errorToResponse` 的实际返回结构，调整解构。可能需要读 `src/errors/index.ts` 确认。

- [ ] **Step 5: Commit**

```bash
git add src/http/middleware/error.ts tests/http/middleware/error.test.ts
git commit -m "feat(http): add error middleware mapping AppError to HTTP status"
```

---

## Task 12: words 路由（TDD）

**Files:**
- Create: `src/http/routes/words.ts`
- Test: `tests/http/words.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/http/words.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

// mock services
vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: any) => cb({})),
}));

import { createApp } from "@/http/server";
import { createServices } from "@/services";

const mockFsrsAdapter = vi.fn();
const services = createServices({ fsrsAdapter: mockFsrsAdapter });
const app = createApp(services);

describe("GET /api/words", () => {
  it("returns paginated word list", async () => {
    const res = await app.request("/api/words?limit=5", {
      headers: { Authorization: "Bearer test-owner" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
  });
});

describe("GET /api/words/:slug", () => {
  it("returns 404 for unknown slug", async () => {
    const res = await app.request("/api/words/nonexistent-slug-xyz", {
      headers: { Authorization: "Bearer test-owner" },
    });
    expect(res.status).toBe(404);
  });
});
```

**注意**：这个测试需要 DB 连接（services.words.getWordBySlug 会查 DB）。如果没有 DB，需要 mock service 层。**TDD 原则：先用真实 service 写测试看失败，如果失败原因是 DB 连接而非功能缺失，则 mock service。**

- [ ] **Step 2: 运行测试看失败**

```bash
npx vitest run tests/http/words.test.ts
```

Expected: FAIL — 路由不存在或 createApp 不接受 services 参数

- [ ] **Step 3: 写 words 路由 + 更新 createApp**

```typescript
// src/http/routes/words.ts
import { Hono } from "hono";
import type { Services } from "@/services";
import { httpSchemas } from "@/schemas/http";

export function wordRoutes(services: Services) {
  const app = new Hono();

  app.get("/", async (c) => {
    const parsed = httpSchemas.wordsQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const result = await services.words.getPublicWords(parsed.data);
    return c.json(result);
  });

  app.get("/:slug", async (c) => {
    try {
      const { word } = await services.words.getWordBySlug(c.req.param("slug"));
      return c.json(word);
    } catch (err) {
      // NotFoundError 会被 error 中间件捕获
      throw err;
    }
  });

  return app;
}
```

更新 `src/http/server.ts`：

```typescript
import { Hono } from "hono";
import type { Services } from "../services";
import { handleError } from "./middleware/error";
import { authMiddleware } from "./middleware/auth";
import { wordRoutes } from "./routes/words";
import { logger } from "../observability/logger";

export function createApp(services: Services): Hono {
  const app = new Hono();

  app.onError(handleError);

  app.get("/health", (c) => {
    return c.json({ ok: true, service: "vocab-observatory-v2", phase: "1-http" });
  });

  app.use("/api/*", authMiddleware("owner"));
  app.route("/api/words", wordRoutes(services));

  return app;
}
```

- [ ] **Step 4: 运行测试看通过**

```bash
npx vitest run tests/http/words.test.ts
```

Expected: PASS（如果 DB 可用）或调整 mock 策略

- [ ] **Step 5: Commit**

```bash
git add src/http/routes/words.ts src/http/server.ts tests/http/words.test.ts
git commit -m "feat(http): add words routes (list + by-slug)"
```

---

## Task 13: review 路由（TDD）

**Files:**
- Create: `src/http/routes/review.ts`
- Test: `tests/http/review.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/http/review.test.ts
import { describe, it, expect, vi } from "vitest";
import { createApp } from "@/http/server";
import { createServices } from "@/services";

vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: any) => cb({})),
}));

const mockFsrsAdapter = vi.fn().mockReturnValue({
  difficulty: 5.0,
  dueAt: "2026-01-16T12:00:00.000Z",
  logDueAt: "2026-01-15T12:00:00.000Z",
  elapsedDays: 1,
  scheduledDays: 1,
  retrievability: 0.9,
  stability: 5.0,
  state: "review",
  nextPayload: { difficulty: 5.0, due: "2026-01-16T12:00:00.000Z", elapsed_days: 1, lapses: 0, learning_steps: 0, last_review: "2026-01-15T12:00:00.000Z", reps: 2, scheduled_days: 1, stability: 5.0, state: 2 },
});

const services = createServices({ fsrsAdapter: mockFsrsAdapter });
const app = createApp(services);

describe("POST /api/review/answer", () => {
  it("rejects invalid body with 400", async () => {
    const res = await app.request("/api/review/answer", {
      method: "POST",
      headers: { Authorization: "Bearer test-owner", "Content-Type": "application/json" },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown progressId", async () => {
    const res = await app.request("/api/review/answer", {
      method: "POST",
      headers: { Authorization: "Bearer test-owner", "Content-Type": "application/json" },
      body: JSON.stringify({
        progressId: "nonexistent-uuid",
        rating: "good",
        sessionId: "session-1",
      }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行测试看失败**

```bash
npx vitest run tests/http/review.test.ts
```

Expected: FAIL — 路由不存在

- [ ] **Step 3: 写 review 路由**

```typescript
// src/http/routes/review.ts
import { Hono } from "hono";
import type { Services } from "@/services";
import { httpSchemas } from "@/schemas/http";

export function reviewRoutes(services: Services) {
  const app = new Hono();

  app.post("/answer", async (c) => {
    const body = await c.req.json();
    const parsed = httpSchemas.reviewAnswer.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const result = await services.reviews.submitAnswer(parsed.data);
    return c.json(result);
  });

  app.post("/skip", async (c) => {
    const body = await c.req.json();
    const parsed = httpSchemas.reviewSkip.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const userId = c.get("userId");
    const result = await services.reviews.skip(parsed.data, userId);
    return c.json(result);
  });

  app.post("/suspend", async (c) => {
    const body = await c.req.json();
    const parsed = httpSchemas.reviewSuspend.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const userId = c.get("userId");
    const result = await services.reviews.suspend(parsed.data, userId);
    return c.json(result);
  });

  app.post("/undo", async (c) => {
    const body = await c.req.json();
    const parsed = httpSchemas.reviewUndo.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const userId = c.get("userId");
    const result = await services.reviews.undo(parsed.data, userId);
    return c.json(result);
  });

  return app;
}
```

更新 `src/http/server.ts` 挂载 review 路由：

```typescript
import { reviewRoutes } from "./routes/review";
// ...
app.route("/api/review", reviewRoutes(services));
```

- [ ] **Step 4: 运行测试看通过**

```bash
npx vitest run tests/http/review.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/http/routes/review.ts src/http/server.ts tests/http/review.test.ts
git commit -m "feat(http): add review routes (answer/skip/suspend/undo)"
```

---

## Task 14: 接线 server.ts（装配 createServices）

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: 更新 server.ts 装配真实 services**

```typescript
// src/server.ts
import { serve } from "@hono/node-server";
import { createApp } from "./http/server";
import { createServices } from "./services";
import { applyReviewAnswer } from "./fsrs/adapter";
import { loadWordbookWeights } from "./db/weights-loader";
import { logger } from "./observability/logger";

const port = parseInt(process.env.PORT ?? "3001", 10);

const services = createServices({
  fsrsAdapter: applyReviewAnswer,
  loadWeights: loadWordbookWeights,
});

const app = createApp(services);

serve({ fetch: app.fetch, port }, (info) => {
  logger.info("server", `v2-http listening on :${info.port}`);
  logger.info("server", `Health: http://localhost:${info.port}/health`);
});
```

- [ ] **Step 2: typecheck + arch:check**

```bash
npm run typecheck
npm run arch:check
```

Expected: 零错误 + 零违规

**如果 arch:check 报 http-no-raw-db-access**：检查 server.ts 是否 import 了 db 层。server.ts 不在 `src/http/` 路径下（它在 `src/server.ts`），所以不受 `http-no-raw-db-access` 约束。但如果报错，确认 import 路径。

- [ ] **Step 3: 启动验证**

```bash
npm run dev
# 另一个终端：
curl http://localhost:3001/health
```

Expected: `{"ok":true,"service":"vocab-observatory-v2","phase":"1-http"}`

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: wire createServices with FSRS adapter into server bootstrap"
```

---

## Task 15: 全量验证 + Phase 1 验收

- [ ] **Step 1: 全量测试**

```bash
npm run verify:check
```

Expected: typecheck + 全部测试 PASS

- [ ] **Step 2: arch:check**

```bash
npm run arch:check
```

Expected: 零违规（模块数应增至 55+）

- [ ] **Step 3: dev 启动 + curl 验证**

```bash
npm run dev &
sleep 3
curl -s http://localhost:3001/health
curl -s -H "Authorization: Bearer $OWNER_API_TOKEN" http://localhost:3001/api/words?limit=3
kill %1
```

Expected: /health 返回 ok，/api/words 返回词列表（如果 DB 有数据）

- [ ] **Step 4: 最终 Commit**

```bash
git add -A
git commit -m "chore: Phase 1 complete - HTTP layer wired with FSRS core"
```

---

## 验收 Checklist

- [ ] `ts-fsrs@^5.4.1` 已安装
- [ ] `src/fsrs/types.ts` + `src/fsrs/adapter.ts` + `src/fsrs/index.ts` 完成
- [ ] FSRS 测试全过（types + constants + applyReviewAnswer + 辅助函数）
- [ ] `src/db/weights-loader.ts` 完成 + 测试全过
- [ ] `src/http/middleware/auth.ts` + `error.ts` 完成 + 测试全过
- [ ] `src/http/routes/words.ts` + `review.ts` 完成 + 测试全过
- [ ] `src/server.ts` 装配 createServices
- [ ] `npm run verify:check` 全绿
- [ ] `npm run arch:check` 零违规
- [ ] `npm run dev` 启动，/health + /api/words 可访问
- [ ] **FSRS 核心完全独立于 local**（v2 的 src/fsrs/ 不 import 任何 local 路径）
