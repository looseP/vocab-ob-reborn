# 自增型学习链路 —— 按需生长的词汇知识网络

- **Status**: Draft / 探索阶段
- **Date**: 2026-07-06
- **Author**: brainstorming session
- **Inspiration**: 用户提出的范式转移——从"预制静态词库"到"按需生长的知识网络"

---

## 范式对比

```
旧范式：预制完整词库（≈词典）→ 复习系统消费 → 用户被动接受
新范式：最小种子笔记（L1）→ 按需 LLM 扩展（L2）→ 用户+Agent 共建 → 笔记随能力生长
```

### 核心矛盾（用户原话）

> "预存词卡笔记是不太合理的，对于那些内容，要全面就会成词典，成词典为什么不翻词典呢？
> 而且对于我真的需要这么多搭配写下来吗？记得住吗？
> 词典的例句真的是自己想要的吗？贪多嚼不烂"

### 三层解决

1. **L1 最小种子**：只放最适合记忆的核心字段（核心释义 + 词根词缀 + 词源叙事 + 记忆链路）
2. **L2 按需扩展**：词进入 L2 能力阶段时，LLM 生成个性化扩展内容（搭配/例句/同反义），用户勾选采纳
3. **开放共建**：通过 API + MCP 暴露笔记系统，让外部 Agent 读/写/探索/更新链接，笔记永远是最适合你的

---

## 第一部分：L1 最小种子笔记

### 设计原则

笔记在 L1 阶段只包含**最适合记忆编码**的字段，不堆砌。用户原话界定的 L1 核心：

| 字段 | 来源 | 认知作用 |
|------|------|---------|
| **核心释义**（short_definition / definition_md） | 种子笔记 | 一句话锚定义 |
| **词根词缀**（morphology.parts + raw） | 种子笔记 | 结构化拆解 |
| **词源叙事**（morphology.narrative / mnemonic.etymology） | 种子笔记 | 故事化编码（最强记忆钩子） |
| **记忆链路**（semantic_chain） | 种子笔记 | 语义网络锚定 |

**不进 L1 的字段**（留待 L2 扩展）：
- ❌ collocations（搭配）—— 词典级，记不住
- ❌ corpus_items（真题例句）—— 词典的例句不是"自己想要的"
- ❌ synonym_items / antonym_items —— 同反义辨析是 L2 能力
- ❌ derived_words / pos_conversions —— 派生词族是扩展

### 数据模型影响

`words` 表结构不变（JSONB 字段天然支持），但**导入时的质量门控要重新定义**：

```typescript
// 当前 quality.ts 只检查 definition/examples/ipa
// L1 种子模式扩展为：

const L1_REQUIRED_FIELDS = ['definition_md', 'morphology', 'mnemonic', 'semantic_chain']
const L2_OPTIONAL_FIELDS = ['collocations', 'corpus_items', 'synonym_items', 'antonym_items']

// quality_status 语义重定义：
// ok + L1 complete → L1 就绪
// ok + L1 partial  → needs_supplement（缺 L1 核心字段，必须补）
// ok + L1 complete + L2 empty → L2_pending（等 LLM 扩展）
// ok + L1 + L2 complete → fully_grown（完全生长）
```

### 种子笔记的 Markdown 模板

L1 种子笔记的精简形态（对比当前全量模板）：

```markdown
---
title: ephemeral
word_freq: 基础词
semantic_field: 时间性
phonetic: /ɪˈfem(ə)rəl/
pos: adj.
---

# ephemeral

> [!info] 基础信息
> 音标 / 语义场 / 词频

## 核心释义
**adj.** ①==**短暂的，转瞬即逝的**==

> [!tip] 原型义
> 花朵朝开夕落——美丽却只存一日

## 词根词缀
`[[ephemero]]-`（希腊语"一日"）+ `-al`（形容词后缀）
**叙事**：古希腊医学之父观察到一种蜉蝣，朝生暮死，名之 ephemeris。这个词根承载着"一日之命"的画面。

## 记忆链路
> [!abstract]- 词义链路法
> 一日 → 朝生暮死的蜉蝣 → 短暂存在的事物 → 转瞬即逝的
```

**注意**：没有搭配、没有真题例句、没有同反义表格。这些是 L2 的事。

### 卡片展示对齐

`ZenFlashcard` 已有条件渲染——L1 卡片自然只显示存在的字段。当前组件的"记忆锚点/语义链路/语料搭配"折叠 section 已经是"有则显示无则隐藏"的逻辑。

**需要的改动**：当 `collocations`/`corpus_items` 为空时，不显示"暂无内容"占位，而是显示一个 **"扩展此词"** 的入口（触发 L2 LLM 生成）。

---

## 第二部分：L2 按需 LLM 扩展

### 核心流程

```
词达到 L1 稳定（FSRS stability ≥ 阈值）
    ↓
触发"进入 L2"提示（用户可选立即扩展或稍后）
    ↓
用户进入"笔记扩展勾选"界面
    ↓
系统并行调用：
  ├─ 词典 API（获取搭配候选 + 基础例句）
  └─ LLM API（按特殊 prompt 生成个性化例句 + 同反义辨析）
    ↓
用户勾选想要的内容（不勾选 = 不采纳）
    ↓
采纳的内容写入 words 表对应 JSONB 字段
    ↓
content_hash 更新 → 触发 needs_recheck → 用户下次复习看到新内容
```

### LLM 生成的内容类型

#### 2.1 搭配（Collocations）

**问题**：词典给 10 个搭配，用户记不住也不需要。
**方案**：LLM 生成 2-3 个**最常用 + 最可能出现在用户目标考试中**的搭配。

```typescript
interface CollocationGenerationRequest {
  word: string;          // ephemeral
  pos: string;           // adj.
  cefr_target: string;   // 雅思/托福/GRE → 影响搭配的正式度
  semantic_field: string;// 时间性 → 搭配要贴合语义场
  count: number;         // 2-3 个
}
```

**Prompt 设计方向**（不是最终 prompt，是设计意图）：
> 给定词 X（词性、语义场、目标考试级别），生成 2-3 个最值得记忆的搭配。
> 要求：
> - 每个搭配配一句简短例句（来自真实语境，不是编造的）
> - 搭配要"高频且考试有用"，不要生僻
> - 标注每个搭配的语感（formal/neutral/informal）

#### 2.2 个性化例句（Corpus Items）

**这是用户最在意的点**："词典的例句真的是自己想要的吗？"

**方案**：LLM 按"个人化语境"生成例句。用户可配置偏好：

```typescript
interface ExampleGenerationConfig {
  domains: string[];      // ["科技", "商业", "文学"] → 例句的领域偏好
  difficulty: string;     // "雅思7分" / "GRE" → 例句的词汇难度
  style: string;          // "学术" / "口语" / "新闻"
  count: number;          // 1-2 个
  // 可选：用户自备语料库路径，LLM 优先从语料库里找真实例句
  corpus_path?: string;
}
```

**Prompt 设计方向**：
> 为词 X 生成 1-2 个例句。
> - 领域偏好：{domains}
> - 难度：{difficulty}
> - 风格：{style}
> - 每句配中文翻译
> - 优先使用真实语境（如果提供了语料库路径，从其中检索）
> - 不要"教科书式"的无聊例句，要有信息密度

**自备语料库选项**：用户可以指向自己的 Obsidian 笔记库 / 收藏的文章 / Anki 牌组，LLM 优先从这些**真实个人语料**里找/改写例句。这解决了"词典例句不是我想要的"——因为语料是你自己的。

#### 2.3 同反义辨析（Synonym/Antonym Items）

L2 阶段不只是列同反义词，而是**辨析**——五维数据（semanticDiff/tone/usage/delta/object）：

```typescript
interface SynonymGenerationRequest {
  word: string;
  existing_synonyms?: string[];  // L1 笔记里已有的（来自 frontmatter），让 LLM 补全辨析
  count: number;                 // 2-3 个
}
```

**Prompt 设计方向**：
> 给定词 X 和它的近义词列表 [Y, Z]，为每对 (X, Y) 生成辨析：
> - semanticDiff: 语义差异（一句话）
> - tone: 语气差异（formal/neutral/informal）
> - usage: 用法差异（搭配什么/不搭配什么）
> - delta: 核心区别（"X 强调 A，Y 强调 B"）
> - object: 各自适用的对象

### LLM API 抽象层

新建 `lib/llm/` 模块（当前是绿地，`p1_ai_translate.py` 有 TODO 桩）：

