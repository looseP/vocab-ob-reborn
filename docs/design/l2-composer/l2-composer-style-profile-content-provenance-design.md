# L2 Composer / Style Profile / Content Schema / Provenance 设计稿

> Status note: this is an exploratory design document. The binding contract is
> ADR-0006 plus `docs/operations/l2-composer-api-contract.md`. Phase 2E.1
> supersedes any older wording that permits ungrounded LLM collocations or
> legacy-array external-prompt output. All composer collocation paths must be
> dictionary-grounded, and v1 non-manual collocation items must carry dictionary
> evidence.

> 状态：Draft v0.1  
> 范围：仅讨论 V2 项目的 L2 内容生成、编辑、确认与审计机制。  
> 目标：把“搭配 / 例句”的 L2 生成入口从聊天式复杂系统收敛为单轮、固定入口、可编辑、可审计、可扩展的 Composer 模式。

---

## 0. 设计结论摘要

当前更推荐把 L2 的用户侧 LLM 入口设计为 **L2 Composer**，而不是聊天系统。

其中需要特别区分：**搭配不应按纯 LLM 自由生成设计**。搭配更接近语言事实，必须尽量有 ground truth。推荐采用 **dictionary-grounded collocation** 模式：先从免费词典 / 搭配 API 获取候选，再由 LLM 做筛选、解释、排序、补充语境和结构化格式化。

核心理由：

1. L2 的目标不是泛对话，而是把词从“认识”推进到“掌握”：搭配、例句、结构化扩展、语义连接。
2. 用户当前真实交互需求是固定入口：`搭配` / `例句`，并不需要长期聊天上下文。
3. 单轮生成 + refresh + 用户编辑 + confirm 写入，已经覆盖 MVP 所需闭环。
4. 不保存聊天记录可以显著降低数据模型复杂度、token 成本、审计难度和未来迁移成本。
5. 真正需要 agent 能力的部分应放在另一个入口：L2 Graph / MCP / Open API，而不是混进 Composer。

推荐分层：

- **L2 Composer**：用户主动生成、粘贴、手动编辑搭配和例句。
- **Style Profile**：控制生成风格，如考研作文、学术写作、日常口语。
- **Content Schema**：约束每条搭配/例句的结构、校验、展示和入库。
- **Provenance**：记录每条内容从哪里来、是否被编辑、由哪个模型或外部工具产生。
- **Dictionary Grounding**：搭配优先以词典 API 返回为事实来源，LLM 不作为搭配事实的唯一来源。
- **L2 Graph / Agent API**：后续单独设计，负责同义词、反义词、词根、语义网络、复习包推荐。

---

## 1. L2 Composer 设计

### 1.1 定义

L2 Composer 是 L2 层的固定内容生成与编辑器。

它不是 chat，不维护聊天历史，不以“连续对话”为核心。它围绕一个单词、一个字段、一次生成意图工作。

固定入口：

- `collocation`：搭配
- `example`：例句

生成来源：

- `internal_llm`：内部 LLM 生成
- `external_chat`：用户从外部 ChatGPT / Claude / Kimi / 其他 chat 工具粘贴
- `manual`：用户手动输入
- `dictionary`：词典 API 原始建议，后续接入
- `dictionary_llm_refined`：词典建议经 LLM 筛选、解释、排序、格式化后写入

对 `collocation` 字段，默认推荐来源不是 `internal_llm`，而是 `dictionary_llm_refined`。

原因：

1. 搭配属于语言共同使用事实，不应主要靠模型想象。
2. 免费词典 / 搭配 API 可以提供 ground truth 候选。
3. LLM 的价值在于把词典候选变得适合学习：去重、筛选高频项、解释中文含义、给出适合当前风格的例句。
4. Provenance 可以记录词典来源与 LLM refinement 过程，方便后续质量审计。

### 1.2 用户流程

#### A. 内部 LLM 生成

1. 用户进入某个 word 的 L2 页面。
2. 选择固定入口：`搭配` 或 `例句`。
3. 选择风格包，例如：默认、考研作文、学术写作、日常口语。
4. 点击生成。
5. 后端调用 LLM，返回结构化 draft。
6. 前端展示 draft item 列表。
7. 用户可以删除、修改、补充每条 item。
8. 用户点击 confirm。
9. 后端进行字段级 schema 校验。
10. 校验通过后写入 `word_l2_content`，刷新 `words` JSONB 缓存，重算 L2 hash，并标记 L2 stale/recheck。

这里要进一步细分：

- 对 `example`：可以使用内部 LLM 直接生成，但必须遵守 style profile 和 schema。
- 对 `collocation`：不建议纯 LLM 直接生成。推荐先调用 dictionary provider 获取候选，再把候选作为上下文交给 LLM 进行 refinement。

#### A1. 搭配的 Dictionary-Grounded 流程

推荐流程：

1. 用户选择 `搭配`。
2. 后端根据 word / lemma / pos 调用免费词典或搭配 API。
3. Dictionary provider 返回候选搭配、来源、可选释义、例句、链接。
4. LLM 只基于候选集合进行筛选、去重、排序和解释，不允许凭空补充未标记来源的搭配。
5. 返回 draft items，每条 item provenance 标记为 `dictionary_llm_refined`。
6. 用户编辑后 confirm。
7. confirm 写入 `word_l2_content`。

实现上更建议由后端 `DictionaryProvider` 发起 API 请求，而不是让通用 LLM 任意访问公网。这样可以保证：

- API 来源可控。
- 请求可缓存。
- 失败可降级。
- 返回结构可测试。
- provenance 可精确落地。

如果未来要实现“LLM 主动调用词典 API”，也应把词典能力封装成 allowlisted tool，例如 `lookupCollocations(word, pos)`，由后端执行并把结果回传给 LLM，而不是让 LLM 自由构造外部请求。

#### B. 外部 chat 粘贴

1. 用户选择 `搭配` 或 `例句`。
2. 系统可提供一个“复制提示词”按钮。
3. 用户到外部 chat 工具生成内容。
4. 用户把结果粘贴回来。
5. 前端尝试结构化解析；无法解析时允许用户手动整理。
6. 用户编辑后 confirm。
7. 后端校验并写入。

