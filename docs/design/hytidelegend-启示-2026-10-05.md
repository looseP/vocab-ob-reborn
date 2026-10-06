# HytideLegend 深度解析与对 vocab-ob 的启示

> 分析日期：2026-10-05
> 被析项目：`D:/Basic-Tools/HytideLegend`（HytideLegend/htd-ai-augmented-education，v0.1.11，18 Skills + 4 应用，CC BY-NC 4.0）
> 对照对象：`F:/dev/vocab-ob/wt-main`（Vocab Observatory）
> 结论前置：**可迁移的是协议与判据，不是形态。** 两条最高价值启发是「证据包 + 指纹绑定」和「verificationStatus 与生命周期正交」，两者都能在不动现有架构的前提下加固 ADR-0029 / ADR-0037 已经想守的东西。

---

## 一、HytideLegend 是什么：一句话定位

不是一个背单词 App，也不是一堆 prompt。**它是一个把 LLM 关进确定性管道的工程范式**：

> 凡是能用脚本算出来的，一律不让模型碰；模型只回答"哪个候选值得保留、这两条是不是同一个义项"这类真正的语义判断题，并且答案必须以「引用证据包内的稳定 ID」的形式交回。

三个支柱：

| 支柱 | 载体 | 作用 |
| --- | --- | --- |
| 显式状态机 | `utils/scripts/workflow_state.py`（被 12+ Skill 复用） | 每个长流程都可检查、可暂停、可按 run-id 恢复 |
| 证据包 / 决策包 | `generation_packet.json` + `*-decision.schema.json` + sha256 digest 双向比对 | 结构上让 Agent **无法凭空编造、无法复用陈旧判断** |
| 溯源元模型 | `generationMethod` × `verificationStatus` × `confidence`，用 JSON Schema `if/then` 交叉约束 | "这条内容从哪来、被谁核过、有多可信"是可查询的结构，不是注释 |

---

## 二、它的核心机制（值得抄的七处细节）

### 2.1 状态图是数据，驱动器只有一份

`utils/scripts/workflow_state.py:29-57` 定义通用 `WorkflowDefinition`，每个 Skill 只贡献一张 transition 字典（`skills/mark-memory-spans/scripts/cli.py:26-43`），驱动代码 `advance`/`pause` 各两行（`cli.py:83-88`）。

引擎侧的四道保障：
- 迁移查表，非法跳转直接拒绝（`:202-204`）；非终态不得重入（`:198-201`）；暂停态强制 `paused_` 前缀（`:240-241`）
- 每次读写都对 `workflow-state-v1.schema.json` 做 Draft2020-12 校验（`:90-93`）
- 事件序号从已有 JSONL 最大值续接，防重复追加（`:148-150`）
- `resume` 从 `resume_stage` 精确续跑，非 paused 状态直接报错（`:253-258`）

**暂停是有语义的**，不是异常：`paused_user_browser_action`（要人过验证码）、`paused_agent_decision`（等模型判断）、`paused_quality_review`（质量复核）、`paused_retryable_error`（可重试），退出码统一 3 表示暂停。

### 2.2 证据包：模型只回 ID，事实由脚本展开

`skills/mark-memory-spans/scripts/cli.py:106-127` 的 `write_packet` 生成的 `generation_packet.json` 里装着：**源文本 + sha256、脚本算好的有界候选**（`candidate_spans(max_candidates=128, per_paragraph=32)`）、以及写死的 instructions。

模型的回复**只能填候选 ID 或分句编号**（`agent-response.schema.json`），脚本再反算真实偏移量（`classical_spans(response["selected_clause_ids"])`）。模型永远不会、也不能输出一个字符下标。

### 2.3 指纹绑定：防篡改、防重放

`skills/build-word-entry/scripts/content_review.py` 是这一模式的极致：
- `prepare()` 产出 `{evidenceDigest, candidateDigest, senses}`，digest = 规范化 JSON 的 sha256（`:10-11, 31-36`）
- `apply()` **双向比对**：决策里的 digest 与包不一致报错；条目已被外部改动也报错（`:45-48`）
- `decisionId` 由 `[runId, itemId, evidenceDigest, candidateDigest]` 派生 → 天然防重放（`:85`）
- 更强的是**逐项覆盖约束**：决策集合必须与审查模板的 candidateId 完全相等且不重复——不能漏项，也不能凭空多出一项（`review.py:35-42`）
- `cli.py:444-446`：来源 proofs 不符直接拒绝，错误信息写得很直白："判断未绑定本次证据摘要"

