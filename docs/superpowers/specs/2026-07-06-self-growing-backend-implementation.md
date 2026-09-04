# Self-Growing 后端工程实现设计

- **Status**: Draft / 探索阶段
- **Date**: 2026-07-06
- **Purpose**: 回答四个工程问题——后端怎么实现、文件系统怎么对接、持久化稳定性怎么保证、Obsidian 双向同步怎么设计
- **Context**: 基于后端架构调研（v2 未接线、Obsidian 单向、DB→md 渲染器空白）

---

## 现状正视（调研结论）

| 维度 | 现状 | 对 self-growing 的含义 |
|------|------|----------------------|
| v2 服务层 | 已就绪（事务/repo/service/错误体系），但**无 HTTP 层，未被 local import** | 需要接线：要么 local 加 adapter，要么 v2 自带 HTTP |
| local API | 全走 v1 lib/db PostgREST-shim | self-growing 新 API 要么续在 local，要么独立 |
| Obsidian 同步 | **单向**（vault→DB），无回写 | 双向需新建 DB→md 渲染器 + 变更检测 + 写回通道 |
| 插件健壮性 | 无重试/无失败队列/无冲突检测 | self-growing 链路要可靠需补 |
| schema 主权 | local supabase/migrations/（36 个 SQL） | 新表加在这里，v2 drizzle pull 同步 |
| 事务 | v1/v2 两套并存 | 统一到 v2 的 withTransaction |
| 备份 | Docker 每日 pg_dump + 手动脚本 | 已有，self-growing 复用 |
| CORS/Webhook | 空白 | 远程同步/多端需补 |

---

## 第一部分：后端怎么实现

### 核心决策：v2 自带 HTTP 层（Hono），独立部署

**为什么不续在 local 的 Next.js routes 里**：
- local 是 Next.js 全栈应用，API routes 和页面耦合；self-growing 的开放 API + MCP 是**独立的对外服务**，不该和前端 SSR 混在一起
- local 的 API 用 v1 shim，self-growing 要用 v2 的 Clean Architecture，两套混在一个进程里会混乱
- MCP server 是独立进程（stdio/SSE），和 Next.js 同进程不自然

**方案：v2 加 Hono HTTP 层 + MCP server，独立部署**

```
vocab-observatory-v2/
├── src/
│   ├── db/              (已有)
│   ├── repositories/    (已有)
│   ├── services/        (已有)
│   ├── schemas/         (已有)
│   ├── errors/          (已有)
│   ├── llm/             ← 新建（LLM provider + prompts）
│   ├── http/            ← 新建（Hono routes）
│   │   ├── server.ts
│   │   ├── routes/
│   │   │   ├── words.ts     # 只读查询 API
│   │   │   ├── extend.ts    # L2 扩展写入 API
│   │   │   ├── relations.ts # 关系图读写 API
│   │   │   ├── assets.ts    # 作文/长难句 API
│   │   │   ├── stats.ts     # 健康度/推荐 API
│   │   │   └── sync.ts      # Obsidian 双向同步 API
│   │   ├── middleware/
│   │   │   ├── auth.ts      # Token 鉴权（owner/agent/public）
│   │   │   └── error.ts     # 统一错误处理
│   │   └── openapi.ts       # OpenAPI schema 生成
│   ├── mcp/             ← 新建（MCP server）
│   │   ├── server.ts
│   │   └── tools.ts
│   ├── sync/            ← 新建（文件系统 + Obsidian 同步）
│   │   ├── markdown-renderer.ts  # DB→md 渲染器
│   │   ├── obsidian-writer.ts    # 写回 vault
│   │   ├── drift-detector.ts     # 双向漂移检测
│   │   └── outbox.ts             # 变更 outbox
│   └── index.ts         # 导出 + startServer()
├── package.json         ← 加 hono / @modelcontextprotocol/sdk
└── drizzle.config.ts    (已有)
```

### Hono 为什么是首选

| 选项 | 优劣 |
|------|------|
| **Hono** ✅ | 轻量、Web 标准（fetch）、TS 一等公民、中间件生态好、可跑 Node/Bun/Deno/CF Workers |
| Express | 老牌但臃肿，TS 支持不如 Hono 原生 |
| Fastify | 快但 schema 驱动偏重，和 Zod 重复 |
| 续在 Next.js routes | 和前端耦合，不独立 |

Hono 的优势：**同一个 server.ts 可以跑在 Node（本地开发）和 Cloudflare Workers（远程部署）**——匹配你的 cloudflared 场景。