这个模式的价值：

- 用户可以不用消耗自己的内部 API key/token。
- 用户可以使用更熟悉或更强的外部 chat。
- 项目仍然保留统一的 confirm、schema 校验和 provenance 审计。

#### C. 手动录入

1. 用户直接新增搭配或例句 item。
2. 每条 item 自动标记为 `manual` 来源。
3. confirm 时和其他来源一样经过 schema 校验。

### 1.3 Refresh 行为

MVP 推荐支持两种 refresh：

- `replace_all`：重新生成当前 field 的整组 draft，替换未确认草稿。
- `append_more`：在当前草稿后补充更多候选。

暂不建议 MVP 做复杂的单条 refresh、对话式追问、长期上下文保存。

后续可以扩展：

- `refresh_item`：重写单条。
- `more_advanced`：更高级。
- `more_natural`：更自然。
- `more_exam_ready`：更适合考试作文。
- `shorter` / `longer`：控制长度。

### 1.4 Draft 与 Confirm 边界

强烈建议保持现有 Phase 2B 的设计原则：

- `generateDraft` 不写数据库。
- `refresh` 不写数据库。
- `paste external chat` 不写数据库。
- `manual edit` 在 confirm 前不写数据库，最多存在前端状态或本地临时状态。
- 只有 `confirm` 写数据库。

这样可以避免：

- 保存大量低质量草稿。
- 产生难以审计的中间状态。
- 让 L2 内容 hash 被草稿污染。
- L1/L2 复习状态被未确认内容扰动。

### 1.5 API 草案

现有 Phase 2B 已有：

- `POST /api/l2/:slug/draft`
- `POST /api/l2/:slug/confirm`

建议演进为更显式的 Composer API：

```http
POST /api/l2/:slug/composer/draft
POST /api/l2/:slug/composer/confirm
POST /api/l2/:slug/composer/external-prompt
```

也可以为了保持兼容，先继续使用现有 route，在 request body 中增强字段。

#### Draft Request

```ts
type L2ComposerDraftRequest = {
  field: 'collocation' | 'example';
  sourceMode: 'internal_llm' | 'dictionary_llm_refined';
  styleProfileId?: string;
  refreshMode?: 'replace_all' | 'append_more';
  count?: number;
  userInstruction?: string;
};
```

#### External Prompt Request

```ts
type L2ExternalPromptRequest = {
  field: 'collocation' | 'example';
  styleProfileId?: string;
  count?: number;
  userInstruction?: string;
};
```

返回：

```ts
type L2ExternalPromptResponse = {
  prompt: string;
  expectedJsonSchema: unknown;
  styleProfileId: string;
  promptVersion: string;
  promptHash: string;
};
```

#### Confirm Request

```ts
type L2ComposerConfirmRequest = {
  field: 'collocation' | 'example';
  items: Array<L2CollocationItem | L2ExampleItem>;
  replaceExisting?: boolean;
};
```

---

## 2. Style Profile 设计

### 2.1 定义

Style Profile 是“生成风格包”。

产品 UI 中不建议叫 skill，因为 skill 容易和 agent 能力、系统技能、prompt 工程概念混淆。更适合叫：

- 风格
- 风格包
- 写作风格
- 例句风格
- 生成偏好

内部命名可以使用 `styleProfile`。

### 2.2 MVP 策略

推荐先做内置风格包，不急着做用户自定义数据库表。

原因：

1. 内置包更容易测试。
2. prompt 版本可控。
3. 风格质量容易审查。
4. 可以先观察用户真实使用频率，再决定是否开放自定义。

### 2.3 建议内置风格包

通用：

- `default`：自然、准确、适合普通学习。
- `academic`：偏学术表达，适合论文和正式阅读。
- `daily_spoken`：偏日常口语，适合真实交流。

例句专用：

- `postgraduate_essay`：考研作文风格，句式成熟，表达正式但不过度炫技。
- `ielts_writing`：雅思写作风格，强调论证、观点、连接表达。
- `toefl_writing`：托福写作风格，偏清晰解释和校园/社会议题。

搭配专用：

- `core_collocation`：高频核心搭配。
- `exam_collocation`：适合写作输出的搭配。
- `academic_collocation`：适合正式文本的搭配。

### 2.4 Style Profile Schema

```ts
type L2StyleProfile = {
  id: string;
  version: string;
  label: string;
  fieldScope: Array<'collocation' | 'example'>;
  description: string;
  promptRules: {
    register?: 'neutral' | 'academic' | 'spoken' | 'exam' | 'literary';
    cefrRange?: ['B1' | 'B2' | 'C1' | 'C2'];
    sentenceLength?: 'short' | 'medium' | 'long';
    includeTranslation?: boolean;
    includeUsageNote?: boolean;
    includePattern?: boolean;
    avoidRareWords?: boolean;
    examReady?: boolean;
  };
};
```

### 2.5 Prompt 影响方式

Style Profile 不应只是一个字符串拼进 prompt，而应映射为稳定规则。

例如 `postgraduate_essay`：

```ts
{
  register: 'exam',
  cefrRange: ['B2', 'C1'],
  sentenceLength: 'medium',
  includeTranslation: true,
  includeUsageNote: true,
  includePattern: true,
  avoidRareWords: true,
  examReady: true
}
```

对应 prompt 约束：

- 例句应适合中国考研英语写作。
- 句子应自然、正式、可迁移到作文语境。
- 避免生僻词堆砌。
- 优先展示目标词的高价值用法。
- 输出 JSON，不要输出解释性散文。

---

## 3. Content Schema 设计

### 3.1 总体原则

L2 内容必须是结构化内容，不应只存一段自由文本。

原因：

1. 前端需要逐条展示、删除、编辑。
2. 后续 agent 需要读懂这些内容。
3. L2 graph 和 L3 context 可以基于 item 做链接。
4. 内容质量审计需要 item 级 provenance。
5. 用户后续可以按来源、风格、质量筛选。

推荐使用统一 wrapper：