它的 smoke.py 里甚至专门伪造攻击用例：篡改 `candidateDigest` 后断言退出码 **必须** 是 4（`smoke.py:623-633`）。

### 2.4 溯源不是注释，是 Schema 里的交叉约束

`skills/build-word-entry/references/entry.schema.json:49-88`：

- `generationMethod`：`source_supported | ai_generated | rule_derived`
- `verificationStatus`：`pending | automatic_passed | agent_passed | human_passed | rejected`
- `if/then` 强制的业务不变量：
  - `ai_generated` **必须**带 `confidence`
  - `source_supported` 必须 `sourceRefs >= 1` 且**禁止** `confidence`
  - `rule_derived` 必须 `verificationStatus == "pending"`、`sourceRefs` 为空
  - `agent_passed` **必须**有 `verificationRef{runId, decisionId, evidenceDigest, candidateDigest, reviewedAt}`

关键的一句：**"来源"和"置信度"在结构上是互斥的**——有来源就不许谈置信度，没来源就必须交代置信度。这从根子上杜绝了"既无出处又无不确定度声明"的裸内容。

三个词的分工也钉得很死：`automatic_passed` = 脚本的确定性核验（`english_inflections.py` 的拼写规则、`alignment` 的跨站一致），**不代表人听过看过**；`agent_passed` = 语义审查通过；`pending` = 尚待核验。

### 2.5 规则数据化：把本该写进 prompt 的判据，挪出 prompt

| 资产 | 从 prompt 里搬走了什么 |
| --- | --- |
| `utils/references/cloze-inference-rules.json` | "答案—线索"确定性映射，含正则命名捕获组；加载时做结构性自校验（每条规则必须含 `clue` 组，否则 ValueError — `span_ops.py:344-355`） |
| `utils/scripts/english_inflections.py` | 屈折拼写规则，带 `RULE_VERSION = "2"`，规则版本可演进、旧推导可标识 |
| `utils/scripts/dictionary_spelling.py` | 拼写相似判定 `2×LCS(a,b)/(len(a)+len(b)) ≥ 0.75`，排除别名/屈折/已确认同族——**明确不要求 Agent 判断** |
| `utils/references/术语表.txt` | 不可切开的术语保护集，**每次运行快照到 logs**，复现/验证用快照 |

### 2.6 手写案例 = 测试数据

`utils/scripts/render_span_examples.py:24-38` 的注释写得很明白："Derive offsets from the displayed markers; **never trust hand-entered offsets**"。`:70` 规定每条正面示例必须真能通过 `validate_cloze_quality`，否则**整个渲染失败**；`:112-120` 用 `<!-- generated: {id}:start/end -->` 标记，重复或不完整即报错。

→ 人工写的参考文档，先过业务校验再渲染成 md。写错的示例进不了仓库。

### 2.7 文档零漂移：再生成 + 比对

`utils/references/capability-catalog.json` 是唯一权威；`capability_catalog.py` 渲染 README 功能表和说明书。校验强度（`:110-146`）：
- 分类必须与 `SKILL_LAYOUT` 硬编码一致
- **反向核对各 SKILL.md front matter 的 category**（双向不漂移）
- 目录集合与实际 `skills/*/SKILL.md` **完全相等**（新增 Skill 忘登记立即失败）
- 成员顺序必须一致；描述强制 1～3 句
- `--check` = 重新生成后逐字节比对，不一致退出码 4

同一模式的其他实例：`version_history.py:19` 的 `TARGETS`（VERSION / README / marketplace.json / 更新历史四处同步），`:22-35` 注释明写"生成与审计共用同一份证据契约"。

---

## 三、vocab-ob 现状：已经很强的部分（不要倒退）

在列启示之前，先讲清楚**vocab-ob 已经在三处明显强于对方**，别为了借鉴把优势弄丢：

