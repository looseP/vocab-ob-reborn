# Self-Growing 后端地基深度设计

- **Status**: Draft / 待 review
- **Date**: 2026-07-06
- **Purpose**: 基于事实核查的 v2 真实就绪度，给出可执行的地基实施设计
- **依赖文档**:
  - `2026-07-06-self-growing-knowledge-chain.md`（架构决策）
  - `2026-07-06-self-growing-backend-implementation.md`（工程方案）
- **核查基础**: v2 服务层 11 项缺口事实核查（见本文附录 A）

---

## 设计原则

1. **地基先于上层**：HTTP 层 / L2 扩展 / Agent 共建都必须建立在一个可测试、可验证、可回滚的稳定地基上
2. **每个 Phase 可独立验证**：不搞大爆炸式交付，每个阶段有明确的"done 标准"
3. **不破坏现有 v2 架构**：Clean Architecture 已验证干净（ADR-001 + dependency-cruiser），新层必须遵守同样约束
4. **缺口驱动**：每个实施项对应一个已核查的缺口，不凭空设计

---

## 缺口全景（地基要填的 11 个坑）

基于事实核查，从"加 Hono HTTP 层"的角度，缺口分三类：

### A 类：必须先填的地基缺口（Phase 0）

| # | 缺口 | 影响 | 修复成本 |
|---|------|------|---------|
| 1 | 迁移工作流未脚本化 | 无法创建新表，整个 self-growing 无法开始 | 小（加 3 个 npm script） |
| 2 | dependency-cruiser 未约束 http 层 | 新层可能绕过 service 直连 db，破坏 Clean Architecture | 小（加 1 条规则） |
| 3 | 无 server bootstrap 入口 | v2 是纯库，无法独立运行 | 小（新建 src/server.ts） |

### B 类：接线缺口（Phase 1）

| # | 缺口 | 影响 | 修复成本 |
|---|------|------|---------|
| 4 | FSRS adapter 类型不匹配 | ReviewService 无法接线，复习功能跑不通 | 中（薄转换层 + 测试） |
| 5 | loadWeights 两边都没实现 | per-wordbook 优化权重失效，复习用默认权重 | 中（新建 weights 读取函数） |
| 6 | HTTP 框架从零 | 无 hono/任何 server 依赖 | 中（安装 + 搭建路由骨架） |
| 7 | submitAnswer 无 userId 入参 | 鉴权/归属校验缺失 | 中（HTTP 层间接校验 或 repo 补方法） |

### C 类：功能缺口（Phase 2+）

| # | 缺口 | 影响 | 修复成本 |
|---|------|------|---------|
| 8 | 7 张新表不存在 | L2 扩展/关系图/资产/双轨复习/同步/outbox/导入板 全无法实现 | 大（schema 定义 + migration） |
| 9 | 3 个 service 缺封装 | highlights/annotations/sessions 无 service，HTTP 层无法规范暴露 | 中（补 3 个 service） |
| 10 | StatsService.computeForecast 占位 | dashboard 预测不准 | 中（补 repo 查询） |
| 11 | HTTP 测试基础为零 | 无法验证路由正确性 | 中（Hono app.request() 测试夹具） |

---

## Phase 0：地基补缺（让 v2 可扩展）

**目标**：填掉 A 类 3 个缺口，让 v2 具备"创建新表 + 加新层 + 独立运行"的能力。
**Done 标准**：`npm run db:generate` 能生成 migration；`npm run arch:check` 约束 http 层；`npm run dev` 能启动（即使只有 /health）。

### 0.1 迁移工作流脚本化

**缺口**：drizzle.config.ts 就绪，但 package.json 无 `db:generate`/`db:migrate`/`db:push` 脚本。当前只有 `drizzle/0000_woozy_taskmaster.sql` 一个 introspect 快照。

**实施**：

```jsonc
// package.json scripts 新增
"db:generate": "drizzle-kit generate --config drizzle.config.ts",
"db:migrate": "drizzle-kit migrate --config drizzle.config.ts",
"db:push": "drizzle-kit push --config drizzle.config.ts",
"db:studio": "drizzle-kit studio --config drizzle.config.ts",
"dev": "tsx watch src/server.ts"
```