```ts
type L2ContentDocument<T> = {
  schemaVersion: 'l2-content-v1';
  field: 'collocation' | 'example';
  items: T[];
};
```

如果当前 `word_l2_content` 表已经用 JSONB 存数组，短期可以兼容旧结构，但建议新 confirm 逻辑逐步迁移到 wrapper。

### 3.2 Collocation Item Schema

```ts
type L2CollocationItem = {
  id?: string;
  phrase: string;
  meaning?: string;
  translation?: string;
  example?: string;
  pattern?: string;
  register?: 'neutral' | 'formal' | 'informal' | 'academic' | 'spoken' | 'exam';
  tags?: string[];
  note?: string;
  evidence?: {
    dictionaryName?: string;
    dictionaryEntryId?: string;
    dictionaryUrl?: string;
    rawPhrase?: string;
    rawExample?: string;
  };
  provenance: L2ContentProvenance;
};
```

字段解释：

- `phrase`：搭配本体，必填。
- `meaning`：英文或中文解释，选填。
- `translation`：中文翻译，选填。
- `example`：这个搭配对应的一条例句，选填。
- `pattern`：结构模式，例如 `play a role in doing sth`。
- `register`：语域。
- `tags`：例如 `writing`, `academic`, `exam`, `spoken`。
- `note`：用户或系统补充说明。
- `evidence`：词典 ground truth 信息，搭配字段建议优先保留。
- `provenance`：来源审计，必填。

### 3.3 Example Item Schema

```ts
type L2ExampleItem = {
  id?: string;
  sentence: string;
  translation?: string;
  usageNote?: string;
  pattern?: string;
  register?: 'neutral' | 'formal' | 'informal' | 'academic' | 'spoken' | 'exam';
  difficulty?: 'B1' | 'B2' | 'C1' | 'C2';
  styleProfileId?: string;
  tags?: string[];
  provenance: L2ContentProvenance;
};
```

字段解释：

- `sentence`：例句本体，必填。
- `translation`：中文翻译，建议 MVP 默认返回。
- `usageNote`：说明目标词在句中的用法。
- `pattern`：句型或表达结构。
- `register`：语域。
- `difficulty`：难度等级。
- `styleProfileId`：风格包 ID。
- `tags`：场景标签。
- `provenance`：来源审计，必填。

### 3.4 Confirm 校验规则

#### 通用规则

- `field` 只能是 `collocation` 或 `example`。
- `items` 必须是非空数组。
- 每条 item 必须有 `provenance.source`。
- 字符串字段需要 trim。
- 空字符串转为缺省字段，不写入空字符串。
- item 数量应有限制，建议 MVP 每次 confirm 最多 20 条。
- 禁止 confirm 未知 field。
- 禁止把 `collocation` schema 写入 `example` field，反之亦然。

#### Collocation 校验

- `phrase` 必填，trim 后长度 > 0。
- `phrase` 长度建议不超过 120 字符。
- `example` 如果存在，长度建议不超过 300 字符。
- 同一次 confirm 内 `phrase` 去重。
- 可选：和已有内容做 normalize 后去重。
- 对 `source = 'dictionary'` 或 `source = 'dictionary_llm_refined'` 的搭配，建议要求 `provenance.dictionaryName` 或 `evidence.dictionaryName` 至少存在一个。
- 对纯 `source = 'llm'` 的搭配，MVP 可以允许但应标记 soft warning：`ungrounded_collocation`。
- 如果词典 API 未返回候选，后端应返回 empty draft 或降级提示，不应静默让 LLM 编造搭配并伪装成词典来源。

#### Example 校验

- `sentence` 必填，trim 后长度 > 0。
- `sentence` 长度建议 20-300 字符。
- `sentence` 应包含目标词或其合理变形。MVP 可以只做弱校验，避免误杀。
- 同一次 confirm 内 `sentence` 去重。
- 可选：和已有内容做 normalize 后去重。

### 3.5 质量校验分级

建议区分 hard validation 和 soft warning。

Hard validation：不通过就不能写入。

- 缺少必填字段。
- field/schema 不匹配。
- item 数组为空。
- JSON 结构非法。
- provenance 缺失。

Soft warning：允许写入，但前端提示用户。

- 例句没有包含目标词。
- 例句太长。
- 搭配看起来像完整句子。
- 风格包和内容语域不一致。
- LLM 置信度较低。

---

## 4. Provenance 设计

### 4.1 定义

Provenance 是每条 L2 内容的来源记录。

它不是简单的 `createdBy`，而是用于回答：

- 这条内容是人工写的，还是模型生成的？
- 如果是模型生成，用了哪个 provider / model / prompt 版本？
- 用户是否编辑过？
- 是词典原始内容，还是词典 + LLM 改写？
- 以后质量审计或回滚时，能不能定位问题来源？

### 4.2 来源枚举

```ts
type L2ContentSource =
  | 'manual'
  | 'llm'
  | 'llm_edited'
  | 'external_chat'
  | 'dictionary'
  | 'dictionary_llm_refined';
```

来源解释：

- `manual`：用户直接手写。
- `llm`：内部 LLM 生成，用户未编辑或只做非实质性选择。
- `llm_edited`：内部 LLM 生成后，用户编辑过内容。
- `external_chat`：用户从外部 chat 粘贴。
- `dictionary`：来自词典 API 的原始搭配/例句。
- `dictionary_llm_refined`：词典内容被内部 LLM 改写或整理后写入。

### 4.3 Provenance Schema

```ts
type L2ContentProvenance = {
  source: L2ContentSource;
  provider?: 'openai' | 'anthropic' | 'deepseek' | 'ollama' | 'openai_compatible' | 'external' | 'dictionary';
  model?: string;
  styleProfileId?: string;
  styleProfileVersion?: string;
  promptVersion?: string;
  promptHash?: string;
  dictionaryName?: string;
  dictionaryEntryId?: string;
  dictionaryUrl?: string;
  externalTool?: string;
  generatedAt?: string;
  confirmedAt?: string;
  userEdited?: boolean;
  confidence?: number;
  note?: string;
};
```