```typescript
// lib/llm/provider.ts
interface LlmProvider {
  generate(prompt: string, config: GenerationConfig): Promise<string>;
}

// 实现可替换：OpenAI / Anthropic / DeepSeek / Qwen / 本地 Ollama
class OpenAIProvider implements LlmProvider { ... }
class AnthropicProvider implements LlmProvider { ... }
class OllamaProvider implements LlmProvider { ... }  // 离线/隐私

// lib/llm/prompts/
//   collocations.ts   — 搭配生成 prompt
//   examples.ts       — 例句生成 prompt
//   synonyms.ts       — 同反义辨析 prompt

// lib/llm/generate.ts
async function generateL2Content(
  word: ParsedWord,
  config: UserL2Config
): Promise<L2ContentDraft>
```

**配置**：
```typescript
interface UserL2Config {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'qwen' | 'ollama';
  api_key?: string;          // 本地 Ollama 不需要
  model: string;
  cefr_target: string;       // 雅思/托福/GRE
  domains: string[];          // 例句领域偏好
  corpus_path?: string;       // 自备语料库
  count_collocations: number; // 默认 2
  count_examples: number;    // 默认 1
}
```

### 词典 API 补充

LLM 不一定可靠（会编造搭配/例句），**词典 API 做 ground truth**：

| 来源 | 数据 | API |
|------|------|-----|
| Cambridge Dictionary | 释义、搭配、例句 | 网页抓取（`fetch_cambridge_data.py` 已有雏形） |
| Oxford Collocations | 搭配 | 网页抓取（`fetch_oxford_collocations.py` 已有雏形） |
| Free Dictionary API | 基础释义 | `dictionaryapi.dev`（免费） |

**流程**：词典 API 取 ground truth → LLM 在此基础上个性化改写/筛选 → 用户勾选。不是 LLM 凭空生成。

### 用户勾选界面

**扩展勾选**（不是一键采纳）：

```
为 "ephemeral" 生成 L2 内容：

▸ 搭配（2/3 已选）
  ☑ ephemeral beauty        — 短暂的美（formal）
  ☑ ephemeral nature        — 转瞬即逝的本质（neutral）
  ☐ ephemeral fame          — 一时的名声（你已有类似搭配？跳过）

▸ 例句（1/2 已选）
  ☑ "Her influence was ephemeral, fading within a year."
     （科技/商业领域 ✓ 符合你的偏好）
  ☐ "The ephemeral colors of sunset..."
     （文学风格 ✗ 你的偏好不含文学）

▸ 同义辨析（2/2 已选）
  ☑ transient — 强调"过程短暂"，ephemeral 强调"本应持久却短暂"
  ☑ fleeting — 语感更轻，ephemeral 更正式

[ 采纳选中项 ]  [ 重新生成 ]  [ 跳过 ]
```

**关键**：用户控制采纳什么。LLM 生成草稿，用户是最终编辑者。

### 写入与重卡

采纳后写入 `words` 表 JSONB 字段 → `content_hash` 更新 → `markStaleCardsForRecheck` 触发 `needs_recheck=true` + `due_at=now()` → 用户下次复习看到扩展后的笔记。

**content_hash 漂移的双刃剑处理**：
- L2 扩展后**应该**触发重看——用户需要复习新增的搭配/例句
- 但不应该是"惩罚性重卡"（不影响 FSRS stability）
- `needs_recheck` 标记是软的（只让卡到期，不重置 stability）——符合需求

---

## 第三部分：开放 API + MCP 共建

### 设计目标

> "我们这个项目软件的数据也需要设置 api 和 mcp 对外开放，
> 比如今日学习的词汇（甚至同义词这些链路信息），通过暴露 api 让成熟的 agent
> 探索链接以及更新链接系统（这样我们的笔记永远是最好的最适合你的）"

笔记系统不只是被你自己的 App 读写，而是**任何成熟 Agent 都能读/写/探索**的开放系统。

### 三层 API

#### 层 1：只读查询 API（已部分存在，需规范化）

```typescript
GET /api/open/words/today           // 今日学习/复习的词
GET /api/open/words/:slug           // 单词完整笔记（含 L1 + L2 内容）
GET /api/open/words/:slug/relations // 关系图（同根/近义/反义/派生）
GET /api/open/stats/review-health   // 整体复习健康度
GET /api/open/stats/streak          // 连续天数
GET /api/open/recommend/tomorrow    // 推荐明日学习/复习的词
```

**鉴权**：API Token（类似现有 IMPORT_SECRET），区分 owner / agent / public 三种权限。

#### 层 2：写入 API（新建）

```typescript
POST /api/open/words/:slug/extend    // Agent 扩展 L2 内容（搭配/例句/同反义）
PATCH /api/open/words/:slug/field    // Agent 修改特定字段（带版本号防冲突）
POST /api/open/words/:slug/relation  // Agent 新增/更新关系链接
POST /api/open/words/:slug/note      // Agent 追加用户笔记
```

**写入安全**：
- 所有写入操作记录审计日志（谁写的、什么时候、改了什么）
- 关键字段（lemma/definition）需要 owner 权限，Agent 只能扩展 L2
- 写入后触发 content_hash 更新 + 重卡

#### 层 3：MCP Server（新建）

MCP（Model Context Protocol）让外部 Agent（Claude Desktop / Cursor / 自建 Agent）能标准化地操作你的笔记系统：

```typescript
// mcp-server/tools.ts

const tools = [
  {
    name: 'get_today_words',
    description: '获取用户今日学习/复习的词汇列表',
    handler: async () => { /* 调 GET /api/open/words/today */ },
  },
  {
    name: 'get_word_relations',
    description: '获取单词的关系图（同根/近义/反义/派生）',
    params: { slug: string },
    handler: async ({ slug }) => { /* 调 GET /api/open/words/:slug/relations */ },
  },
  {
    name: 'extend_word_l2',
    description: '为单词扩展 L2 内容（搭配/例句/同反义辨析），需用户确认',
    params: { slug: string, content: L2ContentDraft },
    handler: async ({ slug, content }) => { /* 调 POST /api/open/words/:slug/extend */ },
  },
  {
    name: 'update_relation',
    description: '更新单词之间的关系链接',
    params: { word_a: string, word_b: string, relation_type: string, metadata?: object },
    handler: async (...) => { /* 调 POST /api/open/words/:slug/relation */ },
  },
  {
    name: 'get_review_health',
    description: '获取整体复习健康度（留存率/leech 数/streak/元认知偏差）',
    handler: async () => { /* 调 GET /api/open/stats/review-health */ },
  },
  {
    name: 'recommend_tomorrow',
    description: '推荐明日学习/复习的词（基于到期+能力阶段+薄弱标记）',
    handler: async () => { /* 调 GET /api/open/recommend/tomorrow */ },
  },
];
```

### Agent 共建场景

#### 场景 1：Claude Desktop 探索关系

> 用户在 Claude Desktop 里说："帮我看看 ephemeral 和 transient 的关系，如果它们还没有辨析，帮我生成一下。"
>
> Claude 调 `get_word_relations(slug='ephemeral')` → 发现和 transient 的关系是"近义"但没有辨析 → 调 `extend_word_l2(slug='ephemeral', content={synonym_items: [...]})` → 生成辨析写入 → 用户下次复习看到。

#### 场景 2：Cursor 批量补全

> 用户在 Cursor 里说："帮我找出所有 needs_supplement 的词，批量生成 L2 内容。"
>
> Cursor 调 `get_words_by_quality(status='needs_supplement')` → 循环调 `extend_word_l2` → 批量补全。

#### 场景 3：自建 Agent 个性化

> 用户写了一个 Agent，每天晚上分析自己的复习数据 → 调 `recommend_tomorrow` 看推荐 → 调 `extend_word_l2` 为推荐词预生成 L2 内容 → 第二天打开 App 内容已就绪。

### 与 Obsidian 插件的关系

当前 Obsidian 插件是单向（Obsidian → DB）。开放 API 后：

- **DB → Obsidian 回写**：扩展插件，让 DB 的 L2 扩展内容回写到 Obsidian markdown
- **保持 Obsidian 为真相源**：LLM/Agent 写 DB 后，回写 Obsidian，用户在 Obsidian 里仍能编辑
- **双向同步**：Obsidian 改 → DB（现有）；DB 扩展 → Obsidian（新增）

---

## 第四部分：系统全景

### 数据流全景

