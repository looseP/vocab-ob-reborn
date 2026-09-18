# ADR（writing-workspace）: 作文子空间 v1——写作任务、稿次与反馈契约冻结

- **Status**: Accepted（2026-09-18：作文子空间设计 v1 定稿；本 ADR 为 W0 契约冻结件，随 W0–W11 执行）
- **Date**: 2026-09-18
- **Amends**: ADR-0030（**仅声明修订，不修改原文**——ADR 不可变）：题纸作用域（scope）从 `file / paper` 扩展 `writing`；题面引用式架构的冻结约束（§6）。ADR-0034：题纸状态机与「定格」语义延伸至写作稿（draft→sealed，定格后正文只在 attempts）；注记面 `review_sheet_id`（F-1）与作文 feedback 是两条独立真源，不得混用。ADR-0029：agent 边界新增第三个精确开口——「读指定已提交稿的 feedback-context + 写该稿 feedback」（§4），开口严格限于作文稿面。
- **References**: 设计基线《作文子空间特化设计 v1》（`docs/plan/writing-space-design-2026-09-18.md`，简称 S——本 ADR 的完整规格来源）；执行计划《writing-space-execution-plan-2026-09-18.md》（W0–W11）；ADR-0022/0023（单 owner、在线优先、无离线队列）；ADR-0004 §6（L3 零 FSRS）；ADR-0035（agent 执行面先例：服务端身份认定、专用写面）；F-1 / PR #121（题纸档案与 `?sheet=` 回看先例）；`docs/design/l3-space/baseline.md`（E1–E4 + 本次新增 W1–W5）

## Context

L3 的做题台面（ADR-0030/0033/0034）解决的是「题」：卷面、注记、判读。**写作不是做题**——作文需要的是低摩擦的「开始写→可靠保存→提交→按稿评阅→第二稿」，而现有 `L3ExamPaper` 的卷面模型（点击判读、立即定格、泛化评分）与写作流程正交。2026-09-18 设计会话把作文子空间的真源、并发、权限一次定死，本 ADR 把不可回退的决策钉为架构约束。

三条设计哲学（S§0–1）：

1. **正文只有一份真源**——草稿期在 `answers[questionId].text`，提交后在 attempt；不做第二套「稿件全文表」。
2. **任务引用题面，不复制快照**——题面以 question 为唯一真源，代价是题面冻结（改题意=新建任务），以换取无快照漂移。
3. **反馈绑定精确稿**——`sheetId + textSha256` 双钉，换稿即失效；不做跨稿复用，不压扁为 correct/partial/wrong。

## Decision

### 1. 写作任务 `l3_writing_tasks`（题面引用式）

- 作文用户不感知底层题型：任务形式为 `kind = whole | paragraph | free`，方向为 `direction = 通用（作文枚举）/ 考研 / 雅思`；与题型 enum、评分体系均无关系。
- **引用式题面**：任务存 `question_id`（复合 FK `(question_id,user_id) → questions(id,user_id)`，RESTRICT）；直接新建任务时同事务创建一行 `long_essay` 内部题（`file_key = 'writing:' + taskId`，`options=[]`、`answer={}`），题面存 `question.stem`。
- **题面冻结（引用式架构的代价，明示钉死）**：任务创建后，题面**不可经普通接口原地修改/删除**；修改写作题意 = 新建任务。此约束必须同时落在：(a) 本 ADR；(b) 题目删除面（被写作任务引用的 question 删除返回可理解的 409 blocker，不泄露其他 owner 信息）；(c) 未来 question 编辑契约（若新增，必须守此约束）。**不允许只写代码注释。**
- **幂等创建**：客户端 `create_request_id`（UUID，失败重试沿用）+ 服务端 `create_input_hash`（规范化输入 SHA256，**不随 title 变化**）；同 requestId 不同输入 409 `IDEMPOTENCY_CONFLICT`。同题复用活跃任务须同 `kind/direction`；`forceNew=true` 才新建独立任务。
- **内部题隔离**：`writing:` 前缀 + 关联任务的**双重条件**过滤普通 practice-files 聚合，不得单看用户可输入字符串。
- **任务只归档、不硬删**：`status = active | archived`；归档前有 draft 返回 409；归档不删稿件，读取/导出仍可用；无硬删入口。

### 2. 题纸扩展：`l3_submissions` 写作元数据（scope 扩展）