### 4.4 来源状态转换规则

#### 内部 LLM

- 初始生成：`source = 'llm'`
- 用户编辑后 confirm：`source = 'llm_edited'`
- 同时保留：`provider`、`model`、`styleProfileId`、`promptVersion`、`promptHash`

#### 外部 Chat

- 粘贴内容：`source = 'external_chat'`
- 用户编辑后仍保持 `external_chat`
- 设置 `userEdited = true`
- 可选填写 `externalTool = 'chatgpt' | 'claude' | 'kimi' | ...`

不建议把 external chat 编辑后改成 `llm_edited`，因为 `llm_edited` 应专指内部 LLM，可审计性更清楚。

#### Manual

- 手动创建：`source = 'manual'`
- 后续编辑仍是 `manual`
- `userEdited` 可省略或为 true

#### Dictionary

- 词典原文：`source = 'dictionary'`
- 词典原文被 LLM 改写：`source = 'dictionary_llm_refined'`
- 用户再编辑：保持 `dictionary_llm_refined`，设置 `userEdited = true`
- 对搭配，推荐默认使用 `dictionary_llm_refined`，并保留 `dictionaryName`、`dictionaryEntryId`、`dictionaryUrl` 或 item-level `evidence`。
- 如果 LLM 基于多个词典候选合并出一个学习项，应在 `note` 或 `evidence` 中保留主要来源，避免来源断裂。

### 4.5 为什么 Provenance 必须 item 级别

不能只在整组 content 上记录来源。

原因：

1. 一组搭配中可能有三条来自词典，两条来自 LLM，一条手写。
2. 用户可能只编辑了其中某一条。
3. 后续质量审计要定位到单条内容。
4. L2 graph 的边也可能来自不同来源。
5. 未来如果要删除某个低质量 provider 生成的内容，需要 item 级追踪。

---

## 5. 与当前 Phase 2B 架构的接入方式

### 5.1 当前可复用部分

Phase 2B 已经完成的能力可以直接承接 L2 Composer：

- LLM Provider 抽象。
- OpenAI-compatible provider。
- Anthropic provider。
- JSON 容错解析。
- UsageTracker 预算控制。
- `generateDraft` / `confirmDraft` 分离。
- `word_l2_content` 表。
- L2 cache refresh。
- L2 hash isolation。
- L2 stale 标记。

这说明 Composer 不需要推翻 Phase 2B，而是对 Phase 2B 做 schema 化和产品语义收敛。

但对搭配字段，需要补一个新的基础能力：`DictionaryProvider`。

它负责：

- 查询免费词典 / 搭配 API。
- 标准化不同词典返回。
- 返回候选搭配、释义、例句、来源链接。
- 支持缓存和失败降级。
- 为 provenance 提供稳定来源字段。

### 5.2 建议新增模块

```txt
src/l2-composer/
  content-schema.ts
  provenance.ts
  style-profiles.ts
  composer-prompts.ts
  validation.ts
```

或者沿用当前分层：

```txt
src/services/l2-composer.service.ts
src/services/dictionary-provider.service.ts
src/repositories/l2-content.repository.ts
src/llm/prompts/l2-composer.ts
src/domain/l2-content.ts
```

更推荐第二种，因为它更贴合现有 `services / repositories / llm / domain` 结构。

### 5.3 推荐服务职责

#### L2ContentService

继续负责：

- draft 生成编排。
- confirm 事务。
- 调 repository 写入。
- 调 cache refresh。
- 调 L2 stale 标记。

#### L2ComposerService

如果新增，可以负责：

- 根据 field + styleProfile 生成 prompt。
- 解析 LLM 输出为 typed item。
- 生成 external prompt。
- 标准化 provenance。
- 调用 validation。

#### L2ContentRepository

继续负责：

- `word_l2_content` CRUD。
- content upsert。
- cache refresh。
- 事务内查询。

### 5.4 不建议的做法

- 不建议为 L2 Composer 建聊天表。
- 不建议保存每次 refresh 草稿。
- 不建议 confirm 时跳过 schema 校验。
- 不建议 provenance 只存在 content group 上。
- 不建议把 L2 Composer 和未来 MCP/Agent graph API 混在同一个 service。
- 不建议让 HTTP route 直接调用 LLM provider 或 repository。

---

## 6. 数据库设计建议

### 6.1 MVP 是否需要新表

短期不一定需要新表。

如果当前 `word_l2_content` 已能按 word + field 存 JSONB，可以先扩展 JSON schema。

推荐优先级：

1. 先增强 `word_l2_content.content` 的结构。
2. 加 confirm validation。
3. 加 provenance。
4. 再考虑 style profile 是否入库。

### 6.2 是否需要 Style Profile 表

MVP 不需要。

内置 style profile 可以先放代码常量：

```txt
src/domain/l2-style-profile.ts
```

未来当用户需要自定义风格时，再增加：

```txt
l2_style_profiles
user_l2_style_profiles
```

### 6.3 是否需要 Draft 表

MVP 不建议。

只有在以下需求出现时再考虑：

- 用户希望跨设备恢复未确认草稿。
- 用户希望查看历史生成版本。
- 用户希望 A/B 对比不同模型生成结果。
- 需要完整审计每一次生成请求。

否则 draft 表会增加复杂度，但对当前固定入口价值不高。

---

## 7. 与未来 L2 Graph / MCP / Agent API 的边界

L2 Composer 和 L2 Agent API 是两个不同入口。

### 7.1 Composer 负责什么

- 生成搭配。
- 生成例句。
- 粘贴外部 chat 内容。
- 用户编辑。
- confirm 写入。
- 记录 item provenance。

### 7.2 Agent API 负责什么

- 读取 L2 内容和链接网络。
- 为多个词建议同义/反义/词根/语义关系。
- 生成候选链接。
- 推荐明天学习或复习词表。
- 结合 FSRS 和 L2 graph 做复习包。
- 为外部 agent 提供结构化、稳定、权限受控的接口。

### 7.3 不应混用的原因

如果把 Composer 做成 chat，再把 Agent API 也塞进去，系统会很快变成：

