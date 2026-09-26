# ADR-0036: 阶梯复习工作流（三轮制会话 + ladder_rung 显式列 + 政策 B 评分）

- **Status**: Accepted
- **Date**: 2026-09-26
- **References**: 演示页《词生命周期 v3.2/v3.3 · 轮内交替》（`deliverables/software-company/demo/word-lifecycle-workflow-demo-2026-09-25.html`，B 区契约表 / D 区 stageMap v3.2 / E1 区集成设计，契约冲突时以该页 B/D 区为准）；ADR-0004（依赖克制）；ADR-0021（读时派生先例）；外派实现计划《阶梯复习工作流 LW-0 → LW-2》（2026-09-26）

## Context

现行 L1 复习流 = 单轮逐卡翻卡自评（ReviewPage → GET /review/queue → 逐卡 POST /review/answer）。词生命周期 v3.2/v3.3 演示页把复习会话升级为**三轮制阶梯会话**：再认轮（Hint 卡）→ 巩固轮（跟写/听写）→ 产出轮（默写 + 自选降档），轮内新旧交替、同词不背靠背。T3 Hint 阶梯（PR #137）已落地卡面提示消费埋点（hintLevel/viaH4），本 ADR 把阶梯会话的服务端契约与起步档存储冻进代码。

七项拍板（演示页 B 区冻结）：

1. **评分语义 = 政策 B（B-floor）**：`rating = min(卡面自评, 默写映射)`，客观只降不升；R3 起默写映射为主。
2. **起步档存储 = 显式列 + 派生兜底**：`user_word_progress.ladder_rung smallint CHECK 1..3 DEFAULT 1`；首评初始化 R1；存量派生回填一次；列存在即用列，S 只做单向地板（S≥21d ⇒ rung≥R2）。
3. **R2 撤提示面板**（鼓励直翻，上限保持轻松）；照着打与默写保留。
4. **听写 = 跟写的强化**（非独立档位）：跟写档 TTS 可用先听写（无字形），失败降回跟写。
5. **FR-12 L3 语境卡背折叠增强**（挂现行 L3ContextsFold 位，本期只留位）。
6. **三轮制队列**：再认→巩固→产出；轮内新旧交替；同词两阶段不背靠背；R3 首试成功的词义卡复核排队尾；会话末逐词结算（FSRS + 起步档 + 门）。
7. **产出环节自选降档（选择即信号）**：默写界面常驻档位菜单（默写/听写/照着打），用户按掌握感随时自选，**不由失败触发**；如实差分评分 = `min(所选档上限, 档内表现映射, T3 提示上限)`；降档选择、放弃字符数、档内错键全量进 reviewLogs。

## Decision

### 1. `ladder_rung` 显式列（迁移 0045）

- `user_word_progress` 加列 `ladder_rung smallint NOT NULL DEFAULT 1` + `CHECK (ladder_rung BETWEEN 1 AND 3)`。
- **存量回填一次（幂等）**，派生规则 f(S, rv)：
  - `rv = 0`（从未复习）→ 1；
  - `S ≥ 21d` → 3（对齐演示页模拟数据：S=26d 词入 R3）；
  - `S ≥ 7d` → 2；
  - 其余 → 1。
  - WHERE 子句与派生值逐分支对齐，**二次执行零行变化**（幂等证明）。
- 结算职责：`ladder_rung` 由**服务端**在 `submitAnswer` 后结算（±1 + 单向地板，domain 纯函数），防客户端篡改策略状态；`rating` 由前端按政策 B 算好随 answer 提交（服务端不重复实现档位逻辑，契约最薄）。
- 进退规则：`good/easy +1`、`again −1`、`hard 0`（clamp 1..3）；单向地板：结算后 `S ≥ 21d ⇒ rung ≥ 2`（只升不降）。

### 2. 每词每会话恰好一次调度提交

再认轮自评/hintLevel/viaH4 前端暂存，**不 POST**；巩固轮（跟写/听写）无调度语义，**不 POST**；产出轮末一次性 `POST /review/answer`。**禁止对同一 progressId 在同一会话内二次调度提交**（防双重 FSRS 调度）。阶梯模式下 undo 入口整体隐藏（会话内无中间 answer 可撤）。

### 3. answer/queue 契约扩展（全部可选 = 非 breaking）

- `reviewAnswerSchema` 追加可选字段：`source?: 'card'|'typing'`、`wrongTimes?: int≥0`、`durationMs?: int≥0`、`tier?: 'dictation'|'listen'|'copy'`、`downgraded?: boolean`、`cardRating?: rating`、`abandonedChars?: int≥0`（先例：hintLevel/viaH4 即此模式；旧客户端缺省 = 现行为）。
- `submitAnswer` 把上述字段全量落 `review_logs.metadata`（jsonb 列已有，零新表）。
- queue 响应 items 追加 `ladderRung?: 1|2|3`（可选直载）。
- **零新流程端点**；openapi 再生后 request 可选新增 / response 可选新增均不触发 breaking 门禁（verify-openapi-breaking 口径）。

### 4. 阶梯会话模式开关（默认关）

- 设置页新增「阶梯会话（实验）」布尔项，前端 localStorage 持久化（v1 不做服务端偏好）。
- **关闭 = 与 main 逐字段一致的回归证明**：全部新前端代码路径（scheduler 编排/打字流/档位菜单/结算页）不可达；服务端新增字段全部 optional，关闭时请求体不含新字段。

### 5. 依赖克制（ADR-0004）

不引入任何新 npm 依赖。TTS 用浏览器原生 Web Speech API（能力检测，失败降跟写）。打字流无 setTimeout（阻塞式逐字状态机：字母全归答案、错字阻塞标红、wrongTimes 只增不减）。

### 6. 边界

- preview 模式**不进**阶梯（浏览语义）；cram 允许走阶梯（自测语义兼容）。
- 不动清单：L2 轨逻辑、l3-* 端点、现行默认卡面、queue/cram/preview 既有语义。
- 会话恢复：scheduler 游标 + 已暂存自评并入现行 sessionStorage 缓存结构（TTL 30min 沿用）。

## Alternatives Considered（否决记录）

| 备选 | 否决理由 |
|---|---|
| 降档由失败触发（错键 > 4 才出现 chooser，v3.2 原案） | 入口必须先于失败存在（v3.3 勘误）；「磨完 >4 键」也是诚实结果（映射重来），选择即信号更干净 |
| 双重调度（再认轮自评 + 产出轮默写各 POST 一次） | 同词两次 FSRS 调度污染间隔；改为单次提交 + metadata 全量搭载 |
| ladder_rung 由前端上报 / 派生存储不落列 | 客户端可篡改策略状态；派生读取需全表扫描且规则演进不可控；显式列 + 服务端结算 + 回填一次 |
| 听写作独立第四档 | 拍板④：听写 = 跟写强化，非独立档位；强度序跟写 < 听写 < 默写 |

## Consequences

- 迁移 0045 含幂等回填 UPDATE，重放安全。
- 阶梯会话的会话内交互（三轮编排/打字/档位/结算页）为前端纯编排，服务端只承接受影响的 answer 单次提交。
- 阶梯模式 v1 禁用 undo；后续如需，须先定义会话级撤销语义。