| 维度 | vocab-ob | HytideLegend | 判断 |
| --- | --- | --- | --- |
| LLM 预算与并发 | `UsageTracker` 日 token 预算 + DB 预留（advisory 锁防 check-then-call 超卖）+ reaper 按 TTL 回收僵尸预留；硬不变量 TTL ≥ 2×provider 超时（`usage-tracker.ts:50-52, 82-114`） | 无预算基础设施，靠"候选上限/确定性前置"省调用 | **vocab-ob 更成熟** |
| 写入闸门 | `FAIL_CLOSED_MIN_ROLE = "owner"`（查不到的路由按 owner）+ 直接从 server.ts 源码断言挂载顺序（`route-authorization.test.ts:16-40`）+ 路由复杂度棘轮 | 靠 SKILL.md 约定 + pytest | **vocab-ob 更硬** |
| 并发/租约 | outbox claimBatch + lease + recoverExpiredLeases | 独占文件锁，Windows 下还要 `OpenProcess` 探测 pid 存活（`file_transaction.py:22-77`） | **vocab-ob 是 distributed-safe 的** |
| 确定性计算 | FSRS adapter 纯函数、`content-hash.ts` 三层哈希、`l3-question-types.ts` duplicate key FAIL、`word-exam.ts` 解析器 | 同思路，规模不同 | **相当** |

---

## 四、五条可落地的启示（按性价比排序）

### 启示 1（最高优先级）：把 external-prompt 升级为「证据包端点」，用指纹绑定提议

**为什么**：这是唯一一条能把 ADR-0029「信任边界停在 proposal」从"**信任 Agent 的自述**"升级为"**结构上无法说谎**"的改动。

**现状缺口**：
- `src/http/operations.ts:521-525`：`createL2ExternalPrompt` 是"纯提示词组装"，返回自由文本给外部 chat。
- `proposeL2Candidate` 接受 Agent 提交的任意内容正文。
- 溯源是**事后自述**：`src/schemas/service/index.ts:185-204` 的 `provenance.source ∈ manual/llm/external_chat/...` + 可选 `confidence`，由提交方自己声明。
- 没有任何东西把"这次生成所依据的那批素材"和"送回来的产物"绑在一起。

**可失败的场景**（不需要恶意，模型漂移就够）：
1. Agent 产了一句例句并标 `source: 'dictionary'`，但其实并非来自该词典 → 现有的 superRefine 只能查"是否带了 dictionaryName"，查不出"这个名字是不是真的"。
2. 义项已经修订（义项顺序变了），但 Agent 用的是昨天的 packet → 产物引用错位。产线时间线一拉长必然发生。
3. h1-sentences 产线跨几十轮，`standard_version` 从 v2 演进时，旧的 batch JSON（注意目录里那一串 `PIPELINE.md.bak-before-vNN` / `EXAM-UPGRADE.md.bak-before-v11/v14`）没有 fingerprint 可供证伪——**这是已经在发生的风险**。

**落地**（不动现有架构，加一道 precheck）：
```
POST /api/l2/:slug/evidence-packet   →  { packetId, packetDigest, items:[{evidenceId, ...}], expiresAt }
POST /api/l2/:slug/candidates        →   body 增加 optional { packetId, packetDigest, usedEvidenceIds[] }
```
服务端：digest 不匹配 / evidenceId 不在包内 / 包过期 → **422**，且不消耗额度。
渐进策略：先宽松（缺失即警告，落 `verificationStatus: pending`），一个迭代后收紧为必填。

**附带收益**：evidenceId 一旦落库，`l2EvidenceSchema`（`service/index.ts:207-215`）的 `rawPhrase` 就有了可机检的锚点——现在它只是 Agent 自述的一段字符串。

---

### 启示 2：`verificationStatus` 与 `is_active` 正交——采纳 ≠ 已核对

**为什么**：这两个语义现在被压成了一个布尔。

`acceptL2Candidate` 把 `is_active` 置 true，等价于同时断言"我选中了它"和"它已被核对"。但 ADR-0029 的原文只要求前者：**自动采纳是被禁止的，因为"采纳"是一次可担责的判断**——可担责判断的产出应该留下痕迹。

**后果**（在 vocab-ob 里比在 HytideLegend 里更严重，见第五节）：
- 一条从未被逐字看过的模型条目，和被认真核过的条目，在下游完全无差别。
- 下游有一堆东西依赖内容可靠性：错题库（ADR-0021 needs-recheck 派生）、L2 Drill 的生产句、`一键遗忘` 里 agent 对 **`锚点词`** 的 narrate。**没有可查询的可靠性位，这些东西只能一律假设内容是可信的。**