- 聊天记录难以审计。
- 内容和建议边界不清。
- 生成草稿和已确认知识混杂。
- agent 对数据的读写权限模糊。
- UI 复杂度超过当前阶段需求。

更稳的架构是：

```txt
L2 Composer: user-confirmed item creation
L2 Graph API: agent-readable relationship and recommendation layer
L3 Context Space: authentic context evidence layer
```

---

## 8. 实施任务规划

### Task 1：定义 L2 Content Domain Schema

目标：建立 typed schema 和 validation 基础。

建议文件：

```txt
src/domain/l2-content.ts
src/domain/l2-provenance.ts
src/domain/l2-style-profile.ts
```

验收：

- collocation/example item 有明确类型。
- provenance enum 完整。
- schemaVersion 固定为 `l2-content-v1`。
- 类型测试覆盖基本 shape。

### Task 2：实现 Style Profile Registry

目标：内置风格包可被后端稳定调用。

建议文件：

```txt
src/domain/l2-style-profile.ts
src/llm/prompts/l2-style-profiles.ts
```

验收：

- 至少支持 default、postgraduate_essay、academic、daily_spoken。
- fieldScope 校验生效。
- 不允许 example-only profile 用于 collocation。

### Task 2A：实现 DictionaryProvider

目标：为搭配提供 ground truth 候选来源。

建议文件：

```txt
src/dictionary/provider.ts
src/dictionary/providers/free-dictionary.ts
src/dictionary/providers/datamuse.ts
src/dictionary/normalizer.ts
```

验收：

- 能按 word / lemma / pos 查询搭配候选。
- 返回标准化候选结构。
- 保留 dictionaryName、entryId、url 等来源字段。
- API 失败时返回可识别错误，不让 LLM 伪造词典结果。
- 单测覆盖成功、空结果、API 失败、重复候选去重。

### Task 3：重构 Prompt Builder

目标：把 field + styleProfile 映射为稳定 prompt。

建议文件：

```txt
src/llm/prompts/l2-composer.ts
```

验收：

- prompt 明确要求 JSON 输出。
- collocation/example 输出 schema 分离。
- promptVersion 可追踪。
- promptHash 可计算。
- collocation prompt 必须明确：只能基于 dictionary candidates 生成建议，不能凭空发明搭配。
- example prompt 可以自由生成，但必须围绕目标词和 style profile。

### Task 4：实现 Confirm Validation

目标：confirm 前强校验，避免脏数据进入 `word_l2_content`。

建议文件：

```txt
src/services/l2-content.service.ts
src/domain/l2-content.validation.ts
```

验收：

- field/schema 不匹配会失败。
- 空 item 会失败。
- 缺 provenance 会失败。
- 缺 phrase/sentence 会失败。
- 同批重复 item 会被拒绝或去重。

### Task 5：实现 Provenance 标准化

目标：所有来源都进入统一 provenance。

建议文件：

```txt
src/domain/l2-provenance.ts
src/services/l2-content.service.ts
```

验收：

- internal LLM 未编辑：`llm`。
- internal LLM 编辑后：`llm_edited`。
- external chat：`external_chat`。
- manual：`manual`。
- dictionary：`dictionary`。
- dictionary + llm：`dictionary_llm_refined`。

### Task 6：External Prompt API

目标：支持用户复制 prompt 到外部 chat。

建议 route：

```txt
POST /api/l2/:slug/composer/external-prompt
```

验收：

- 返回 prompt。
- 返回 expected schema。
- 返回 styleProfileId、promptVersion、promptHash。
- 不调用 LLM。
- 不消耗 usage budget。

### Task 7：兼容现有 Phase 2B API

目标：不破坏现有 `/draft` 和 `/confirm` 测试。

验收：

- 原有 271+ 测试继续通过。
- 新 API 或增强 body 方式有测试。
- `generateDraft` 仍不写 DB。
- `confirmDraft` 仍只影响 L2，不影响 L1。

---

## 9. 需要继续讨论的问题

### 9.1 UI 上是否只展示两个固定入口？

当前建议：是。

先固定：

- 搭配
- 例句

词根、同反义、语义网络更适合进入 L2 Graph / Agent API，而不是 Composer MVP。

### 9.2 外部 chat 粘贴是否需要解析器？

建议 MVP 支持两种粘贴：

- JSON 粘贴：自动解析。
- 普通文本粘贴：前端提供手动拆条。

后端 confirm 只接受结构化 items，不负责猜测普通文本。

### 9.3 是否记录 prompt 全文？

MVP 不建议默认存 prompt 全文，只存：

- `promptVersion`
- `promptHash`
- `styleProfileId`
- `model`

如果未来需要严格审计，可以增加 prompt log 表，但要考虑隐私和存储膨胀。

### 9.4 用户编辑如何识别？

前端应在 draft item 上保留 original snapshot 或 hash。

confirm 时：

- 原始 LLM item 未变化：`llm`
- 内容变化：`llm_edited`

如果前端暂时不做 diff，也可以由前端显式传 `userEdited`。

---

## 10. 当前推荐结论

L2 Composer 的合理实现不是“对话型助手”，而是“结构化内容生成器”。

它应该服务于一个明确闭环：

```txt
选择字段 -> 选择风格 -> 生成/粘贴/手写 -> 编辑 -> confirm -> 写入结构化 L2 内容 -> 进入 L2 cache/hash/recheck
```

这个闭环与当前 Phase 2B 的架构非常契合，只需要继续补齐：

- Style Profile
- Content Schema
- Confirm Validation
- Item-level Provenance
- External Prompt API

MVP 最重要的取舍是：

- 不做聊天记录。
- 不存未确认 draft。
- 不把 L2 Composer 和 Agent Graph API 混为一个系统。
- 先用同一个 PostgreSQL、同一个 V2 后端、清晰的 L2 表/模块边界实现隔离。

后续进入 L2 Graph / MCP / L3 Context Space 时，这套 provenance 和 schema 会成为上层 agent 可读、可审计、可扩展的基础。

---

## 11. 结合当前 V2 项目的实现落点