```
                    ┌─────────────────┐
                    │  Obsidian Vault  │
                    │  (L1 种子笔记)   │
                    └────────┬────────┘
                             │ 单向同步（现有）
                             ▼
┌──────────────────────────────────────────────┐
│              words 表（Postgres）              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ L1 字段  │  │ L2 字段  │  │  关系    │  │
│  │ (种子)   │  │ (扩展)   │  │  (图谱)  │  │
│  └──────────┘  └────▲─────┘  └────▲─────┘  │
└──────────────────────┼────────────┼────────┘
                       │            │
        ┌──────────────┼────────────┼──────────────┐
        │              │            │              │
   ┌────┴────┐   ┌─────┴─────┐  ┌──┴───┐   ┌────┴────┐
   │ LLM     │   │ 词典 API  │  │ MCP  │   │ Open API│
   │ 生成    │   │ ground    │  │Server│   │ (REST)  │
   │ L2 草稿 │   │ truth     │  │      │   │         │
   └────┬────┘   └─────┬─────┘  └──┬───┘   └────┬────┘
        │              │            │            │
        └──────┬───────┘            │            │
               ▼                    │            │
        ┌──────────────┐            │            │
        │ 用户勾选界面 │            │            │
        │ (扩展 editor)│            │            │
        └──────┬───────┘            │            │
               │ 采纳               │            │
               └────────────────────┘            │
                          │                      │
               ┌──────────▼──────────────────────▼┘
               │  外部 Agent（Claude/Cursor/自建）
               │  - 探索关系
               │  - 更新链接
               │  - 诊断弱点
               │  - 推荐学习
               └──────────────────────┘
```

### 能力阶段与笔记生长的对齐

| 能力阶段 | 笔记状态 | 内容来源 |
|---------|---------|---------|
| **L0 未学习** | 无笔记 | — |
| **L1 认知** | 种子笔记（4 字段） | Obsidian 手写 / 导入脚本 |
| **L1 稳定** | 种子笔记 + 标记 L2_pending | FSRS stability 达阈 |
| **L2 应用** | 笔记扩展（+搭配/例句/同反义） | LLM + 词典 API + 用户勾选 |
| **L2 稳定** | 笔记 + 关系图丰富 | Agent 探索补充链接 |
| **L3 产出** | 笔记 + 用户造句/语境重构记录 | 用户自产 + 自评 |

**关键**：笔记不是一次性写好的，它**随能力阶段渐进生长**。L1 时看 L1 内容，L2 时内容已扩展，L3 时内容 + 用户自己的产出。

---

## 第五部分：与三阶递进复习的整合

这个"自增型学习链路"和之前的"三阶递进复习"是**天作之合**：

### 笔记生长驱动复习

```
L1 笔记就绪 → zen 模式爬阶会话 L1（认知识别）
   ↓ FSRS stability 达阈
L2 扩展触发 → 用户勾选 LLM 生成内容 → 笔记扩展
   ↓ content_hash 漂移 → needs_recheck
L2 复习 → zen 模式爬阶会话 L2（辨析/填空，用新扩展的内容）
   ↓ L2 答对
L3 产出 → 用户造句/语境重构 → 自评 → 记录进笔记
   ↓
笔记完全生长（L1 + L2 + L3 用户产出）
```

### 复习驱动笔记生长

反过来，复习表现也触发笔记扩展：

- **leech 检测**：一个词反复 again → 标记"记忆锚点不足" → 触发 LLM 生成更强的 mnemonic
- **L2 持续失败**：标记"辨析不足" → 触发 LLM 补充 synonym_items 的辨析维度
- **L3 自评低**：标记"产出不足" → 触发 LLM 补充更真实的 corpus_items

**闭环**：复习表现 → 诊断笔记弱点 → LLM 扩展 → 笔记更新 → 重卡 → 复习验证扩展效果。

---

## 第六部分：技术架构

### 新增模块

```
src/
├── llm/                          ← 新建（当前绿地）
│   ├── provider.ts               # LlmProvider 接口 + 实现
│   ├── prompts/
│   │   ├── collocations.ts
│   │   ├── examples.ts
│   │   └── synonyms.ts
│   └── generate.ts               # generateL2Content 主入口
├── api/                          ← 新建（开放 API 层）
│   ├── open/
│   │   ├── words.ts              # 只读查询
│   │   ├── extend.ts             # 写入扩展
│   │   └── stats.ts              # 健康度/推荐
│   └── auth.ts                   # Token 鉴权（owner/agent/public）
├── mcp/                          ← 新建（MCP server）
│   ├── server.ts                 # MCP server 入口
│   └── tools.ts                  # 工具定义
└── notes/
    └── growth.ts                 ← 新建（笔记生长状态机）
```

### 数据模型变更

```sql
-- words 表新增列
ALTER TABLE words ADD COLUMN growth_stage text DEFAULT 'l1_seed';
-- 值：l1_seed / l1_stable / l2_pending / l2_growing / l2_stable / l3_active / fully_grown

ALTER TABLE words ADD COLUMN l2_generated_at timestamptz;
ALTER TABLE words ADD COLUMN l2_generated_by text;  -- 'llm' / 'agent' / 'manual'

-- 新增 content_extensions 表（审计 LLM/Agent 写入历史）
CREATE TABLE content_extensions (
  id uuid PRIMARY KEY,
  word_id uuid REFERENCES words(id),
  field text,                    -- 'collocations' / 'corpus_items' / 'synonym_items'
  old_value jsonb,
  new_value jsonb,
  source text,                   -- 'llm:openai' / 'agent:claude-desktop' / 'manual'
  approved_by text,              -- 'user' / 'auto'
  created_at timestamptz DEFAULT now()
);

-- 新增 word_relations 表（如果方向 R 也要做）
CREATE TABLE word_relations (
  id uuid PRIMARY KEY,
  word_a_slug text,
  word_b_slug text,
  relation_type text,           -- synonym/antonym/root_family/prefix/suffix/related
  metadata jsonb,
  source text,                   -- 'manual' / 'agent' / 'llm'
  created_at timestamptz DEFAULT now(),
  UNIQUE(word_a_slug, word_b_slug, relation_type)
);
```

### LLM Provider 抽象

```typescript
// 支持 5 种 provider，用户可切换
type Provider = 'openai' | 'anthropic' | 'deepseek' | 'qwen' | 'ollama';

// 离线场景用 Ollama（本地部署）
// 隐私敏感场景用 Ollama
// 质量优先用 Anthropic/OpenAI
// 成本敏感用 DeepSeek/Qwen
```

### MCP Server 实现

```typescript
// 使用 @modelcontextprotocol/sdk
import { Server } from '@modelcontextprotocol/sdk/server';

const server = new Server({
  name: 'vocab-observatory',
  version: '1.0.0',
}, {
  capabilities: { tools: {} },
});

// 注册 tools（见第三部分层 3）
// 通过 stdio 或 SSE 传输
// Claude Desktop / Cursor 可直接连接
```

---

## 第七部分：未决问题

1. **L1 种子笔记的生成**：当前词库是全量的。迁移到"最小种子"策略——是裁剪现有笔记？还是新建一套？
2. **LLM 生成的质量保证**：如何防止 LLM 编造搭配/例句？词典 API ground truth 的覆盖度？
3. **Agent 写入的权限模型**：Agent 能写哪些字段？需要 owner 预审吗？
4. **content_hash 漂移的粒度**：L2 扩展触发重卡，但重卡是软的（只到期）还是硬的（重置 stability）？
5. **Obsidian 回写**：DB 扩展后如何回写 Obsidian？全量 markdown 重建还是增量 patch？
6. **MCP 传输方式**：stdio（本地）还是 SSE（远程）？Claude Desktop 用 stdio，Cursor 可能用 SSE。
7. **个性化语料库**：用户自备语料库的格式？Obsidian 笔记？纯文本？Anki 牌组导出？
8. **多 Agent 冲突**：多个 Agent 同时写一个词的关系链接怎么办？乐观锁？版本号？
9. **L0 新词的冷启动**：用户遇到一个词库里没有的词，怎么快速生成 L1 种子？
10. **与现有三种复习模式的关系**：自增型链路是取代 zen 还是叠加？

---

## 第八部分：认知科学支撑

| 理论 | 在本设计的体现 |
|------|-------------|
| **深度加工**（Craik & Lockhart） | L1→L2→L3 笔记内容深度递增，从释义到辨析到产出 |
| **编码特异性**（Tulving） | 个性化例句 = 用户自己的语境编码，提取路径更匹配 |
| **生成效应**（Slamecka & Graf） | 用户勾选 + L3 自产 = 自己参与生成，记得更牢 |
| **认知负荷理论**（Sweller） | L1 最小内容 = 低外在负荷；按需扩展 = 相关负荷渐进 |
| **Desirable Difficulty**（Bjork） | 笔记扩展触发重卡 = 合意困难（复习新内容） |
| **元认知校准** | Agent 诊断笔记弱点 = 元认知外部辅助 |
| **语义网络理论** | Agent 探索/更新关系链接 = 知识图谱持续生长 |