**注意**：`drizzle-kit generate` 会对比 `src/db/schema.ts` 和 `drizzle/` 现有 migration，生成 diff SQL。第一次跑前要确认 `drizzle/0000_woozy_taskmaster.sql` 是当前 DB 的准确快照（事实核查确认是的——36 个 local migration 的累积结果）。

**验证**：`npm run db:generate` 在不修改 schema.ts 的情况下应该输出"No schema changes"。如果输出了 diff，说明 schema.ts 和实际 DB 有偏差，需要先对齐。

### 0.2 dependency-cruiser 约束 http 层

**缺口**：现有 `.dependency-cruiser.cjs` 约束了 db/repositories/services/domain 的依赖方向，但**没有 http 层规则**。新建 `src/http/` 后若无约束，开发者可能直接 `import { getPool } from "@/db/connection"`，绕过 service 层。

**实施**：在 `.dependency-cruiser.cjs` 的 `forbidden` 数组追加规则：

```js
// 新增规则：http 层只能调 service，不能直连 db/repositories
{
  name: 'http-no-raw-db-access',
  severity: 'error',
  comment: 'http 层必须通过 service 访问数据，不得直连 db/repositories — ADR-001',
  from: { path: '^src/http/' },
  to: { path: '^src/(db|repositories)/' },
},
// http 层可以 import schemas/errors/domain（用于类型和错误映射）
// 这条规则只禁止 db 和 repositories
```

**为什么允许 http → schemas/errors/domain**：
- `schemas/http` 的 zod schema 用于请求校验（http 层职责）
- `errors` 的 `errorToResponse` 用于错误映射（http 层职责）
- `domain` 的类型用于响应 DTO（http 层职责）

**验证**：`npm run arch:check` 在加规则后应仍零违规（因为 http 层还不存在）。等 Phase 1 建 http 层后，故意写一个 `import { getPool }` 测试规则是否拦截。

### 0.3 server bootstrap 入口

**缺口**：`src/index.ts` 是纯库导出，无启动入口。需要新建 `src/server.ts` 做 `createApp(services).listen()`。

**实施**：

```typescript
// src/server.ts
import { createApp } from "./http/server";
import { createServices } from "./services";
import { applyReviewAnswerBridge } from "./http/fsrs-bridge";
import { loadWordbookWeights } from "./http/weights-loader";
import { logger } from "./observability/logger";

const port = parseInt(process.env.PORT ?? "3001", 10);

const services = createServices({
  fsrsAdapter: applyReviewAnswerBridge,
  loadWeights: loadWordbookWeights,
});

const app = createApp(services);

app.listen(port, () => {
  logger.info("server", `v2-http listening on :${port}`);
});
```

**注意**：`createApp` 和 `fsrs-bridge`、`weights-loader` 在 Phase 1 实现。Phase 0 先建 `src/server.ts` 的骨架，让它能 import 到 `createServices`（已就绪），即使 `createApp` 还是空壳。

**验证**：`npm run dev` 启动不报 import 错误（即使路由只有 /health）。

### Phase 0 验收 checklist

- [ ] `npm run db:generate` 输出 "No schema changes"（或生成正确的 diff）
- [ ] `npm run db:push` 能把 schema 同步到 DB（在测试 DB 上验证）
- [ ] `.dependency-cruiser.cjs` 有 `http-no-raw-db-access` 规则
- [ ] `npm run arch:check` 零违规
- [ ] `src/server.ts` 存在且可 import
- [ ] `npm run dev` 启动不崩溃（即使只有 /health 端点）
- [ ] `npm run typecheck` 通过

---

## Phase 1：HTTP 层接线（让 v2 能服务化）

**目标**：填掉 B 类 4 个缺口，让 v2-http 提供基础只读 + 复习 API，与 local 共享同一 PostgreSQL。
**Done 标准**：`curl localhost:3001/api/open/words/abound` 返回词卡数据；`curl -X POST localhost:3001/api/review/answer` 能完成一次复习。

### 1.1 安装 Hono + 测试依赖