### 11.1 当前代码形态

当前 Phase 2B 已经形成了一个可直接演进的闭环：

```txt
src/http/routes/l2.ts
  -> src/services/l2-content.service.ts
    -> src/llm/prompts/*
    -> src/llm/parser.ts
    -> src/llm/usage-tracker.ts
    -> src/repositories/l2-content.repository.ts
    -> src/db/content-hash.ts
```

核心现状：

- `POST /api/l2/:slug/draft` 调 `L2ContentService.generateDraft(word, field, source)`。
- `POST /api/l2/:slug/confirm` 调 `L2ContentService.confirmDraft(wordId, field, content, source)`。
- 当前合法字段是 `collocation | corpus | synonym | antonym`。
- 当前产品概念里的“例句”在代码和 DB 里对应 `corpus`，不是 `example`。
- `word_l2_content.content` 是 JSONB，当前按 field 存一组内容。
- `refreshL2Cache()` 会把 active rows 聚合回 `words.collocations / corpus_items / synonym_items / antonym_items`。
- `confirmDraft()` 已经在事务里做 insert -> refresh cache -> recompute L2 hash -> mark L2 stale。

因此，L2 Composer 不需要推翻现有代码。更合适的路线是：**保留当前 L2 内容闭环，增强 schema、provenance、style profile、dictionary grounding 和 route body**。

### 11.2 命名兼容：产品字段与存储字段分离

产品 UI 可以显示：

```txt
搭配 = collocation
例句 = example
```

但后端存储短期不建议把 `corpus` 改名为 `example`，因为当前：

- `src/schemas/service/index.ts` 已定义 `L2Field = collocation | corpus | synonym | antonym`。
- `words.corpus_items` 已存在。
- `refreshL2Cache()` 已把 `corpus` 映射到 `corpus_items`。
- 测试已经覆盖 `corpus`。

建议新增一个轻量映射层：

```ts
type L2ComposerField = 'collocation' | 'example';
type L2StorageField = 'collocation' | 'corpus' | 'synonym' | 'antonym';

function toStorageField(field: L2ComposerField): L2StorageField {
  return field === 'example' ? 'corpus' : field;
}
```

实施原则：

- API 可以逐步接受 `example`，内部转成 `corpus`。
- 旧 API 继续接受 `corpus`，保持 Phase 2B 测试稳定。
- DB 和 hash/cache 暂不改列名。
- 文档和 UI 统一叫“例句”，代码边界处明确映射。

### 11.3 当前服务需要的最小调整

当前 `L2ContentService` 的构造函数是：

```ts
constructor(
  private readonly llmProvider: LlmProvider,
  private readonly usageTracker: UsageTracker,
) {}
```

建议演进为：

```ts
interface L2ContentServiceDeps {
  llmProvider?: LlmProvider;
  usageTracker?: UsageTracker;
  dictionaryProvider?: DictionaryProvider;
}

class L2ContentService {
  constructor(private readonly deps: L2ContentServiceDeps) {}
}
```

原因：

1. `confirmDraft()` 不需要 LLM，手动录入和外部 chat 粘贴也不需要 LLM。
2. 当前 `services.l2content` 只有在 LLM provider + usage tracker 都存在时才创建，这会导致 confirm 也跟着不可用。
3. 未来 dictionary-grounded collocation 可能只依赖 dictionary provider，或者 dictionary + LLM。
4. 服务层可以自己判断某个 draft 模式是否需要 LLM，而不是让整个 L2ContentService 缺席。

推荐调整：

- `createServices()` 总是创建 `l2content`。
- `generateDraft()` 在需要 LLM 但未配置时返回 `L2_CONTENT_UNAVAILABLE`。
- `confirmDraft()` 永远可用，只要 content schema 校验通过。
- `external-prompt` 不需要 LLM，不消耗 usage budget。

这样更符合当前产品设计：用户可以手动录入，或者从外部 chat 粘贴，不应该因为内部 LLM 未配置而不能 confirm。

---

## 12. Dictionary-Grounded Collocation 的实现规格

### 12.1 Provider Contract

新增字典 provider 抽象，不建议直接把外部 API 调用写进 service。

建议文件：

```txt
src/dictionary/provider.ts
src/dictionary/normalizer.ts
src/dictionary/providers/datamuse.ts
src/dictionary/providers/free-dictionary.ts
src/dictionary/index.ts
```

Provider contract：

```ts
export interface DictionaryCollocationCandidate {
  phrase: string;
  headword: string;
  pos?: string;
  meaning?: string;
  example?: string;
  sourceName: string;
  sourceEntryId?: string;
  sourceUrl?: string;
  score?: number;
  raw?: unknown;
}

export interface LookupCollocationsInput {
  lemma: string;
  pos?: string;
  limit?: number;
}

export interface LookupCollocationsResult {
  candidates: DictionaryCollocationCandidate[];
  sourceName: string;
  warnings?: string[];
}

export interface DictionaryProvider {
  lookupCollocations(input: LookupCollocationsInput): Promise<LookupCollocationsResult>;
}
```

### 12.2 Grounding 规则

对 `collocation` draft：

1. 先调用 `dictionaryProvider.lookupCollocations({ lemma, pos, limit })`。
2. 如果返回候选为空，返回 empty draft + warning，不默认让 LLM 编造。
3. 如果配置了 LLM，则把 candidates 作为 prompt 的唯一事实来源。
4. LLM 输出必须只能来自 candidates，允许改写解释、排序、翻译和补充学习例句。
5. 每条输出保留 `evidence` 和 `provenance`。

LLM prompt 需要明确写死：

```txt
You must only select or refine collocations from the provided dictionaryCandidates.
Do not invent new collocations.
If no candidate is suitable, return an empty JSON array.
```

### 12.3 Collocation Draft Result

推荐 draft response：

```ts
type L2CollocationDraftResponse = {
  field: 'collocation';
  storageField: 'collocation';
  sourceMode: 'dictionary_llm_refined' | 'dictionary';
  styleProfileId?: string;
  dictionaryCandidatesCount: number;
  items: L2CollocationItem[];
  warnings?: Array<'NO_DICTIONARY_CANDIDATES' | 'LLM_UNAVAILABLE' | 'UNGROUNDED_FALLBACK_DISABLED'>;
  raw?: string;
};
```