---

## 与之前方案的关系

这个"自增型学习链路"不是取代之前的 P/R/F/M，而是**它们的底座**：

- **P 三阶递进**：复习模式层。笔记按 L1/L2/L3 分层生长 = 三阶复习的内容来源
- **R 神经通路**：关系图谱。Agent 共建关系链接 = 神经通路的数据来源
- **F 自由提取**：L3 产出。用户自产内容进笔记 = 自由提取的产出沉淀
- **M 预测验证**：元认知。Agent 诊断弱点 = 元认知外部校准

**这个设计是"笔记系统"层的创新，P/R/F/M 是"复习模式"层的创新。两者正交，组合起来是完整的"自增型学习系统"。**

---

## 下一步

等用户 review 本文档：
1. 确认方向是否对齐
2. 逐项决策未决问题
3. 如方向确认，进入详细设计 + writing-plans

---

## 第九部分：Agent 共建深化（用户补充场景）

### 场景 ①：Agent 被动构建关系图（L2 层）

#### 体验

```
今日复习了 5 个词：abundant, overflow, teem, plentiful, profuse
    ↓
系统把今日学习的词发送给 Agent（自动，复习结束时）
    ↓
Agent 分析这些词之间的关系：
  - abundant ↔ plentiful（近义）
  - abundant ↔ profuse（近义，但 profuse 更强调"过度"）
  - overflow → teem（因果关系：溢出 → 充满）
  - abundant, plentiful, profuse 共享语义场"数量多"
    ↓
Agent 写入 word_relations 表（4 条新关系）
    ↓
下次打开 abundant 的卡片：
  关系图（buildLocalVocabGraph）自动变丰富了——多了 teem/overflow 的链接
  WordRelationLinks 区域多了 profuse 的辨析
```

#### 核心价值：从"消耗"到"积累"

传统复习的心理体验是**消耗型**："今天又忘了 10 个词，还没记下来，这么多同义近义词……"。

Agent 共建关系图把体验翻转成**积累型**：
- 每学一个词，关系网络多一个节点 + 它的边
- 卡片上的关系图越来越密，用户**看到自己的知识网络在长大**
- "我今天学了 5 个词，它们之间居然有 3 条关联"——这是发现，不是遗忘

#### 与方向 R（神经通路）的关系

- **场景 ①**：被动让 Agent 填充关系图**数据**（数据来源）
- **方向 R**：主动用关系图做复习**任务**（任务消费）

①是 R 的前置条件——没有丰富的关系数据，R 的"语义距离排序"等任务无从谈起。

#### 数据流

```typescript
// 复习结束时自动触发
POST /api/open/agent/analyze-today
  body: { words: ['abundant', 'overflow', 'teem', 'plentiful', 'profuse'] }

// Agent 分析后写入
POST /api/open/words/relations/batch
  body: [
    { word_a: 'abundant', word_b: 'plentiful', relation_type: 'synonym', metadata: { delta: 'abundant 更正式' } },
    { word_a: 'abundant', word_b: 'profuse', relation_type: 'synonym', metadata: { delta: 'profuse 强调过度' } },
    ...
  ]
```

**关键**：Agent 写入的关系也要经过用户确认（或可配置自动采纳）。关系图的丰富是渐进的、可控的。

---

### 场景 ②：L3 产出关联真实学习场景（作文 / 长难句）

#### 体验：作文关联

```
用户写了一篇英语作文（雅思写作/考研作文）
    ↓
把作文交给 Agent（粘贴 / 上传 / Obsidian 笔记链接）
    ↓
Agent 对照用户词库分析：
  "你这里用了 important，但你词库里背过 crucial / pivotal / indispensable"
  "make a decision 太基础，你背过 reach a resolution / arrive at a conclusion"
  "这个长句可以重构得更地道……"
    ↓
给出修改指导 + 推荐更好的同义表达/搭配
    ↓
写回 L3 记录：
  - 关联这篇作文（可跳转查看）
  - 关联用到的词（强化 L3 产出能力）
  - 标记"这个词你背过但没用上"——L3 薄弱信号
    ↓
整理好的作文作为"学习资产"存入
```

#### 体验：长难句关联

```
做题（阅读理解/完形填空）碰到一个长难句
    ↓
把句子交给 Agent
    ↓
Agent 分析：
  - 句子结构（主从句/倒装/省略）
  - 句子里的词哪些在用户词库里（高亮）
  - 哪些是词库里没有的生词（建议加入 L0 → L1 种子）
  - 这个句子可以作为哪些词的例句（写入 corpus_items）
    ↓
存为"长难句资产"，关联词库里的词
```

#### 两个新页面：学习资产库

**作文资产库**（`/writing` 或 `/assets/writing`）：
- 用户提交的作文列表
- 每篇作文：原文 + Agent 修改指导 + 关联的词
- 可跳转到关联词的卡片
- 可标记"已吸收"/"待复习"

**长难句资产库**（`/sentences` 或 `/assets/sentences`）：
- 用户收集的长难句列表
- 每条：原句 + 结构分析 + 关联的词
- 可作为例句回写到词卡

**为什么是必然碰到的场景**：备考者每天都在写作文、做阅读。这些产出目前和词库完全脱节——你背了 3000 个词，写作文时还是用 important。L3 的价值就是把**真实产出**和**词库知识**关联起来。

#### 数据模型：学习资产表

```sql
-- 学习资产（作文 + 长难句统一存储）
CREATE TABLE learning_assets (
  id uuid PRIMARY KEY,
  user_id uuid,
  asset_type text NOT NULL,         -- 'writing' / 'sentence'
  title text,
  content text NOT NULL,            -- 原文
  analysis jsonb,                   -- Agent 分析结果（修改指导/结构分析）
  source text,                       -- 'manual' / 'agent' / 'obsidian'
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 资产与词的关联
CREATE TABLE learning_asset_words (
  asset_id uuid REFERENCES learning_assets(id),
  word_id uuid REFERENCES words(id),
  relation text,                     -- 'used'（作文里用到了）/ 'should_have_used'（本该用但没用）/ 'contains'（长难句包含）
  note text,                         -- Agent 的具体建议
  PRIMARY KEY (asset_id, word_id, relation)
);
```

#### MCP 工具扩展

```typescript
const tools = [
  // ... 之前的工具
  {
    name: 'analyze_writing',
    description: '分析用户作文，对照词库推荐更好的同义表达/搭配',
    params: { content: string, context?: string },
    handler: async ({ content, context }) => {
      // 1. 获取用户词库（或今日学习的词）
      // 2. LLM 分析作文 vs 词库
      // 3. 写入 learning_assets + learning_asset_words
      // 4. 返回修改指导
    },
  },
  {
    name: 'analyze_sentence',
    description: '分析长难句，关联词库，可存为资产',
    params: { sentence: string, source?: string },
    handler: async ({ sentence, source }) => {
      // 1. 结构分析
      // 2. 匹配词库
      // 3. 写入 learning_assets + learning_asset_words
    },
  },
  {
    name: 'get_writing_assets',
    description: '获取用户的作文资产库',
    params: { limit?: number },
    handler: async () => { /* 调 GET /api/open/assets/writing */ },
  },
];
```

---

### 场景 ③：跨词书 L2 记录共存（最重要的架构洞察）

#### 问题

之前的设计隐含假设"每个词在词书 A 和词书 B 里是独立记录"。但实际上：

```
考研词书里学了 "abundant"
  → L1 种子 + L2 扩展（考研级别的搭配：abundant evidence / abundant resources）

后来在雅思词书里又遇到 "abundant"
  → 不重新学 L1（早就会了）
  → L2 只是多增几条（雅思级别：abundant rainfall / abundant wildlife）
  → 两条 L2 记录共存，都是你筛选后留下的
```

#### 核心洞察（用户原话）

> "不同词书，不同的地方就是可能用到的搭配不同和例句不同，
> 对 L2 层的笔记状态，只是给他多增一条记录而已，
> 而且这些记录完全可以共存，因为都是你筛选后留下，自己需要的且自己记住的"