```bash
npm install hono
# zod v4 兼容性：不用 @hono/zod-validator（可能不兼容 zod v4），手写 parse 中间件
npm install -D @hono/vitest-dev  # 可选，或直接用 vitest + app.request()
```

**zod v4 兼容性策略**：不依赖 `@hono/zod-validator`，在路由内手写 `const parsed = schema.safeParse(body); if (!parsed.success) return c.json({error: ...}, 400)`。这更可控，且 v2 的 http schema 已经用 zod v4 写好。

### 1.2 HTTP 层目录结构

```
src/http/
├── server.ts              # createApp(services) 工厂，返回 Hono 实例
├── routes/
│   ├── health.ts          # GET /health
│   ├── words.ts           # GET /api/open/words, GET /api/open/words/:slug
│   ├── review.ts          # POST /api/review/answer, skip, suspend, undo
│   ├── notes.ts           # GET/PUT /api/notes/:wordId
│   ├── wordbooks.ts       # CRUD /api/wordbooks
│   └── stats.ts           # GET /api/stats/dashboard
├── middleware/
│   ├── auth.ts            # Token 鉴权（owner/agent/public）
│   ├── error.ts           # errorToResponse → HTTP 状态码映射
│   └── validate.ts        # zod safeParse 包装
├── fsrs-bridge.ts         # local applyReviewAnswer → v2 FsrsAdapterFn 转换
├── weights-loader.ts      # wordbooks.settings → fsrs weights 读取
└── types.ts               # Hono 变量类型（services, role）
```

### 1.3 FSRS adapter 转换层（缺口 #4）

**问题**：local 的 `applyReviewAnswer` 返回 `SchedulerUpdate`（多 lapses/reps/rating，nextPayload 类型名义不同），不能直接当 v2 的 `FsrsAdapterFn` 传。

**实施**：

```typescript
// src/http/fsrs-bridge.ts
import { applyReviewAnswer } from "../../../vocab-observatory-local/lib/review/fsrs-adapter";
import type { FsrsAdapterFn } from "../services/review.service";
import type { Json } from "../domain";
import type { ReviewRating } from "../schemas/http";

export const applyReviewAnswerBridge: FsrsAdapterFn = (
  schedulerPayload,
  rating,
  now,
  desiredRetention,
  weights,
) => {
  const result = applyReviewAnswer(
    schedulerPayload as any,  // Json → StoredSchedulerCard（运行时结构兼容）
    rating as ReviewRating,
    now,
    desiredRetention,
    weights as readonly number[] | null,
  );

  // 裁掉 v2 不需要的字段，nextPayload 当 Json 传出
  return {
    difficulty: result.difficulty,
    dueAt: result.dueAt,
    logDueAt: result.logDueAt,
    elapsedDays: result.elapsedDays,
    scheduledDays: result.scheduledDays,
    retrievability: result.retrievability,
    stability: result.stability,
    state: result.state as any,  // local 的 ReviewState ⊂ v2 的 ReviewState
    nextPayload: result.nextPayload as unknown as Json,
  };
};
```

**关键决策**：这个 bridge 文件**物理上可以放在 v2 里**（通过相对路径 import local），但更干净的做法是把 `applyReviewAnswer` 的核心逻辑抽成一个**纯函数包**，v2 和 local 都 import 它。不过这是后续重构，Phase 1 先用相对路径 import 跑通。

**替代方案**：如果不想 v2 依赖 local 的路径，可以把 `fsrs-adapter.ts` 复制到 v2 的 `src/fsrs/` 下（代码重复但解耦）。Phase 1 推荐复制——因为 local 的 fsrs-adapter 依赖 local 的 types（StoredSchedulerCard 等），复制时需要清理依赖。

**验证**：复用 local 的 3 个 fsrs 测试（fsrs-adapter.test.ts 等），在 v2 里跑 bridge 的转换正确性。

### 1.4 loadWeights 实现（缺口 #5）

**问题**：v2 的 `createServices` 缺省 `loadWeights` 返回 null，local 也无对应函数。`wordbooks.settings` jsonb 列存在（schema.ts:344）但无读取 fsrs weights 的代码。

**实施**：