如果 LLM 未配置但 dictionary provider 可用，可以返回 `sourceMode = 'dictionary'` 的原始候选草稿；如果用户想要解释和学习化格式，再提示需要 LLM refinement。

### 12.4 Collocation Provenance

对 dictionary-grounded 搭配，item 推荐结构：

```ts
{
  phrase: 'heavy rain',
  meaning: 'a large amount of rain',
  translation: '大雨',
  example: 'Heavy rain disrupted traffic across the city.',
  register: 'neutral',
  evidence: {
    dictionaryName: 'datamuse',
    dictionaryEntryId: 'heavy_rain',
    dictionaryUrl: '...',
    rawPhrase: 'heavy rain',
    rawExample: '...'
  },
  provenance: {
    source: 'dictionary_llm_refined',
    provider: 'openai',
    model: '...',
    dictionaryName: 'datamuse',
    promptVersion: 'l2-collocation-grounded-v1',
    promptHash: '...',
    userEdited: false
  }
}
```

关键点：

- `evidence` 记录事实来源。
- `provenance` 记录加工来源。
- `source = dictionary_llm_refined` 表示“事实来自词典，学习化整理来自 LLM”。
- 如果用户编辑，保留 `source = dictionary_llm_refined`，设置 `userEdited = true`。

---

## 13. Content Schema 与当前 `parseL2Content` 的演进

### 13.1 当前风险

当前 `src/schemas/service/index.ts` 已经有 field-specific validation，但 schema 是 Phase 2B 的旧形态：

```txt
collocation -> [{ phrase, gloss, tone, example, exampleTranslation }]
corpus      -> [{ text, translation, source }]
synonym     -> [...]
antonym     -> [...]
```

如果直接把新 wrapper 写入 `word_l2_content.content`：

```ts
{
  schemaVersion: 'l2-content-v1',
  field: 'collocation',
  items: [...]
}
```

当前 `refreshL2Cache()` 会把这个 wrapper 当作一个 content row 推进 `words.collocations`，导致 cache 形态变成：

```ts
[
  { schemaVersion: 'l2-content-v1', field: 'collocation', items: [...] }
]
```

这不一定符合现有前端和 hash 预期。更稳的方案是：**DB row 存 wrapper，cache 存 flatten 后的 items**。

### 13.2 推荐兼容策略

`parseL2Content(field, content)` 应支持两种输入：

1. Legacy array：保持 Phase 2B 兼容。
2. V1 document wrapper：新 Composer 使用。

内部统一 normalize：

```ts
type NormalizedL2ContentDocument<T> = {
  schemaVersion: 'l2-content-v1';
  field: L2StorageField;
  items: T[];
};
```

兼容规则：

- 旧数组输入可以包装成 `schemaVersion = 'l2-content-legacy-array'` 或直接 normalize 为 v1。
- 新 Composer confirm 推荐提交 v1 wrapper。
- `word_l2_content.content` 推荐存 normalized wrapper。
- `refreshL2Cache()` 读取 row.content 时调用 `extractL2Items(row.field, row.content)`，把 wrapper.items 或 legacy array flatten 到 cache。

建议工具函数：

```ts
function extractL2Items(field: string, content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (
    content &&
    typeof content === 'object' &&
    'schemaVersion' in content &&
    'items' in content &&
    Array.isArray((content as { items: unknown }).items)
  ) {
    return (content as { items: unknown[] }).items;
  }
  return [content];
}
```

### 13.3 Repository 调整

当前：

```ts
grouped[row.field].push(row.content);
```

建议改为：

```ts
grouped[row.field].push(...extractL2Items(row.field, row.content));
```

这样：

- 旧 row 不破坏。
- 新 wrapper 可以入库。
- `words.collocations` 和 `words.corpus_items` 继续保持 item array。
- `computeL2Hash()` 的输入形态更稳定。

---

## 14. API 兼容与扩展方案

### 14.1 保留旧 API

短期继续保留：

```http
POST /api/l2/:slug/draft
POST /api/l2/:slug/confirm
```

因为当前测试和调用方已经围绕这两个 endpoint。

### 14.2 增强 Draft Body

推荐扩展 body，而不是立即新增大量 route：

```ts
type L2DraftBody = {
  field: 'collocation' | 'corpus' | 'example' | 'synonym' | 'antonym';
  sourceMode?: 'internal_llm' | 'dictionary' | 'dictionary_llm_refined';
  styleProfileId?: string;
  refreshMode?: 'replace_all' | 'append_more';
  count?: number;
  userInstruction?: string;
  allowUngrounded?: boolean;
};
```

字段解释：

- `field = example` 时 route 转成 storage field `corpus`。
- `collocation` 默认 `sourceMode = dictionary_llm_refined`。
- `corpus/example` 默认 `sourceMode = internal_llm`。
- `allowUngrounded = false` 是 collocation 默认安全策略。

### 14.3 增强 Confirm Body

推荐新旧兼容：

```ts
type L2ConfirmBody = {
  field: 'collocation' | 'corpus' | 'example' | 'synonym' | 'antonym';
  content?: unknown;
  items?: unknown[];
  document?: L2ContentDocument<unknown>;
  source?: L2ContentSource;
  sourceRef?: string;
  replaceExisting?: boolean;
};
```

兼容规则：

- 如果传 `document`，优先使用 document。
- 如果传 `items`，包装为 v1 document。
- 如果只传旧 `content`，继续按 legacy 处理。
- `field = example` 映射为 `corpus`。
- row-level `source` 继续写 `word_l2_content.source`。
- item-level `provenance.source` 才是未来审计主来源。

### 14.4 External Prompt API

新增一个轻量 route：

```http
POST /api/l2/:slug/external-prompt
```

不建议放在 LLM-required service 之后，因为它不调用 LLM。

返回：