**落地**（加字段，不改语义）：
- 给 `word_l2_content` 行级加 `verificationStatus: pending | machine_passed | human_passed` + 可选 `verificationRef{runId, decisionId, evidenceDigest, reviewedAt}`
- 给 `l3_questions` 加同样的两位（现在 `acceptL3Question` 从 pending→active 是一步跨越，ADR-0037 的"是最后一次抓住错误答案键的机会"正好对应 `machine_passed`→`human_passed`）
- **建议只落在 row/question 级，不要加到 items 级**——items 的 `provenance` 已经够细了，再叠会变成双份真相源

**粒度决策点**（需你定夺）：`human_passed` 是 **自动随采纳置位**（采纳行为本身就是一次人工判断的证据），还是**要求独立的显式勾选**（"我已逐条核对"）？前者成本为零但只是把现状换个名字；后者有真实信息量但多一次点击。我倾向后者，但这是一次 UX 成本 ↔ 数据真实性的取舍，不该由我替你决定。

---

### 启示 3：h1-sentences 产线——你其实已经发明了这套模型，只差把它从「规矩」提升为「Schema」

这条是最有意思的：**不是抄对方，是发现自己已经做对了 80%**。

对照一下：

| HytideLegend | vocab-ob h1-sentences 的对应物（已有！） |
| --- | --- |
| `automatic_passed`（脚本确定性核验） | 🟢 **绿区** split / split_roles / structure："机械自检（拼接还原、与 split 等长、受限术语表）"—— `PIPELINE.md` §6.3 |
| `pending` + 人工/联网核验 | 🟡 **黄区** 指代 / 专名 / 多义词句内义项："必须联网核验，结果写入 `verified.checked`" |
| 黑名单 + 拒绝 | 🔴 **红区** 考频 / 真题 / 背景补写："禁写（黑名单正则兜底）" |
| `gaps.json` 逐项记 reason | `ledger.exceptions[]{batch, word, kind, reason, decision, date, fixed}` |
| 三闸门全绿才入账 | `qa_check.py` + `exam_firewall_check.py` 全绿 + `kp_lint.py` 无 FAIL 才写 done |

**缺的只是**：这套分级没有被写进 `EXAM-UPGRADE.md` §9 定义的 `sentence.verified` 结构里作为一等字段，也没有 fingerprint。

**落地**（小改动）：
1. `sentence.verified` 增补 `zone`（green/yellow/red）+ `status`（machine_passed/human_verified/blocked），让 `checked[]` 的每一条都带上可用于风险可视化的定性分级——现在 `checked[{item, method, result}]` 有 result 但没有定性分级。
2. batch JSON 的 `meta` 增加 `packetDigest = sha256(standard_version + 词表 + applied_canon)`。`standard_version` 一变，旧批次必须先重算 digest 才能继续入账。这是把那一串 `.bak-before-vNN` 变成可审计证据的关键一步。
3. ledger 增 machine-readable 的 `pauseState{kind, reason, at, resumeToken}`，把 PIPELINE.md §7 的停止条件从"agent 读文档自觉遵守"变成可查询状态。

---

### 启示 4：故意篡改的自测（mutation testing）——给 ADR-0029 / ADR-0037 加固

HytideLegend smoke.py 里最有价值的一类用例是**伪造攻击**：篡改 digest 后断言必须退出码 4；篡改 receipt 时间断言必须 4（`smoke.py:623-633`）。它测的不是"正常路径能跑通"，而是"攻击路径一定被拒"。

vocab-ob 有 `route-authorization.test.ts` / `authorization-matrix.test.ts` / `authorization-registry.test.ts`，覆盖了**权限矩阵**——但没有发现针对**溯源 / 证据**本身的对抗性用例。

**建议补的断言**（每条都必须 4xx，否则 CI 红）：
- 伪造 `provenance.source = 'dictionary'` 但不带 dictionaryName
- 给 `source_supported` 条目同时带 `confidence`（对应 §2.4 的互斥约束）
- `evidenceId` 指向不存在的证据 / 跨另一个词的证据
- `agent` 角色直接把 `status` PATCH 出 `pending`（ADR-0037：只能改 pending）
- 用陈旧的 `standard_version` 提交批次
- `l3_questions` body 携带 `created_by`（已有 `.strict()` 拦，`papers-authoring.ts:15` → 补一条回归把它钉住）

这类测试的价值：现在这些规则是"**排列上正确**"（代码里写了），加完这组用例后变成"**性质上被保证**"（改坏了 CI 会拦）。

---

### 启示 5：把文档里的示例变成 fixtures