```typescript
// src/http/weights-loader.ts
import { getPool } from "../db/connection";
import { logger } from "../observability/logger";

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
    if (!Array.isArray(weights) || weights.length < 17) return null;
    return weights;
  } catch (err) {
    logger.warn("weights-loader", "Failed to load FSRS weights", err);
    return null;  // 回退默认权重
  }
}
```

**注意**：这个函数**直连 db**——但它不是 http 层的一部分，而是**服务装配时的依赖注入**。它属于 `src/http/weights-loader.ts` 而非 `src/http/routes/`，dependency-cruiser 的 `http-no-raw-db-access` 规则应该**豁免这个文件**（或把它放到 `src/services/weights-loader.ts`，让 http 层 import service 层）。

**更干净的位置**：放 `src/services/weights-loader.ts`，http 层的 server.ts import 它注入 createServices。这样不违反 dependency-cruiser 规则。

### 1.5 鉴权中间件 + userId 校验（缺口 #7）

**问题**：`submitAnswer` 无 userId 入参，归属/鉴权需 HTTP 层处理。

**实施**：

```typescript
// src/http/middleware/auth.ts
import type { Context, Next } from "hono";

type Role = "owner" | "agent" | "public";

const OWNER_TOKEN = process.env.OWNER_API_TOKEN;
const AGENT_TOKENS = (process.env.AGENT_API_TOKENS ?? "").split(",").filter(Boolean);

export function resolveRole(token?: string): Role {
  if (!token) return "public";
  if (token === OWNER_TOKEN) return "owner";
  if (AGENT_TOKENS.includes(token)) return "agent";
  return "public";
}

export function authMiddleware(requireRole: Role = "owner") {
  return async (c: Context, next: Next) => {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    const role = resolveRole(token);
    if (roleRank(role) < roleRank(requireRole)) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
    c.set("role", role);
    c.set("userId", process.env.LOCAL_OWNER_ID ?? "local-owner");  // 本地单用户模式
    await next();
  };
}

function roleRank(r: Role): number {
  return { public: 0, agent: 1, owner: 2 }[r];
}
```

**userId 来源**：本地单用户模式用 `LOCAL_OWNER_ID` 环境变量（复用 local 的 `LOCAL_OWNER` 模式）。submitAnswer 虽然不要 userId，但 skip/suspend/undo 需要——HTTP 层从中间件注入 `c.get("userId")` 传入。

### 1.6 createApp 工厂

```typescript
// src/http/server.ts
import { Hono } from "hono";
import type { Services } from "../services";
import { healthRoutes } from "./routes/health";
import { wordRoutes } from "./routes/words";
import { reviewRoutes } from "./routes/review";
import { noteRoutes } from "./routes/notes";
import { wordbookRoutes } from "./routes/wordbooks";
import { statsRoutes } from "./routes/stats";
import { errorMiddleware } from "./middleware/error";
import { authMiddleware } from "./middleware/auth";

export function createApp(services: Services) {
  const app = new Hono();

  // 全局错误处理
  app.onError(errorMiddleware);

  // 无需鉴权
  app.route("/", healthRoutes());

  // 需要鉴权的 API
  app.use("/api/*", authMiddleware("owner"));
  app.route("/api/words", wordRoutes(services));
  app.route("/api/review", reviewRoutes(services));
  app.route("/api/notes", noteRoutes(services));
  app.route("/api/wordbooks", wordbookRoutes(services));
  app.route("/api/stats", statsRoutes(services));

  return app;
}
```

### 1.7 路由示例（words 只读 + review answer）