### HTTP 层接线 v2 服务

```typescript
// src/http/server.ts
import { Hono } from "hono";
import { createServices } from "../services";
import { applyReviewAnswer } from "./fsrs-bridge";  // 复用 local 的 fsrs-adapter
import { getWordbookFsrsWeights } from "./weights-loader";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/api/open", openApiRoutes);
app.route("/mcp", mcpRoutes);

export function startServer(port = 3001) {
  const services = createServices({
    fsrsAdapter: applyReviewAnswer,
    loadWeights: getWordbookFsrsWeights,
  });
  app.use("/*", async (c, next) => {
    c.set("services", services);
    await next();
  });
  return { app, services, port };
}
```

### 与 local 的关系

```
local (Next.js, :3000)        v2-http (Hono, :3001)        MCP (stdio/SSE)
  ├─ 前端页面                    ├─ /api/open/* 开放 API         ├─ Claude Desktop
  ├─ /api/review/* (v1)         ├─ /api/sync/* Obsidian 同步    ├─ Cursor
  ├─ /api/imports/obsidian      └─ /mcp SSE 端点                └─ 自建 Agent
  └─ /api/words (v1)
        │                              │
        └──── 共享同一个 PostgreSQL ────┘
              (127.0.0.1:5434)
```

**渐进迁移**：local 的 v1 routes 不动，新功能在 v2-http 实现。等 v2-http 稳定后，逐步把 local 的复习 routes 迁移过来。

### 鉴权中间件

```typescript
type Role = "owner" | "agent" | "public";

app.use("/api/open/*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  const role = resolveRole(token);
  // owner: 全权限
  // agent: 只能写 word_l2_content / word_relations / learning_assets
  // public: 只读 words
  c.set("role", role);
  await next();
});
```

---

## 第二部分：和本地文件系统怎么对接

### 两种对接模式

#### 模式 A：后端直接读写文件系统（推荐用于本地部署）

v2-http 后端直接用 `node:fs` 读写 Obsidian vault 的物理目录。

**优点**：零依赖（不需要 Obsidian 插件参与 DB→vault 回写）、实时、简单。

**配置**：
```env
OBSIDIAN_VAULT_PATH=D:/Temp/Myawesomeapp/vocab-ob'/old-odds/data
WORD_NOTES_DIR=Wiki
```

**读取（vault → DB）**：复用 local 的 `parseWordMarkdown` 解析逻辑（抽到 v2 的 `src/sync/parser.ts`）。

**写入（DB → vault）**：新建 `markdown-renderer.ts`，把 DB 的结构化字段反向渲染成 markdown：

```typescript
export function renderWordMarkdown(word: WordWithL2): string {
  const fm = renderFrontmatter(word);
  const body = [
    renderInfoCallout(word),
    renderCoreDefinitions(word),
    renderMorphology(word),
    renderSemanticChain(word),
    renderMnemonic(word),
    renderL2Content(word),  // 按 source 分 section
  ].filter(Boolean).join("\n\n");
  return `---\n${fm}\n---\n\n# ${word.lemma}\n\n${body}\n`;
}
```

**L2 内容按 source 分 section 渲染**（解决场景③）：

```markdown
## 搭配与短语

### 考研
- abundant evidence — 充分证据
- abundant resources — 丰富资源

### 雅思
- abundant rainfall — 充沛降雨
- abundant wildlife — 丰富野生动植物
```

#### 模式 B：通过 Obsidian 插件中转（推荐用于远程/多端）

后端不直接碰文件系统，而是通过插件拉取变更写回 vault。

**优点**：后端不依赖文件系统路径（可远程部署）、多端同步、用户可控。
**缺点**：依赖插件扩展（当前插件只推不拉）、非实时。

**混合策略**：本地部署用模式 A，远程/多端用模式 B。后端同时提供：
- `POST /api/sync/write-to-vault`（模式 A：后端直接写文件）
- `GET /api/sync/changes?since=<timestamp>`（模式 B：插件拉增量）

### 文件写入的原子性

```typescript
import { writeFile, rename, mkdir } from "node:fs/promises";