- scope 新增 `writing`；`scope_key = 'writing:<taskId>'`。writing 行要求 task 非空、source/question_type/paper 全空；非 writing 行写作元数据全 NULL（CHECK 收口）。
- 新增四列：`writing_task_id uuid NULL`、`parent_sheet_id uuid NULL`（复合 FK → submissions(id,user_id)，RESTRICT）、`revision_no integer NULL`、`draft_version integer NOT NULL DEFAULT 0`。
- 既有部分唯一索引 `(user_id, scope_key) WHERE status='draft'` 继续承担「单任务一草稿」。
- `UNIQUE(user_id, writing_task_id, revision_no)`；draft/discarded 的 `revision_no=NULL`，sealed 必 `>0`；**首次提交在 task 行锁下分配 `max(revision_no)+1`**（discard 不占号，非 count 充当 max）。
- 父稿同 task 且 sealed 由事务内检查；`discard` 仅针对 draft（清空 answers、无 attempt、不复用提交稿）。

### 3. 正文真源（单一）

- **草稿期**：`answers[questionId] = { text: string }`（`20,000` UTF-16 code units 硬上限；超限 422；空稿可保存）。专用保存契约 `writingDraftInputSchema = { expectedVersion, text }`——**不复用** strict `sheetAnswerSchema`（其只有 choice/flags/optionFlags/marks，无 text），也不把通用 open 输入扩成可随意写 writing。
- **提交后**：正文唯一真源为**该 sheet 的 active attempt** `answer.text`（同事务：创建 attempt → 清空 answers → `sealed`）；**不另建全文版本表**。一个 writing sheet 只物化一个 attempt（部分唯一索引 `(sheet_id) WHERE venue='writing'`）。
- **attempts venue 扩展 `writing`**；soft-delete writing attempt 时同事务清理对应 feedback——读取/评阅/导出**一律不返回已删除正文或含其摘录的反馈**；历史留「正文已清理」占位，不得从备份或其他列复活。
- **正文规范化**：保存与 hash 统一 `NORMALIZE_LF`（CRLF/CR→LF），**不 trim、不 Unicode normalize**；返回正文与偏移基于同一字符串。

### 4. 保存、提交与并发（版本语义）

- **锁序**：写作写路径一律 `task → sheet` 固定顺序；状态/归属/版本检查在持锁事务内；不调用另开事务的 public service 组成「伪原子」。
- **CAS 保存** `PATCH draft { expectedVersion, text }`：`UPDATE ... WHERE status='draft' AND draft_version=$expected`；不一致 409 `DRAFT_VERSION_CONFLICT`，绝不 last-wins 覆盖。
- 客户端单 PATCH 在途；`flush()` 必须等待服务端确认才 resolve，失败 reject；提交与导出**不能越过保存失败/in-flight**（提交前 `await flush`，导出前 `await flush`）。
- **重复提交幂等**：已 sealed 的重复 submit 返回同一稿（200），无新 attempt、无新稿号。
- 通用 `PATCH/seal/discard` 入口遇 writing sheet 返回 409 `WRITING_ENDPOINT_REQUIRED`——**通用写面不得成为绕过专用规则的旁路**（服务端拦截，不只在 UI 隐藏）。

### 5. 作文反馈 `l3_writing_feedback`（唯一质量反馈源）

- `UNIQUE(user_id, sheet_id)`：一稿一条当前反馈，`expectedVersion` 更新，**latest-wins、无历史版本**（正文稿次不可变与反馈 latest-wins 是两件事）。
- **绑定精确稿**：`text_sha256 = SHA256(UTF-8(NORMALIZE_LF(原样正文)))`；anchor `offset` 为 JS UTF-16 code unit，`quote` 必须严格 `text.slice(start,end)`（中文/emoji/换行均有测试）；hash/quote 不符 422。
- 结构按 S§5 逐字段（summary/strengths/dimensions/priorities；无 numeric score、无 correct/partial/wrong）；总 JSON ≤ `64KiB`；纯文本显示，不渲染 agent markdown/HTML。
- **唯一性**：作文 feedback 是作文稿的唯一质量反馈源——**generic grading 入口对 writing sheet 返回 409**（提示使用 writing feedback），不同时写两种真源；旧试卷的 essay 行为不变，进入专用写作任务后才采用新反馈流程。F-1 的 `review_sheet_id`（注记评语来源）与作文 feedback 不得互相冒充。

### 6. 权限（提交即限定授权）