HytideLegend 的 `render_span_examples.py` 会把手写案例先跑一遍业务校验再渲染成 md，不过关整个渲染失败。

vocab-ob 的 `EXAM-UPGRADE.md` §8（结构轨道 / `split_roles` 提案字段）里有大量手写示例。这些示例目前的作用是"给人看"，但它们完全可以兼任"守 (ca)non 的 fixture"：抽到 `tests/fixtures/` 之外、由 `verify-* `脚本消费。**文档里的例子一旦和实际规定的 neljäessä 不符，CI 应该红**，而不是等人读出来。

---

## 五、一个战略层的判断：vocab-ob 对这个模型的需求比源项目更强

值得单独说一句。

HytideLegend **没有间隔重复**。它的词条即使有一条内容有错，影响范围是"用户看到一次"。

vocab-ob **有 FSRS**。一旦一条错误内容被采纳进 L2，它会被**自动排程、反复复习、最终固化为长期记忆**——错误不是被显示一次，是被**放大**。再叠加：
- 错题库（ADR-0021 派生）会把错误的内容关系拿去重练
- L2 Drill 的生产句会让用户**主动围绕错误义项造句**
- 一键遗忘里 agent 的 narrate 会基于错误的关系挑 `锚点词`

→ **内容可靠性在 vocab-ob 不是一个质量问题，是一个记忆正确性问题。**

这解释了为什么启示 2（`verificationStatus`）在这个项目里的权重应该比它在 HytideLegend 里更高：对方用它给资产定级，我们需要它来防止**把幻觉循环进长期记忆**。

---

## 六、优先级建议

| # | 启示 | 体量 | 收益 | 建议时机 |
| --- | --- | --- | --- | --- |
| 1 | 证据包 + digest 绑定 | 中（新端点 + 一道 precheck） | 让 proposal-only 从约定变结构 | 下一个 AI 侧迭代 |
| 2 | `verificationStatus` 正交位 | 小（加列 + 迁移） | 解锁下游所有可靠性查询 | 与 1 同批，先落字段再落校验 |
| 3 | 产线 zone/status + packetDigest | 小（改 JSON 结构 + 闸门） | 让 6500+ 词的产线可审计 | 下轮产线恢复时顺手做 |
| 4 | 对抗性 mutation 用例 | 小（加测试） | 把 ADR-0029/0037 钉死 | 随时，建议跟 1 一起提 PR |
| 5 | 文档示例 → fixtures | 小 | 防 documentation drift | 低优先 |

**不建议做的事**：
- ❌ 不要照搬 Python CLI 状态机形态。vocab-ob 是 server-authority + online-first（ADR-0023），把编排塞回 CLI 会与这条架构决策正面冲突。
- ❌ 不要用文件 journal + 双哈希替换现在的 outbox lease + recoverExpiredLeases。后者更强。
- ❌ 不要给 items 级再加一层 provenance（与现有 `content.items[].provenance` 冲突，会形成双份真相源）。溯源状态的正确落点是 row / question 级。

---

## 七、一句话总结

HytideLegend 真正教给我们的，是一句可以写进 ADR 的话：

> **提案的价值不在于它说了什么，而在于它能不能被追溯到唯一的那批证据。**

vocab-ob 已经把「非 owner 只能写提案」做成了代码强制（`FAIL_CLOSED_MIN_ROLE`），这是大多数项目做不到的。缺的最后一步，是让提案**自带不可伪造的出处指纹**——让"出自哪批素材"成为结构的一部分，而不是文案的一部分。

---

*分析依据：HytideLegend 侧读取了 README.md / SOURCE_OF_TRUTH.md / AGENTS.md / build-word-entry、mark-memory-spans、schedule-ebbinghaus-plan 三个 SKILL.md / 词汇星图 README，并对 utils/ 做了全量机制剖析（workflow_state.py、file_transaction.py、jsonl_store.py、dictionary_store.py、dictionary_records.py、application_contract.py、artifact_manifest.py、artifact_location.py、catalog_audit.py、document_audit.py、capability_catalog.py、commit_history.py、version_history.py、english_inflections.py、dictionary_spelling.py、span_ops.py、render_span_examples.py、entry.schema.json、workflow-state-v1.schema.json）。vocab-ob 侧读取了 CONTEXT.md、operations.ts 路由注册表、api-authorization.ts、src/schemas/service、src/db/schema.ts 关键表、src/llm/*、h1-sentences 的 PIPELINE.md 与 ledger.json。*