**含义**：
- L1 是**全局唯一**的（一个词一份种子笔记，不分词书）
- L2 是**多源共存**的（同一词的搭配/例句可来自考研、雅思、作文、长难句等多个场景）
- L2 每条记录带 **source 标签**（来源词书/学习场景），可按来源筛选展示
- 用户不重复学已掌握的 L1，只在该词出现在新词书时追加 L2 记录

#### 数据模型：独立 L2 内容表（用户已选定）

把 `collocations`/`corpus_items`/`synonym_items`/`antonym_items` 等 JSONB 数组列**从主存降级为缓存/聚合视图**，真正的 L2 内容存到独立的 `word_l2_content` 表：

```sql
-- L2 内容独立表（每条 L2 扩展内容一行）
CREATE TABLE word_l2_content (
  id uuid PRIMARY KEY,
  word_id uuid NOT NULL REFERENCES words(id),
  field text NOT NULL,              -- 'collocation' / 'corpus' / 'synonym' / 'antonym' / 'mnemonic_extra'
  content jsonb NOT NULL,           -- 具体内容（CollocationItem / CorpusItem / SynonymItem 等）
  source text NOT NULL,             -- '考研' / '雅思' / '作文' / '长难句' / 'manual' / 'agent:claude'
  source_ref uuid,                  -- 可选：关联 learning_assets.id（作文/长难句来源）
  approved_by text DEFAULT 'user',  -- 'user' / 'auto'（Agent 自动采纳）
  approved_at timestamptz,
  created_at timestamptz DEFAULT now(),
  is_active boolean DEFAULT true    -- 软删除（用户可禁用某条而不删）
);

-- 索引：按词 + 字段查所有来源
CREATE INDEX idx_l2_content_word_field ON word_l2_content(word_id, field) WHERE is_active = true;
CREATE INDEX idx_l2_content_source ON word_l2_content(source) WHERE is_active = true;
```

#### words 表的 JSONB 列怎么处理

**方案：降级为"聚合缓存"**

`words.collocations` 等 JSONB 列不再是被直接写入的主存，而是 `word_l2_content` 表的**聚合视图**：

```typescript
// 当 word_l2_content 有写入/删除时，触发聚合更新 words 表的 JSONB 列
async function refreshWordL2Cache(wordId: string) {
  const l2Contents = await db.query.wordL2Content.findMany({
    where: and(
      eq(wordL2Content.word_id, wordId),
      eq(wordL2Content.is_active, true)
    )
  });

  // 按 field 分组，聚合回 words 表的 JSONB 列
  const grouped = groupBy(l2Contents, 'field');
  await db.update(words).set({
    collocations: grouped.collocation?.map(c => c.content) ?? [],
    corpus_items: grouped.corpus?.map(c => c.content) ?? [],
    synonym_items: grouped.synonym?.map(c => c.content) ?? [],
    antonym_items: grouped.antonym?.map(c => c.content) ?? [],
  }).where(eq(words.id, wordId));
}
```

**为什么保留 JSONB 缓存**：
- `ZenFlashcard` 等组件已按 JSONB 列渲染，不改前端
- 读取性能好（一次查 words 表拿到所有内容，不用 join）
- content_hash 漂移检测仍基于 JSONB 列

**写入路径**：
- LLM/Agent 写 → `word_l2_content` 表（真实存储）
- 触发 `refreshWordL2Cache` → 更新 `words` 表 JSONB 列（缓存）
- content_hash 重新计算 → 漂移检测 → 重卡

#### 跨词书查询示例

```typescript
// 查 abundant 的所有搭配（跨词书）
const allCollocations = await db.query.wordL2Content.findMany({
  where: and(
    eq(wordL2Content.word_id, abundantId),
    eq(wordL2Content.field, 'collocation'),
    eq(wordL2Content.is_active, true)
  )
});
// 返回：[{source:'考研', content:{phrase:'abundant evidence'}}, {source:'雅思', content:{phrase:'abundant rainfall'}}]

// 只看雅思词书相关的 L2 内容
const ieltsCollocations = allCollocations.filter(c => c.source === '雅思');

// 卡片展示时可按 source 分组：
// ▸ 考研搭配：abundant evidence / abundant resources
// ▸ 雅思搭配：abundant rainfall / abundant wildlife
// ▸ 作文中用过的：abundant opportunities（来自作文资产关联）
```

#### wordbook_items 表的角色变化

当前 `wordbook_items` 表把词加入词书。跨词书 L2 共存后：

```sql
-- wordbook_items 记录"这个词在哪些词书里"
-- 但不存 L2 内容（L2 在 word_l2_content 表，带 source 标签）

-- 查"考研词书里有哪些词"
SELECT w.* FROM words w
JOIN wordbook_items wi ON wi.word_id = w.id
WHERE wi.wordbook_id = '考研词书id'

-- 查"abundant 在考研词书里的 L2 内容"
SELECT * FROM word_l2_content
WHERE word_id = 'abundant_id'
  AND source = '考研'
  AND is_active = true
```

**词书 = 词的集合**（哪些词属于这个词书），**L2 内容 = 按来源标记的扩展记录**。两者正交。

-


---

### 跨场景整合：self-growing 的完整画面

```
用户在考研词书学到 abundant
  → L1 种子（全局唯一）
  → L2 扩展（考研来源）：abundant evidence / abundant resources
  → Agent 发现 abundant ↔ plentiful 近义，写入关系

后来在雅思词书遇到 abundant
  → L1 不重学（已 stable）
  → L2 追加（雅思来源）：abundant rainfall / abundant wildlife
  → 两条 L2 共存

用户写了一篇作文，用了 abundant opportunities
  → Agent 分析作文，关联 abundant
  → 写入 learning_assets + learning_asset_words（relation=used）
  → abundant 的卡片上显示“你在作文中用过：abundant opportunities”

用户做阅读碰到长难句 "...with abundant rainfall nurturing..."
  → Agent 分析长难句，关联 abundant
  → 长难句存为资产，可跳转
  → abundant 的 corpus_items 多一条（来源：长难句）

Agent 分析今日学习：abundant / overflow / teem 有关系
  → 写入 word_relations
  → abundant 的关系图变丰富

最终 abundant 的“知识网络”：
  L1 种子（1 份，全局）
  L2 搭配（4 条，来自考研+雅思+作文+长难句）
  L2 例句（2 条，来自作文+长难句）
  L2 同义辨析（3 条，来自 Agent 构建）
  关系链接（5 条，来自 Agent 构建）
  L3 产出记录（1 篇作文关联）

  → 这不是“词典条目”，这是“你的 abundant”——独一无二的、随你学习生长的。
```

---

## 第十部分：修订后的数据模型总览

### 表结构全景

```
words (全局唯一词实体)
  ├─ L1 字段（种子，全局唯一）
  │   ├─ lemma, ipa, pos, short_definition
  │   ├─ definition_md, prototype_text
  │   ├─ metadata.morphology (词根词缀 + narrative)
  │   ├─ metadata.mnemonic (记忆锚点)
  │   └─ metadata.semantic_chain (语义链路)
  │
  ├─ L2 缓存字段（聚合自 word_l2_content，非主存）
  │   ├─ collocations (jsonb, 聚合缓存)
  │   ├─ corpus_items (jsonb, 聚合缓存)
  │   ├─ synonym_items (jsonb, 聚合缓存)
  │   └─ antonym_items (jsonb, 聚合缓存)
  │
  ├─ growth_stage (l1_seed / l1_stable / l2_pending / l2_growing / l2_stable / l3_active / fully_grown)
  └─ content_hash (漂移检测)

word_l2_content (L2 扩展内容，多源共存)
  ├─ word_id → words.id
  ├─ field (collocation / corpus / synonym / antonym)
  ├─ content (jsonb, 具体内容)
  ├─ source (考研 / 雅思 / 作文 / 长难句 / manual / agent:xxx)
  ├─ source_ref → learning_assets.id (可选)
  ├─ approved_by (user / auto)
  └─ is_active (软删除)

word_relations (关系图谱，Agent 共建)
  ├─ word_a_slug, word_b_slug
  ├─ relation_type (synonym / antonym / root_family / prefix / suffix / related)
  ├─ metadata (jsonb, 辨析信息等)
  └─ source (manual / agent / llm)

learning_assets (学习资产：作文 + 长难句)
  ├─ asset_type (writing / sentence)
  ├─ content (原文)
  ├─ analysis (jsonb, Agent 分析)
  └─ source

learning_asset_words (资产与词的关联)
  ├─ asset_id → learning_assets.id
  ├─ word_id → words.id
  ├─ relation (used / should_have_used / contains)
  └─ note

content_extensions (审计日志，所有写入历史)
  ├─ word_id
  ├─ field, old_value, new_value
  ├─ source (llm:openai / agent:claude / manual)
  └─ approved_by

wordbook_items (词书成员关系，不变)
  └─ word_id + wordbook_id (词属于哪个词书，不存 L2)

user_word_progress (用户复习进度，不变)
  └─ FSRS 调度状态（word_id + user_id + wordbook_id）
```