```typescript
// src/http/routes/words.ts
import { Hono } from "hono";
import type { Services } from "../../services";
import { httpSchemas } from "../../schemas/http";

export function wordRoutes(services: Services) {
  const app = new Hono();

  app.get("/", async (c) => {
    const parsed = httpSchemas.wordsQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const result = await services.words.getPublicWords(parsed.data);
    return c.json(result);
  });

  app.get("/:slug", async (c) => {
    const word = await services.words.getWordBySlug(c.req.param("slug"));
    return word ? c.json(word) : c.json({ error: "Not found" }, 404);
  });

  return app;
}

// src/http/routes/review.ts
import { Hono } from "hono";
import type { Services } from "../../services";
import { httpSchemas } from "../../schemas/http";

export function reviewRoutes(services: Services) {
  const app = new Hono();

  app.post("/answer", async (c) => {
    const body = await c.req.json();
    const parsed = httpSchemas.reviewAnswer.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const result = await services.reviews.submitAnswer(parsed.data);
      return c.json(result);
    } catch (err) {
      return errorToResponse(err);  // NotFoundError→404, BusinessRuleError→400
    }
  });

  // skip / suspend / undo 类似，多传 userId
  app.post("/skip", async (c) => {
    const body = await c.req.json();
    const parsed = httpSchemas.reviewSkip.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const userId = c.get("userId");
    const result = await services.reviews.skip(parsed.data, userId);
    return c.json(result);
  });

  return app;
}
```

### 1.8 HTTP 测试夹具

```typescript
// tests/http/words.test.ts
import { describe, it, expect, vi } from "vitest";
import { createApp } from "@/http/server";
import { createServices } from "@/services";

// 复用 review-service.test.ts 的 mock 模式
vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb) => cb({})),
}));

const mockFsrsAdapter = vi.fn();
const services = createServices({ fsrsAdapter: mockFsrsAdapter });
const app = createApp(services);

describe("GET /api/words/:slug", () => {
  it("returns 404 for unknown slug", async () => {
    const res = await app.request("/api/words/nonexistent", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(404);
  });
});
```

**Hono 优势**：`app.request()` 内置测试客户端，零依赖，不需要 supertest。

### Phase 1 验收 checklist

- [ ] `npm install hono` 成功
- [ ] `src/http/` 目录存在且通过 `npm run arch:check`（http-no-raw-db-access 规则生效）
- [ ] `src/http/fsrs-bridge.ts` 转换正确（fsrs 测试通过）
- [ ] `src/services/weights-loader.ts` 能从 DB 读 weights（或回退 null）
- [ ] `npm run dev` 启动，`curl localhost:3001/health` 返回 `{"ok":true}`
- [ ] `curl localhost:3001/api/words/abound` 返回词卡数据
- [ ] `curl -X POST localhost:3001/api/review/answer -d '{...}'` 完成一次复习
- [ ] HTTP 测试夹具跑通（至少 1 个 words 路由测试 + 1 个 review 路由测试）
- [ ] `npm run typecheck` 通过
- [ ] `npm run verify` 全绿

---

## Phase 2：新表 + L2 扩展闭环

**目标**：填掉 C 类缺口 #8（新表），跑通"L1 种子 → L2 扩展（LLM 生成 + 用户勾选）→ L2 重卡"最小闭环。
**Done 标准**：能为一个词生成 L2 搭配草稿，用户勾选后写入 `word_l2_content`，触发 L2 重卡。

### 2.1 新表 schema 定义（缺口 #8）

在 `src/db/schema.ts` 追加 7 张表的 drizzle 定义：

```typescript
// 按实施优先级排序——L2 闭环只需要前 2 张，其余后补

// === Phase 2 立即需要 ===
export const wordL2Content = pgTable("word_l2_content", {
  id: uuid("id").primaryKey().defaultRandom(),
  wordId: uuid("word_id").notNull().references(() => words.id),
  field: text("field").notNull(),  // collocation/corpus/synonym/antonym
  content: jsonb("content").notNull(),
  source: text("source").notNull(),  // 考研/雅思/作文/长难句/manual/agent:xxx
  sourceRef: uuid("source_ref"),  // 关联 learning_assets.id
  approvedBy: text("approved_by").default("user"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  isActive: boolean("is_active").default(true),
});

export const userWordL2Progress = pgTable("user_word_l2_progress", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  wordId: uuid("word_id").notNull().references(() => words.id),
  l2Stability: real("l2_stability"),
  l2Difficulty: real("l2_difficulty"),
  l2Retrievability: real("l2_retrievability"),
  l2DueAt: timestamp("l2_due_at", { withTimezone: true }),
  l2LastReviewedAt: timestamp("l2_last_reviewed_at", { withTimezone: true }),
  l2ReviewCount: integer("l2_review_count").default(0),
  l2Weak: boolean("l2_weak").default(false),
  l3Pending: boolean("l3_pending").default(false),
  l3SelfAssessments: jsonb("l3_self_assessments").default([]),
  predictedRetrievability: real("predicted_retrievability"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  uniqueUserWord: uniqueIndex().on(t.userId, t.wordId),
}));

// === Phase 3+ 后补 ===
// export const wordRelations = ...
// export const wordRelationProposals = ...
// export const learningAssets = ...
// export const learningAssetWords = ...
// export const syncOutbox = ...
// export const importTray = ...
```