- **owner**：创建任务、保存、提交、改稿、归档/恢复、导出、读反馈。
- **agent**（服务器按 bearer token 认定身份，永不信请求体自述）**仅两个开口**：
  - `GET .../feedback-context`：读**指定已提交稿**（sealed + active attempt + 正文未清理）的题面/方向/稿次/正文/hash/反馈版本；draft 409、非本人 404。
  - `PUT .../feedback`：写**该稿**反馈；`last_editor` 由 Principal 注入。
  - **禁止**：读 draft、任务列表、其他稿、写正文、归档、通用写作管理。owner 可读 context、可 PUT feedback（`last_editor = owner`）。
- 提交按钮文案说明「提交后本地评阅助手可读取本稿」；**不自动派发网络任务**；复制指令只含 taskId/sheetId/相对 API/题目要求与评阅范围，不含 token 或其他稿全文。

### 7. GET 只读与 URL 契约（含 F-1 兼容）

- **GET 全部只读、零创建零写入**；查看某稿不调用 `openSheet`、不生成 draft；**新稿只由明确 POST 创建**（`POST /tasks/:taskId/drafts`）。
- 统一 sheet 查询参数：`/l3?section=writing&writingTaskId=<uuid>&sheet=<uuid>`（不引入 writingSheetId 参数）；`section=writing` 优先选择作文宿主，不被旧 sheet 导航 effect 抢回试卷台。**纯 `?sheet=<uuid>`**：先 GET 判 scope——file/paper 沿用 F-1；writing **只读**解析 taskId 并 `replace` 为作文规范 URL，**禁止调用 openSheet**。
- 对照：`compareTo=<sealedSheetId>`，两稿均须 sealed、同 task、owner 可读。
- **旧档案读面显式限定 `file / paper`**（writing 记录不落入无法打开的列表）；单纸 GET 支持 writing 安全元数据及归属核验。F-1 的刷新/改判/跨轮隔离/F5 不新增纸语义**不重做**，写作侧复用其交互语义。

### 8. 归档、清理与删除策略

- 任务归档不删稿；归档任务可导出；恢复不自动开纸。
- 正文清理（attempt soft-delete）后：占位可见、feedback/context/export 不泄漏正文或 quote；**不存在** 404 与 **已清理** 严格区分（清理稿：text=null/hash=null/wordCount=0/feedback=null，feedback 面 409 `WRITING_CONTENT_CLEARED`）。
- 题目删除遇写作任务引用 → 409 blocker（§1）；不硬删任务、不硬删稿。

### 9. 边界（明确后置，不在 v1）

数字评分/rubric、计时模拟、自动 agent 守护进程、自动全文代写、音视频、素材推荐、全站搜索、学习能力总分；**无 FSRS 写入、无离线写队列、无新运行时依赖**；单 owner、在线优先（ADR-0022/0023）。

## Tradeoffs

- 题面引用式 → 无快照漂移，但改题意必须新建任务（接受）；删除面需要 blocker 配合（已钉 §1）。
- 正文单真源到 attempts → 无副本漂移、导出/删除不分叉，但草稿与提交态的读取路径不同（专用 service 收口，接受）。
- 反馈 latest-wins 无历史 → 存储简单、语义单一；牺牲可追溯性（S 明示接受，M4 若需另立契约）。
- agent 第三开口 → 打破 ADR-0029「仅提案写入」的原状，但开口极小（仅指定已提交稿 + 该稿反馈），与 ADR-0035 的评卷面并列受控。

## Consequences

- W1（本 ADR 随行）：schema/DTO 冻结 + 迁移（号以实际 journal 分配）+ 真实 RLS 证据；W2–W11 按执行计划推进。
- 验收锚点：baseline.md 新增 W1–W5（动笔前最多一次确认 / 保存状态诚实 / 反馈明确对应稿次 / 离开再开不生成新稿 / 修改不覆盖旧稿），与 E1–E4 并列；真环境闭环（浏览器 + 真实 HTTP + 独立 PostgreSQL）为完成判据。
- 迁移兼容：新列对旧 file/paper 行兼容（NULL）；writing 记录存在后不得回滚到不认识 writing 的旧二进制；缺陷时先撤入口、关闭写作写请求，保留可读与导出（S§9 发布与回退边界）。
- 本 ADR 若与 S 冲突，以 S 为准并回修本文件；与旧 ADR 冲突处按本 ADR 的 Amends 声明执行。