---

## 第十一部分：修订后的未决问题

### 已决策（本次会话）

| 问题 | 决策 |
|------|------|
| L2 内容存储模型 | ✅ 独立 word_l2_content 表（每条带 source 标签） |
| 跨词书 L2 共存 | ✅ L1 全局唯一，L2 多源共存，按 source 筛选 |
| words 表 JSONB 列 | ✅ 降级为聚合缓存，真实存储在 word_l2_content |
| 作文/长难句存储 | ✅ 统一存 learning_assets 表 + learning_asset_words 关联表 |

### 仍待决策

1. **L1 种子笔记的迁移**：现有全量笔记怎么裁剪成 L1 种子？是保留全量但标记 L1 字段，还是真的删除 L2 内容？
2. **Agent 写入的权限模型**：Agent 写 word_relations 和 word_l2_content 需要 owner 预审吗？还是可配置“自动采纳”？
3. **content_hash 漂移的粒度**：L2 扩展触发重卡——软（只到期）还是硬（重置 stability）？建议软。
4. **Obsidian 回写**：DB 的 word_l2_content 怎么回写 Obsidian？按 source 分 section？还是不回写（Obsidian 只管 L1）？
5. **MCP 传输方式**：stdio（本地 Claude Desktop）还是 SSE（远程）？
6. **作文/长难句页面**：放哪个路由？/writing + /sentences？还是 /assets/writing + /assets/sentences？
7. **L0 新词冷启动**：词库里没有的词，Agent 能否直接生成 L1 种子？需要什么 prompt？
8. **多 Agent 冲突**：乐观锁？版本号？last-write-wins？
9. **source 标签的标准化**：source 是自由文本还是枚举（考研/雅思/托福/GRE/作文/长难句/manual/agent）？
10. **L2 内容的去重**：同一搭配被两个来源生成了怎么办？按 phrase 去重还是允许重复？

---

## 下一步

等用户 review 本文档（含本次补充）：
1. 确认三个补充场景的方向对齐
2. 逐项决策修订后的未决问题
3. 如方向确认，进入详细设计 + writing-plans


---

## 第十二部分：核心架构决策（用户最终确认）

本部分记录用户对未决问题的最终决策，这些决策重塑了整个架构。

### 决策 1：L1 / L2 复习隔离（双轨复习系统）

#### 核心洞察（用户原话）

> "L1 层其实是用户重复，我们的复习范式就是做一个底线维护……
> 重复是为了打下基础，进入 L2 则算是一个长效维护，我觉得完全可以隔离……
> 因为 L1 是弱约束，用户的自主复习量完全是会超过提醒复习的"

#### 双轨架构

```
┌─────────────────────────────────────────────────┐
│  L1 复习轨（底线维护，弱约束）                   │
│  复习模式：现有 zen + free zen（不改）           │
│  调度表：user_word_progress（现有，FSRS）        │
│  目的：打下基础，让词进入 L2                     │
│  特点：                                           │
│    · FSRS 是"提醒"，但用户自主重复量 > 提醒量    │
│    · free zen 让用户随时重复，不消耗 FSRS 配额   │
│    · L1 是弱约束，重复是手段不是目的             │
└─────────────────────────────────────────────────┘
                    │ L1 stability 达阈
                    ▼
┌─────────────────────────────────────────────────┐
│  L2 复习轨（长效维护，独立调度）                 │
│  复习模式：暂用 zen 翻转（最小改动）             │
│           L2 专属模式后补（增量设计）            │
│  调度表：user_word_l2_progress（新建）           │
│  目的：长效维持应用能力                          │
│  特点：                                           │
│    · 独立于 L1 的 FSRS 调度                      │
│    · L2 内容扩展触发 L2 重卡，不影响 L1          │
│    · L2 会给出新的复习方式补充                   │
└─────────────────────────────────────────────────┘
```

#### 数据模型：L2 独立进度表

```sql
CREATE TABLE user_word_l2_progress (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  word_id uuid NOT NULL REFERENCES words(id),
  l2_stability float,
  l2_difficulty float,
  l2_retrievability float,
  l2_due_at timestamptz,
  l2_last_reviewed_at timestamptz,
  l2_review_count int DEFAULT 0,
  l2_weak boolean DEFAULT false,
  l3_pending boolean DEFAULT false,
  l3_self_assessments jsonb DEFAULT '[]',
  predicted_retrievability float,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, word_id)
);
```

L1 的 user_word_progress 完全不改。L2 调度/重卡/薄弱标记都在 user_word_l2_progress。两者通过 word_id 关联但互不干扰。

#### content_hash 漂移的双轨处理

```
L1 内容变更（词根/释义/记忆锚点改动）：
  → 触发 user_word_progress.needs_recheck = true（软重卡，只到期）
  → 不重置 L1 stability

L2 内容扩展（新增搭配/例句/同反义）：
  → 触发 user_word_l2_progress.l2_due_at = now()（L2 软重卡）
  → 完全不影响 user_word_progress（L1 隔离）
```

### 决策 2：词书从"独立空间"降级为"词的属性"

#### 核心洞察（用户原话）

> "词书现在只是成为单词的一个属性，这个词在什么词书上有，
> 不再是独立空间（也可以设置，不过筛选一下就可以出来了，
> 到时候可能要封锁下其他词，比如延缓记忆褪色，掉太快心疼，哈哈）"

#### 架构变化

```
旧：词书 = 独立空间
    wordbook_items 把词加入词书，每个词书独立的复习进度
    findDueCards 绑定单 wordbookId

新：词书 = 词的属性标签
    wordbook_items 记录"这个词在哪些词书里"（多对多）
    复习进度按 word（全局），不按 (word, wordbook)
    筛选按 wordbook 属性过滤（"今天只复习考研词书的词"）
    可选"封锁其他词书"（聚焦模式，延缓其他词的褪色）
```

#### "封锁其他词书"机制（用户创意）

用户想要"专注考研词书时，雅思词书的词延缓褪色"——情感友好设计：

```typescript
// 当用户进入"考研词书专注模式"
// 非该词书的词的 L1 due_at 暂时冻结（不前进）
// 退出专注模式后恢复
// 心理效果：不用担心"专注考研时雅思词都忘了"
```

实现：focus_wordbook_id 字段，设置时非该词书的词的 due_at 暂停推进（或在计算 retrievability 时用"冻结时间"而非"真实时间"）。

#### 查询变化

```sql
-- 旧：绑定单 wordbook
SELECT * FROM user_word_progress
WHERE user_id = $1 AND wordbook_id = $2 AND due_at <= now()

-- 新：按词书属性过滤，但进度全局
SELECT uwp.* FROM user_word_progress uwp
JOIN wordbook_items wi ON wi.word_id = uwp.word_id
WHERE uwp.user_id = $1
  AND wi.wordbook_id = $2
  AND uwp.due_at <= now()
```

### 决策 3：Agent 写入需用户预审（审查即学习）

#### 核心洞察（用户原话）

> "对于将要建立的连接，支持用户审查后勾选（审查也是学习的一部分，
> 刚好阅读关系）……对于 relation，也支持局内解绑，
> 反正就是搭线连线（数据删除得当即可）"

#### Agent 关系提议的审查流程

```
Agent 分析今日学习 → 发现 abundant ↔ plentiful 近义
  ↓
Agent 生成"关系提议"（可编辑的 md）：
  ┌──────────────────────────────────────┐
  │ abundant ↔ plentiful                  │
  │ 关系类型：近义                         │
  │                                       │
  │ 【Agent 辨析】                        │
  │ abundant：强调"数量多得溢出"，语感正式  │
  │ plentiful：强调"供应充足"，语感中性    │
  │ 核心区别：abundant 更文学化，          │
  │           plentiful 更日常化           │
  │                                       │
  │ 【你的补充（可编辑）】                 │
  │ ___________________________           │
  └──────────────────────────────────────┘
  ↓
用户阅读（审查 = 学习）+ 可编辑补充自己的理解
  ↓
勾选"采纳" → 写入 word_relations
  或 "跳过" → 不写入（但 Agent 学习到"这条关系用户不认可"）
  或 "采纳并编辑" → 用编辑后的内容写入
  ↓
事后可在关系图上"解绑"（删除关系，软删除标记）
```