**生成 migration**：

```bash
npm run db:generate  # 生成 drizzle/0001_self_growing_l2.sql
npm run db:migrate    # 应用到 DB
```

### 2.2 L2 content repository + service

```typescript
// src/repositories/l2content.repository.ts
export class L2ContentRepository extends BaseRepository {
  async insert(data: NewL2Content): Promise<L2Content> { ... }
  async findByWord(wordId: string, field?: string): Promise<L2Content[]> { ... }
  async softDelete(id: string): Promise<void> { ... }
  // ... refreshWordL2Cache 调用
}

// src/services/l2content.service.ts
export class L2ContentService {
  constructor(
    private l2Repo: L2ContentRepository,
    private wordsRepo: WordRepository,
  ) {}

  async extendL2(params: {
    wordId: string;
    field: string;
    content: unknown;
    source: string;
  }): Promise<void> {
    return withTransaction(async (tx) => {
      const repos = createRepositories(tx);
      // 1. 写 word_l2_content
      await repos.l2content.insert({ ...params });
      // 2. 刷新 words 表 JSONB 缓存
      await this.refreshL2Cache(tx, params.wordId);
      // 3. 重算 content_hash + L2 重卡（只触发 L2，不影响 L1）
      await this.triggerL2Recheck(tx, params.wordId);
    });
  }

  private async refreshL2Cache(tx: PoolClient, wordId: string) {
    // 聚合 word_l2_content → words.collocations 等 JSONB 列
  }

  private async triggerL2Recheck(tx: PoolClient, wordId: string) {
    // 更新 user_word_l2_progress.l2_due_at = now()
    // 不动 user_word_progress（L1 隔离）
  }
}
```

### 2.3 LLM provider 抽象（缺口 #6 的 LLM 部分）

```typescript
// src/llm/provider.ts
export interface LlmProvider {
  generate(prompt: string, config?: GenerationConfig): Promise<string>;
}

export class OpenAIProvider implements LlmProvider { ... }
export class AnthropicProvider implements LlmProvider { ... }
export class OllamaProvider implements LlmProvider { ... }  // 离线

// src/llm/generate.ts
export async function generateL2Draft(
  word: Word,
  config: UserL2Config,
  provider: LlmProvider,
): Promise<L2ContentDraft> { ... }
```

### 2.4 L2 扩展 HTTP 路由

```typescript
// src/http/routes/extend.ts
app.post("/words/:slug/extend", async (c) => {
  const slug = c.req.param("slug");
  const { field, source } = await c.req.json();

  // 1. 查词
  const { word } = await services.words.getWordBySlug(slug);

  // 2. 调 LLM 生成草稿（或调词典 API）
  const draft = await generateL2Draft(word, userConfig, llmProvider);

  // 3. 返回草稿给用户勾选（不直接写入）
  return c.json({ draft });
});

app.post("/words/:slug/extend/confirm", async (c) => {
  const slug = c.req.param("slug");
  const { field, content, source } = await c.req.json();

  // 用户勾选后确认写入
  await services.l2content.extendL2({ wordId, field, content, source });
  return c.json({ ok: true });
});
```

### Phase 2 验收 checklist

- [ ] `npm run db:generate` 生成 0001 migration，含 word_l2_content + user_word_l2_progress 两张表
- [ ] `npm run db:migrate` 成功应用到测试 DB
- [ ] `src/repositories/l2content.repository.ts` 通过 requireTx 测试
- [ ] `src/services/l2content.service.ts` 的 extendL2 事务正确（写 l2_content + 刷缓存 + 触发 L2 重卡）
- [ ] **L1 隔离验证**：extendL2 后 `user_word_progress` 不变，`user_word_l2_progress.l2_due_at = now()`
- [ ] LLM provider 抽象层就绪（至少 Ollama provider 可跑）
- [ ] `POST /api/words/abound/extend` 返回 L2 草稿
- [ ] `POST /api/words/abound/extend/confirm` 写入成功
- [ ] `npm run verify` 全绿