export async function writeWordFile(vaultPath: string, slug: string, markdown: string) {
  const filePath = `${vaultPath}/Wiki/L0_基础词/${slug}.md`;
  const tmpPath = `${filePath}.tmp`;

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmpPath, markdown, "utf-8");  // 先写临时文件
  await rename(tmpPath, filePath);             // 原子 rename
  await recordSyncOutbox(slug, "modified");    // 记录 outbox
}
```

---

## 第三部分：数据持久化和稳定性如何保证

### 三层持久化

#### 层 1：PostgreSQL（主存）

已有机制复用：
- Docker bind mount（`./postgres-data`）+ 每日 pg_dump 备份（保留 30 天）
- v2 的事务（`withTransaction` + `requireTx`）
- content_hash 漂移检测

**新增表的事务保护**：

```typescript
async function extendWordL2(wordId: string, content: L2ContentDraft, source: string) {
  return withTransaction(async (tx) => {
    const repos = createRepositories(tx);
    // 1. 写 word_l2_content
    await repos.l2content.insert({ word_id: wordId, field: content.field, content: content.data, source });
    // 2. 刷新 words 表 JSONB 缓存
    await refreshWordL2Cache(tx, wordId);
    // 3. 重算 content_hash + 漂移检测
    const newHash = await recomputeContentHash(tx, wordId);
    await markStaleCardsForRecheck(tx, wordId, newHash);
    // 4. 写 outbox（供文件系统/远程同步）
    await repos.outbox.insert({ word_id: wordId, action: "l2_extended" });
  });
}
```

#### 层 2：文件系统（Obsidian vault）

- 原子写入（tmp + rename）
- 写入失败回滚（DB 事务已提交，文件未写 → outbox 记录待同步）
- 冲突检测（content_hash 比对 DB vs 文件）

#### 层 3：备份（已有）

- 每日 pg_dump（Docker backup service）
- 手动 `npm run backup`
- 文件系统侧：Obsidian vault 本身可能有 git 版本控制

### Outbox 模式保证最终一致性

```sql
CREATE TABLE sync_outbox (
  id uuid PRIMARY KEY,
  word_id uuid REFERENCES words(id),
  action text NOT NULL,           -- 'l2_extended' / 'relation_added' / 'asset_created'
  payload jsonb,
  status text DEFAULT 'pending',  -- pending / synced / failed
  synced_at timestamptz,
  retry_count int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
```

**流程**：
1. DB 事务提交时，同时写 outbox（同事务，保证原子）
2. 文件系统写入器轮询 outbox，写文件成功 → 标记 synced
3. 写入失败 → retry_count++，指数退避
4. 超过最大重试 → 标记 failed，人工介入

**远程端拉取**：`GET /api/sync/changes?since=<ts>` 返回 outbox 里 pending 的变更。

### content_hash 在双向同步中的角色

```
DB content_hash    vs    文件 sha256(markdown)
       │                       │
       ├─ 相同 → 无变更
       ├─ DB 新 → DB 是源，写回文件
       └─ 文件新 → 文件是源，解析入 DB
```

**冲突场景**（双方都改了）：
- DB hash ≠ 文件 hash，且 outbox 有 pending → 双方都改了
- 策略：**DB 优先**（结构化数据为准），文件覆盖为 DB 渲染版本
- 但保留文件侧的"用户手动编辑"标记——如果用户在 Obsidian 里手改了 L1 内容，那个字段以文件为准

### 稳定性 checklist

| 场景 | 保护机制 |
|------|---------|
| DB 写入中途崩溃 | PostgreSQL 事务原子性 |
| 文件写入中途崩溃 | tmp + rename 原子写入 |
| DB 写了文件没写 | outbox 待同步，重试 |
| 文件改了 DB 没改 | 插件推送 / 后端轮询检测 |
| 双方同时改 | content_hash 比对 + DB 优先策略 |
| 后端宕机 | outbox 持久化在 DB，重启后继续同步 |
| 备份恢复 | pg_dump 恢复 + 文件系统 git 回滚 |

---

## 第四部分：Obsidian 双向同步怎么设计

### 核心决策：后端直写文件为主，MCP 管逻辑不管文件同步

你的问题点出了关键——"不直接写开发 mcp?还是直接本地文件系统写入规范格式"。

**答案：本地文件系统直接写入规范格式为主，MCP 管逻辑层不管文件同步。**

理由：
- MCP 的职责是"让 Agent 操作笔记系统逻辑"（扩展 L2、加关系、分析作文），不是"同步文件"
- 文件同步是基础设施，应该是后端的内部职责，不该暴露给 Agent
- 直接写文件最简单可靠（本地部署场景），MCP 反而绕弯

### 双向同步架构

```
        Obsidian Vault (.md 文件)
              │
    ┌─────────┴─────────┐
    │                   │
  方向 1               方向 2
  vault → DB          DB → vault
    │                   │
    │ 插件推送            │ 后端直写文件（模式A）
    │ 或后端轮询          │ 或插件拉增量（模式B）
    ↓                   ↓
  parseWordMarkdown   markdown-renderer
    → upsertWord       → writeWordFile
    → content_hash      → content_hash
    → 漂移检测           → outbox 记录
              │
        PostgreSQL (words 表)
```

### 方向 1：vault → DB（已有，优化）

**现状**：插件监听 modify/create → POST markdown → 服务端解析 upsert。

**优化点**：
1. 插件加重试 + 失败队列（当前失败即丢）
2. 后端加幂等（content_hash 相同则跳过，已有）
3. 支持批量（已有，max 200）

### 方向 2：DB → vault（新建，核心）

#### 方式 A：后端直写文件（本地部署）

```typescript
// 后端启动时开启 outbox 监听
watchOutbox(async (entry) => {
  const word = await loadWordWithL2(entry.word_id);
  const markdown = renderWordMarkdown(word);
  await writeWordFile(env.OBSIDIAN_VAULT_PATH, word.slug, markdown);
  await markOutboxSynced(entry.id);
});
```

#### 方式 B：插件拉增量（远程/多端）

扩展 Obsidian 插件新增"拉取"能力：

```typescript
async function pullChanges() {
  const since = loadLastSyncTimestamp();
  const res = await fetch(`${apiUrl}/sync/changes?since=${since}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const changes = await res.json();

  for (const change of changes) {
    const mdRes = await fetch(`${apiUrl}/sync/word/${change.slug}/markdown`);
    const markdown = await mdRes.text();
    const file = app.vault.getAbstractFileByPath(change.sourcePath);
    if (file) {
      await app.vault.modify(file, markdown);
    }
  }
  saveLastSyncTimestamp(Date.now());
}

registerInterval(window.setInterval(pullChanges, settings.pullIntervalMs ?? 60000));
```

### 冲突处理策略

```
用户在 Obsidian 手改了 abundant.md 的 L1 释义
    ↓
同时 Agent 在 DB 里给 abundant 加了 L2 搭配
    ↓
冲突：文件改了 L1，DB 改了 L2
    ↓
解决：按字段粒度合并，不整体覆盖
  - L1 字段（释义/词根/记忆锚点）→ 以文件为准（用户手改优先）
  - L2 字段（搭配/例句/同反义）→ 以 DB 为准（Agent/LLM 生成）
    ↓
markdown-renderer 渲染时：
  - L1 section 从文件解析的 ParsedWord 取
  - L2 section 从 DB 的 word_l2_content 取
  - 合并成新 markdown，写回文件
```

**实现**：这需要 markdown-renderer 支持"以现有文件为基底，只替换 L2 section"，而不是全量重建。这是渲染器设计的核心难点。

### markdown-renderer 的"增量渲染"设计

```typescript
export async function renderWordMarkdownIncremental(
  wordId: string,
  existingMarkdown: string | null
): Promise<string> {
  if (!existingMarkdown) {
    return renderWordMarkdownFull(await loadWordWithL2(wordId));
  }

  // 增量：解析现有 markdown，只替换 L2 section
  const parsed = parseWordMarkdown(existingMarkdown);
  const l2Content = await loadWordL2Content(wordId);

  const l1Sections = extractL1Sections(parsed);    // 保留用户手改
  const l2Sections = renderL2Sections(l2Content);  // 从 DB 重新渲染

  return assembleMarkdown(parsed.frontmatter, l1Sections, l2Sections);
}
```

### 同步状态可视化

新增同步状态页面：

```
同步状态
├─ vault → DB: 上次同步 2 分钟前 ✓
├─ DB → vault: 上次同步 5 分钟前 ✓
├─ outbox 待同步: 3 条
│  ├─ abundant (l2_extended) — 重试 0
│  ├─ ephemeral (relation_added) — 重试 0
│  └─ transient (l2_extended) — 重试 0
└─ 冲突: 0
```

---

## 第五部分：实施路径（按优先级）

### Phase 1：后端接线（先让 v2 能跑起来）
1. v2 加 Hono HTTP 层 + 鉴权中间件
2. 接线 createServices（fsrsAdapter + loadWeights）
3. 基础只读 API（/api/open/words/:slug, /api/open/stats）
4. 启动脚本 `npm run dev`

### Phase 2：L2 扩展闭环（先跑通核心链路）
1. 新建 word_l2_content 表（migration）
2. LLM provider 抽象层 + 搭配/例句/同反义生成
3. 用户勾选 API + 写入 word_l2_content
4. refreshWordL2Cache（聚合回 words JSONB）
5. content_hash 漂移 → 重卡

### Phase 3：文件系统对接（DB → vault）
1. markdown-renderer（全量 + 增量两种模式）
2. obsidian-writer（原子写入）
3. sync_outbox 表 + 轮询消费者
4. 冲突检测（content_hash 比对）

### Phase 4：Obsidian 插件扩展（vault → DB 增强 + 拉增量）
1. 插件加重试 + 失败队列
2. 插件加 pull 能力（定时拉 outbox）
3. 同步状态 UI

### Phase 5：Agent 共建（MCP + 关系图）
1. word_relations 表
2. MCP server（stdio 传输，本地 Claude Desktop）
3. Agent 关系分析 + 写入
4. learning_assets 表 + 作文/长难句分析

### Phase 6：跨词书 L2 共存
1. word_l2_content 的 source 标签标准化
2. 卡片按 source 分组渲染
3. 词书切换时 L2 筛选

---

## 未决问题

1. **Hono vs 续在 Next.js**：Hono 独立部署更干净，但多一个进程。你接受吗？
2. **文件系统直写 vs 插件中转**：本地用直写，远程用插件——这个混合策略 OK？
3. **冲突合并粒度**：L1 以文件为准、L2 以 DB 为准——这个边界对吗？还是有更细的粒度？
4. **outbox 轮询间隔**：本地实时写不需要轮询，但远程端拉增量间隔多少合适（30s/1min/5min）？
5. **markdown-renderer 的增量难度**："只替换 L2 section 保留 L1"在技术上可行但复杂——是否接受第一版用全量重建（覆盖用户手改）？
6. **MCP 传输**：stdio（本地）还是 SSE（远程）？Claude Desktop 只支持 stdio，Cursor 两者都行。


---

## 勘误：MCP 工具只写 DB，不碰文件系统

### 原文的问题

第四部分开头写："MCP 的职责是让 Agent 操作笔记系统逻辑，不是同步文件"——这个前提正确，但用它暗示"MCP 应该直接写文件"是错误的推导。

### 修正后的边界

**MCP 工具永远只写 DB，不碰文件系统。** 文件同步是后端从 DB 派生出来的内部职责。

```
Agent → MCP 工具 → 写 DB（事务内，记 outbox + 审计）
                      ↓
                outbox 消费者（后端内部，Agent 不感知）
                      ↓
                markdown-renderer → obsidian-writer → 写 vault 文件
```

### 为什么 MCP 不能直接写文件

| 问题 | 后果 |
|------|------|
| DB 不知道 | content_hash 对不上，vault→DB 同步冲突或覆盖 |
| outbox 不记录 | 远程端拉不到变更，多端不同步 |
| 审计缺失 | content_extensions 表记不下"谁改的" |
| 事务保证丧失 | 文件写一半崩溃无法回滚 |
| 格式未校验 | Agent 生成的 markdown 绕过 parseMarkdown 校验 |

### 修正后的 MCP 工具实现

MCP 工具 handler 只做三件事：**写 DB → 记 outbox → 记审计**。文件同步由 outbox 消费者异步完成，Agent 完全不感知文件存在。

```typescript
// MCP 工具只写 DB，不碰文件
handler: async ({ slug, field, content, source }) => {
  return withTransaction(async (tx) => {
    const repos = createRepositories(tx);
    const word = await repos.words.findBySlug(slug);

    // 1. 写 word_l2_content（真实存储）
    await repos.l2content.insert({ word_id: word.id, field, content, source });

    // 2. 刷新 words JSONB 缓存
    await refreshWordL2Cache(tx, word.id);

    // 3. 重算 content_hash + 重卡
    const newHash = await recomputeContentHash(tx, word.id);
    await markStaleCardsForRecheck(tx, word.id, newHash);

    // 4. 记 outbox（驱动文件同步）
    await repos.outbox.insert({ word_id: word.id, action: 'l2_extended' });

    // 5. 记审计
    await repos.extensions.insert({ word_id: word.id, field, new_value: content, source });

    return { ok: true };
  });
  // 事务提交后，outbox 消费者自动渲染 markdown 并写文件
  // Agent 不感知这一步
}
```

### 类比

像 Git——你 commit 写 object store，working tree 是 checkout 派生出来的。你不会直接改 working tree 再绕过 Git 索引。MCP 写 DB，文件是 DB 的"checkout"。