```ts
{
  field: 'example',
  storageField: 'corpus',
  styleProfileId: 'postgraduate_essay',
  promptVersion: 'l2-example-external-v1',
  promptHash: '...',
  prompt: '...',
  expectedJsonSchema: {...}
}
```

用途：

- 用户复制到外部 chat。
- 外部 chat 返回 JSON。
- 用户粘贴回来后 confirm。
- 不消耗内部 usage budget。

---

## 15. Style Profile 的代码接入

### 15.1 内置 Registry

先不要建 DB 表。建议新增：

```txt
src/domain/l2-style-profile.ts
```

内容：

```ts
export const BUILTIN_L2_STYLE_PROFILES = {
  default: {...},
  postgraduate_essay: {...},
  academic: {...},
  daily_spoken: {...},
  core_collocation: {...},
  exam_collocation: {...},
} as const;
```

### 15.2 Prompt Builder 接入点

当前 prompt 分散在：

```txt
src/llm/prompts/collocations.ts
src/llm/prompts/examples.ts
src/llm/prompts/synonyms.ts
```

推荐新增：

```txt
src/llm/prompts/l2-composer.ts
```

并保留旧文件作为 wrapper 或逐步迁移：

```ts
buildCollocationPrompt(word, config)
  -> buildL2ComposerPrompt({ field: 'collocation', word, styleProfile, dictionaryCandidates })

buildExamplePrompt(word, config)
  -> buildL2ComposerPrompt({ field: 'corpus', word, styleProfile })
```

这样可以：

- 保持旧测试容易修。
- 统一 promptVersion / promptHash。
- 让 style profile 规则集中。
- 让 collocation 的 dictionary candidates 成为 prompt 的显式输入。

---

## 16. 测试规划

### 16.1 Service Tests

扩展 `tests/services/l2-content.test.ts`：

- `collocation` 默认先调用 dictionaryProvider。
- dictionary 无候选时返回 warning，不调用 LLM。
- dictionary 有候选且 LLM 配置时，LLM prompt 包含 candidates。
- LLM 输出未基于 candidates 时被 validation 拒绝或 warning。
- `corpus/example` 仍走 LLM prompt。
- `confirmDraft()` 在无 LLM provider 时仍可写入。
- `confirmDraft()` 接受 legacy array 和 v1 wrapper。
- `confirmDraft()` 对 dictionary collocation 要求 evidence/provenance。

### 16.2 Route Tests

扩展 `tests/http/l2.test.ts`：

- `field = example` 被映射成 service field `corpus`。
- `field = corpus` 仍保持兼容。
- `sourceMode = dictionary_llm_refined` 传入 service。
- LLM 未配置时，manual/external confirm 不应 503。
- `/api/l2/:slug/external-prompt` 不要求 LLM provider。
- invalid styleProfileId 返回 400。

### 16.3 Repository Tests

扩展 `tests/repositories/l2-content.test.ts`：

- `refreshL2Cache()` 对 legacy array 仍然工作。
- `refreshL2Cache()` 对 v1 wrapper 使用 `items` flatten。
- 多个 active content rows 的 items 合并顺序稳定。
- inactive rows 不进入 cache。

### 16.4 Schema Tests

新增或扩展 schema tests：

- `collocation` v1 item 必须有 `phrase`。
- dictionary source 的 collocation 必须有 evidence 或 provenance dictionaryName。
- `corpus/example` v1 item 必须有 `sentence` 或兼容旧 `text`。
- 空字符串 trim 后不入库。
- 同 batch 重复 phrase/sentence 能被拒绝或去重。

---

## 17. 推荐实施顺序

### Step 1：先做无 DB migration 的兼容层

目标：

- 加 `L2ComposerField -> L2StorageField` 映射。
- 加 v1 content types。
- `parseL2Content` 支持 legacy array + v1 wrapper。
- `refreshL2Cache` flatten wrapper items。

验收：

- 旧测试全过。
- 新 wrapper 测试通过。
- 不改 DB schema。

### Step 2：实现 Style Profile Registry 和 Prompt Builder

目标：

- 内置 style profiles。
- promptVersion / promptHash。
- collocation/example prompt 分离。

验收：

- example/corpus 可按 style profile 生成。
- collocation prompt 支持 dictionary candidates。

### Step 3：实现 DictionaryProvider

目标：

- 支持至少一个免费 provider。
- provider 失败可降级。
- candidates 标准化。

验收：

- 无候选不让 LLM 编造。
- 有候选时 LLM 只能基于 candidates refinement。
- provenance/evidence 完整。

### Step 4：调整 Service 和 Route

目标：

- `L2ContentService` 改为可选 LLM / usage / dictionary deps。
- `confirmDraft` 不再依赖 LLM 是否配置。
- draft body 支持 `sourceMode/styleProfileId/count/refreshMode`。
- 新增 external prompt route。

验收：

- 手动 confirm、external chat confirm 在无 LLM 时可用。
- draft 需要 LLM 时仍正确返回 503。
- collocation 默认 dictionary-grounded。

### Step 5：补审计字段和前端约定

目标：

- item-level provenance。
- item-level evidence。
- row-level `source/source_ref` 作为兼容摘要。

验收：

- 内部 LLM、外部 chat、manual、dictionary、dictionary_llm_refined 都可区分。
- 用户编辑后 provenance 状态符合规则。

---

## 18. 当前最重要的架构判断

1. **搭配必须 grounded**：这是和例句最大的设计差异，不能让 LLM 自由生成后伪装成事实。
2. **不要现在重命名 `corpus`**：产品叫“例句”，存储仍用 `corpus`，用映射层消化。
3. **confirm 不应依赖 LLM 配置**：手动和外部 chat 是核心模式，不能因为内部 LLM 未配置而失效。
4. **DB 暂不需要新表**：先增强 JSON schema、validation、provider、prompt 和 cache flatten。
5. **item provenance 是主审计单位**：row-level `source` 只作为兼容摘要，不足以支撑未来质量审计。
6. **DictionaryProvider 应由后端控制**：即使产品体验上表现为“LLM 主动调用词典”，实际也应是 allowlisted backend capability。