---

## Phase 3+：后续阶段（概要）

按 backend-implementation 文档的 Phase 3-6，但每阶段都先填对应缺口：

| Phase | 内容 | 前置缺口 |
|-------|------|---------|
| 3 | 文件系统对接（DB→vault） | sync_outbox 表 + markdown-renderer |
| 4 | Obsidian 插件扩展 | 插件加 pull 能力 |
| 5 | Agent 共建（MCP + 关系图） | word_relations + word_relation_proposals 表 |
| 6 | 跨词书 L2 共存 | word_l2_content 的 source 标签标准化 |
| 7 | L0 冷启动 | import_tray 表 + L1 种子模板 skill |
| 8 | 学习资产 | learning_assets + learning_asset_words 表 |
| 9 | 补 3 个 service | highlights/annotations/sessions |
| 10 | StatsService.computeForecast 补真实查询 | stats repo 新方法 |

---

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| zod v4 与 Hono 集成问题 | 中 | 中 | 不用 @hono/zod-validator，手写 safeParse |
| FSRS bridge 类型转换遗漏字段 | 低 | 高 | 复用 local 的 3 个 fsrs 测试验证 |
| drizzle-kit generate 生成意外 diff | 中 | 中 | Phase 0 先在测试 DB 验证"No schema changes" |
| dependency-cruiser 误报 http 层 | 低 | 低 | Phase 0 测试规则，必要时调整 path 正则 |
| content_hash 双轨漂移逻辑复杂 | 高 | 高 | Phase 2 严格隔离 L1/L2 重卡，测试覆盖 |
| LLM provider 离线（Ollama）未配置 | 中 | 中 | Phase 2 先用 mock provider，Ollama 后接 |

---

## 附录 A：v2 服务层事实核查结论（11 项缺口来源）

### 能直接用（5 项）
1. Service 工厂 + 5 个 service 全部就绪（createServices 返回 words/reviews/notes/wordbooks/stats）
2. HTTP 输入 schema 已就绪（schemas/http 用 zod v4 定义全套）
3. 错误→HTTP 映射就绪（errorToResponse: NotFoundError→404, BusinessRuleError→400）
4. Repository tx 分层正确（写 requireTx，读可 pool）
5. 测试 mock 模板可复用（vi.mock transaction + factory）

### 缺口（11 项，详见上文缺口全景表）
- A 类（Phase 0）：迁移脚本化 / dependency-cruiser http 规则 / server 入口
- B 类（Phase 1）：FSRS bridge / loadWeights / Hono 安装 / userId 鉴权
- C 类（Phase 2+）：7 张新表 / 3 个 service / computeForecast / HTTP 测试夹具

### 关键文件路径
- v2 工厂：`src/services/index.ts`（createServices）
- v2 schema：`src/db/schema.ts`（drizzle 定义，20 张现有表）
- v2 HTTP schema：`src/schemas/http/index.ts`（zod v4 全套）
- v2 错误映射：`src/errors/index.ts`（errorToResponse）
- v2 测试 mock 模板：`tests/review-service.test.ts:14-19`
- local FSRS adapter：`vocab-observatory-local/lib/review/fsrs-adapter.ts:236`（applyReviewAnswer）
- local migrations：`vocab-observatory-local/supabase/migrations/`（36 个 SQL）
- drizzle config：`drizzle.config.ts`
- dependency-cruiser：`.dependency-cruiser.cjs`

---

## 下一步

等用户 review：
1. Phase 0 的 3 个地基补缺是否同意（迁移脚本 / arch 规则 / server 入口）
2. Phase 1 的 Hono 接线方案是否同意
3. FSRS bridge 是复制还是相对路径 import（影响 v2 对 local 的依赖关系）
4. 是否立即开始 Phase 0 实施