#### 数据模型：关系提议表

```sql
CREATE TABLE word_relation_proposals (
  id uuid PRIMARY KEY,
  word_a_slug text NOT NULL,
  word_b_slug text NOT NULL,
  relation_type text NOT NULL,
  agent_analysis text,
  user_edit text,
  status text DEFAULT 'pending',
  proposed_by text,
  reviewed_at timestamptz,
  adopted_at timestamptz,
  unbound_at timestamptz,
  created_at timestamptz DEFAULT now()
);
```

"审查即学习"的认知科学支撑：用户阅读 Agent 的辨析 = 精细编码（elaboration），自己补充理解 = 生成效应（generation）。比直接显示关系图更强。

### 决策 4：L0 新词冷启动（导入板 + 生词本 + 模板）

#### 核心洞察（用户原话）

> "可以设置一个新词导入板，比如做题时，用户遇到的不会的词
> 可以写入这个导入板，做完题整理的时候，可以选择标记生词，
> 加入生词本……对于不在词库中的生词，可以筛出来，提示用户复制，
> 自行去找 agent 生成相关内容（格式规范），然后批量导入"

#### 流程

```
做题遇到生词 "ephemeral"
  ↓
快速写入"导入板"（临时收集，一键添加，不打断做题）
  ↓
做完题 → 整理导入板
  ↓
对每个生词判断：
  ├─ 词库里已有 → 直接加入"生词本"（开始 L1 学习）
  └─ 词库里没有 → 筛出来提示
      ↓
      用户复制生词列表 → 去外部 chat 模型（不耗项目 token）
      → 按 L1 种子模板 skill 规范生成内容
      → 批量导入
  ↓
生词本里的词：
  ├─ 可当日学习（立即进入 L1 队列）
  └─ 可放之后学习（标记为"待启动"，不进队列直到用户激活）
```

#### L1 种子模板 Skill

为外部 Agent（Claude/Cursor/ChatGPT）提供标准化的 skill 文档：

```markdown
# Skill: 生成 L1 种子笔记

## 输入
- 单词（lemma）
- 可选：词性、语义场、目标考试级别

## 输出格式（Obsidian markdown）
[严格的 frontmatter + 4 个 L1 section 模板]

## 要求
- 核心释义：一句话，不超过 120 字
- 词根词缀：结构化拆分（prefix/root/suffix + gloss）+ 叙事
- 词源叙事：画面化语言，建立"具身画面"
- 记忆链路：一字一词 → 延伸中心 → 链路展开

## 质量标准
- 不要堆砌（贪多嚼不烂）
- 叙事要有画面感，不要词典式干瘪
- 记忆链路要有逻辑递进
```

#### 数据模型：导入板

```sql
CREATE TABLE import_tray (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  word_text text NOT NULL,
  context text,
  source text,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);
```

### 决策 5：L1 种子笔记新建一套

用户确认新建一套 L1 种子笔记，不裁剪现有全量笔记。

#### 迁移策略

```
现有词库（全量） → 保留作为"参考词典"（L2+ 内容来源）
新建 L1 种子笔记 → 只含 4 字段（释义 + 词根 + 叙事 + 链路）
  ↓
推荐方案：
  - 新建 Obsidian 目录 L1_Seeds/（与现有 L0_基础词/ 并存）
  - DB 层新建 growth_stage 字段，追踪生长状态
  - 物理分离让"L1 种子"和"全量参考"清晰可辨
```

#### 架构设计参与

用户邀请参与 L1 种子笔记架构设计。核心问题：
- L1 种子的字段子集如何从现有全量笔记提取（脚本化）
- 新建目录的命名约定
- 种子与全量的关联（slug 一致，content_hash 独立？）
- 导入脚本的改造（gen_l0_notes_v2.py → gen_l1_seeds 版本？）

### 决策 6：LLM 生成质量保证

```
搭配生成 → 独立 LLM 子功能 + 词典 API ground truth
  ├─ 词典 API（Cambridge/Oxford）取候选搭配
  ├─ LLM 从候选中筛选 + 补充语感标注
  └─ 严格选择：只保留高频 + 考试有用的

例句生成 → 限制 prompt（内置）+ 用户需求 prompt（外置）
  ├─ 内置 prompt 保证：语法正确 + 用法正确 + 适合目标级别
  ├─ 用户 prompt 定制：领域/风格/难度偏好
  └─ 不依赖词典 API（例句是生成的，不是查的）
```

### 决策 7：Obsidian 回写（增量 patch）

```
L2 内容扩展 → 增量 patch 到 Obsidian 笔记
  ├─ 搭配 → 在 "## 搭配与短语" section 追加（带 source 标注）
  ├─ 例句 → 在 "## 真题语料关联" section 追加（带 source 标注）
  ├─ 同反义 → 在 "## 同义词辨析" / "## 反义词" section 追加
  └─ 每个 patch 标注来源（如 <!-- L2-source: 雅思 -->）
```

增量 patch 的挑战：定位 section（按 ## 标题）、去重、section 不存在时创建。Obsidian 插件需扩展 DB→Obsidian 回写能力。

### 决策 8：MCP 延后，先做开放 API

```
Phase 1：开放 REST API（只读 + 写入）
  ├─ GET /api/open/words/today
  ├─ GET /api/open/words/:slug
  ├─ GET /api/open/words/:slug/relations
  ├─ POST /api/open/words/:slug/extend
  ├─ POST /api/open/words/relations/batch
  └─ GET /api/open/stats/review-health

Phase 2：MCP Server（封装 Phase 1 的 API 为工具）
```

### 决策 9：个性化语料库 = 个人数据累积

```
"个性化语料库"不是独立功能，而是 learning_assets 的复用：
  ├─ 用户写的作文（asset_type='writing'）→ 例句生成时的语料源
  ├─ 收集的长难句（asset_type='sentence'）→ 例句生成时的语料源
  └─ LLM 生成例句时，优先从 learning_assets 检索相关语境
```

和场景②天然融合——作文/长难句既是 L3 产出关联，又是 L2 例句生成的个性化语料。

### 决策 10：L2 暂用 zen 翻转（最小改动）

```
L1 复习：现有 zen + free zen（不改）
L2 复习：暂用 zen 翻转卡片，但卡片展示 L2 扩展内容
  ├─ L2 卡片正面：lemma + "L2 模式" 标识
  ├─ L2 卡片背面：L2 扩展内容（搭配/例句/辨析，按 source 分组）
  └─ L2 专属模式（爬阶/辨析任务等）后补
```

---

## 第十三部分：修订后的系统全景

### 双轨 + 自增型 完整画面

```
                    ┌─────────────────────┐
                    │   Obsidian Vault     │
                    │  ├─ L1_Seeds/ (新)   │  ← 新建的最小种子
                    │  └─ L0_基础词/ (旧)  │  ← 保留作参考词典
                    └──────────┬──────────┘
                               │ 单向同步（现有）+ 增量回写（新）
                               ▼
┌──────────────────────────────────────────────────┐
│              words 表（全局唯一词实体）             │
│  ├─ L1 字段（种子，全局唯一）                      │
│  ├─ L2 缓存字段（聚合自 word_l2_content）          │
│  ├─ growth_stage                                   │
│  └─ content_hash                                   │
└──────────────────────────────────────────────────┘
          │                            │
          │ L1 轨                      │ L2 轨
          ▼                            ▼
┌──────────────────┐          ┌──────────────────┐
│ user_word_progress│          │user_word_l2_     │
│ (L1 FSRS，现有)   │          │  progress        │
│ zen + free zen    │          │ (L2 独立 FSRS)   │
│ 弱约束底线维护    │          │ zen 翻转（暂）   │
└──────────────────┘          └──────────────────┘
          │                            │
          │  wordbook_items            │
          │  (词书=属性标签)            │
          │  可筛选/可封锁              │
          ▼                            ▼
┌──────────────────────────────────────────────────┐
│              word_l2_content (多源共存)            │
│  每条带 source: 考研/雅思/作文/长难句/agent       │
└──────────────────────────────────────────────────┘
          ▲                            ▲
          │                            │
┌─────────┴────────┐         ┌────────┴─────────┐
│ learning_assets   │         │ word_relation_   │
│ (作文/长难句资产) │         │   proposals      │
│ + asset_words     │         │ (Agent提议待审)  │
└──────────────────┘         └────────┬─────────┘
                                      │ 用户审查
                                      ▼
                             ┌──────────────────┐
                             │ word_relations   │
                             │ (真实关系图谱)    │
                             └──────────────────┘

┌──────────────────────────────────────────────────┐
│              开放 API（Phase 1）+ MCP（Phase 2）  │
│  外部 Agent 读写笔记系统                          │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│              import_tray（导入板）                 │
│  做题收集生词 → 整理 → 生词本/批量导入            │
└──────────────────────────────────────────────────┘
```

### 复习体验全景（双轨）

```
日常 L1 复习（zen / free zen）：
  到期词 → 翻转卡片看 L1 种子内容 → FSRS 评级 → 维持 L1 稳定
  free zen：随时重复，不消耗配额，打基础

L1 stability 达阈 → 词进入 L2 待扩展：
  提示用户 → LLM + 词典生成 L2 草稿 → 用户勾选 → 写入 word_l2_content
  → 触发 L2 重卡（不影响 L1）

L2 复习（暂用 zen 翻转）：
  L2 到期词 → 翻转卡片看 L2 扩展内容（搭配/例句/辨析，按 source 分组）
  → L2 FSRS 评级 → 长效维持应用能力

做题遇到生词 → 导入板 → 整理 → 生词本 / 批量导入 L1 种子

写作文 / 遇长难句 → 给 Agent → 关联词库 → 存为 learning_assets
  → 词卡显示"你在作文中用过这个词"

复习结束 → 今日词汇发给 Agent → Agent 提议关系 → 用户审查（审查即学习）
  → 采纳的写入 word_relations → 关系图变丰富
```

---

## 第十四部分：最终未决问题（精简后）

### 已全部决策

| # | 问题 | 决策 |
|---|------|------|
| 1 | L1 种子生成 | 新建一套（L1_Seeds/ 目录），邀请参与架构设计 |
| 2 | LLM 质量保证 | 搭配：词典 API ground truth + 严格筛选；例句：内置 prompt + 用户 prompt |
| 3 | Agent 写入权限 | 需预审，Agent 生成可编辑 md，用户审查后采纳，支持事后解绑 |
| 4 | content_hash 漂移 | L1/L2 隔离：L1 软重卡，L2 独立重卡不影响 L1 |
| 5 | Obsidian 回写 | 增量 patch（按 section 定位追加，带 source 标注） |
| 6 | MCP 传输 | 延后，先做开放 REST API |
| 7 | 个性化语料库 | = learning_assets 复用（作文/长难句作为例句语料源） |
| 8 | 多 Agent 冲突 | 个人使用好处理，届时确认 |
| 9 | L0 冷启动 | 导入板 + 生词本 + L1 种子模板 skill + 批量导入 |
| 10 | 与现有模式关系 | zen/free zen 服务 L1，L2 暂用 zen 翻转，L2 专属模式后补 |

### 新增的待探索问题

1. **L1 种子笔记的字段提取脚本**：从现有全量笔记提取 4 字段的自动化方案
2. **词书"封锁"机制的实现**：focus_wordbook_id 如何冻结其他词的 due_at
3. **L2 专属复习模式的设计**：暂用 zen 翻转之后，L2 应该有什么独特复习方式
4. **Agent 审查 UI 的形态**：关系提议的 md 编辑器长什么样
5. **L1 种子模板 skill 文档**：放在哪、格式怎么定、如何让外部 Agent 识别

---

## 下一步

所有核心架构决策已确认。可以进入：
1. **L1 种子笔记架构设计**（用户邀请参与）—— 字段提取脚本、目录结构、与现有全量的关系
2. **详细实现规划**（writing-plans）—— 按优先级分 Phase
3. **先做某个垂直切片**（如先跑通"L1 种子 → L2 扩展 → L2 重卡"最小闭环）


---

## 延后决策：L2 初始化策略（从 L1 继承）

**状态**：延后到 Phase 2 建好 user_word_l2_progress 表后再做
**日期**：2026-07-07 确认延后

### 问题

双轨复习系统需要 L2 首次复习时从 L1 继承 stability/difficulty。当前 FSRS 模块只有单轨 applyReviewAnswer，不支持 L2 初始化。

### 三种候选策略

| 策略 | l2_stability | l2_difficulty | l2_reps | 优劣 |
|------|-------------|---------------|---------|------|
| A 直接继承 | = L1 stability | = L1 difficulty | 0 | 最简单但高估 L2 稳定性（L2 任务更难） |
| B 衰减继承（推荐） | = L1 × 0.5 | = L1 difficulty | 0 | 折中，L2 早期更频繁复习 |
| C 独立校准 | = 0 | = L1 difficulty | 0 | 最干净但早期调度不准 |

### 推荐方案 B 的理由

1. 难度可继承（词本身的难度和任务类型关系小）
2. stability 需衰减（L2 任务更难，直接继承会高估）
3. 衰减系数 0.5 是经验值，待 L2 数据积累后校准

### 延后理由

- L2 轨道（user_word_l2_progress 表）还不存在，现在写初始化逻辑是 YAGNI
- 衰减系数需要真实 L2 复习数据校准
- Phase 2 的建表 + LLM 扩展闭环优先级更高

### 实现时机

Phase 2 建好 user_word_l2_progress 表 + L2 Service 骨架后，回来实现：
- src/fsrs/adapter.ts 加 initializeL2FromL1(l1Stability, l1Difficulty) 函数
- src/services/ 加 startL2Tracking(wordId, l1Progress) 方法
- 衰减系数先用 0.5，跑数据后再调


---

## 延后决策：LLM Provider 接入设计

**状态**：延后到 Phase 2（L2 扩展闭环）时实现
**日期**：2026-07-07 确认延后
**前提**：调 LLM API 不需要 Rust/Python，Node.js + Hono 完全胜任（HTTP 请求而已）

### 核心澄清

"做 LLM 推理" vs "调 LLM API" 是两件事：
- 做 LLM 推理 = 自己跑模型（要 GPU），才需要 Python/Rust
- 调 LLM API（我们的场景）= 发 HTTP 请求到厂商服务器，任何语言都行

我们的后端只做：组装 prompt → 发 HTTP 请求 → 解析 JSON 响应 → 返回草稿给用户勾选。

### 5 个设计要点

1. **Provider 抽象**——LlmProvider 接口，OpenAI/Anthropic/Ollama 各实现一个，换厂商不重写
2. **Prompt 管理**——prompt 是代码不是字符串，每个功能（搭配/例句/同反义）分文件
3. **错误处理**——超时重试 2 次指数退避、429 限流等待、401 key 无效不重试、非 JSON 响应容错
4. **成本控制**——token 计数、每日预算上限、相同 prompt 缓存 24h、用户勾选后才"消费"生成结果
5. **离线降级**——Ollama 优先（免费离线）→ 云 API 回退 → 都不可用则跳过 LLM 功能不阻塞复习

### 文件结构（Phase 2 实现时创建）

src/llm/
  provider.ts            — LlmProvider 接口
  providers/
    openai.ts            — OpenAI/DeepSeek（API 兼容）
    anthropic.ts         — Anthropic Claude
    ollama.ts            — 本地 Ollama（离线免费）
  prompts/
    collocations.ts      — 搭配生成
    examples.ts          — 例句生成
    synonyms.ts          — 同反义辨析
  retry.ts               — 重试 + 指数退避
  usage-tracker.ts       — token 计数 + 预算
  cache.ts               — prompt 结果缓存
  parser.ts              — LLM 响应 JSON 容错解析
  index.ts               — createLlmProvider(config) 工厂

### 配置项

LLM_PROVIDER=ollama          (ollama | openai | anthropic | deepseek)
LLM_API_KEY=sk-xxx           (ollama 不需要)
LLM_MODEL=qwen2.5:7b         (或 gpt-4o / claude-sonnet / deepseek-chat)
LLM_DAILY_TOKEN_LIMIT=50000
OLLAMA_BASE_URL=http://localhost:11434

### 数据流

用户点"扩展 L2"
  -> 检查预算 + 缓存
  -> 组装 prompt
  -> 选 provider（优先 Ollama，回退云 API）
  -> provider.generate()（HTTP 请求到 LLM API）
  -> 解析 JSON（容错 + 重试）
  -> 记录 token 用量
  -> 返回草稿给用户勾选（不直接写 DB）
  -> 用户勾选 -> 写 word_l2_content + L2 重卡

### arch 约束

dependency-cruiser 已有 http-no-llm-direct 规则：http 层不得直接调 llm provider，必须经 service 层。LLM 调用是业务逻辑，由 service 层发起。
