# 作文与试卷台整合修复：外派执行计划

> 执行方式：使用 executing-plans 按 I0–I5 串行推进。本文是外派任务书；当前会话不改业务代码、不启动其他执行者。

**目标**：用户从「试卷台 → 题型空间 → 小作文／大作文 → 原题」自然开始、继续、回看作文，并能返回原题；一级「作文」作为同一批写作任务的汇总和自由练习入口。

**架构**：复用现有 writing task/sheet/feedback 和编辑器；以 questionId 关联原题。来源导航是本次进入工作区的上下文，不把某张试卷固化成题目或任务的唯一归属。普通试卷答案与专项作文稿件仍是独立作答。

**技术栈**：TypeScript、React、Hono、PostgreSQL、Vitest、Playwright；使用项目配套 Node 22.22.2。

## 事实基线与取舍

- 已合并作文 v1：`ccc6fb4c90f45c6e13f0d581298bb617a79baac2`。执行时重新读取 main 与工作区，不将此 SHA 误当永远最新。
- `L3PapersPage.tsx` 的 QuestionList 已有「在作文空间练习」入口，但仅在 fileKey 型浏览分支接线；source 型分支直接进入 L3ExamPaper；整卷也未全面接入专用入口。
- createTask 支持 questionId，按 owner + question + kind + direction 复用活跃任务。已有任务无草稿时返回 draft=null，不自动另建稿。
- L3WritingPage 的返回只到作文列表，缺原题来源返回；原题列表缺写作进度回显。
- 新方案选择「复用专用工作区 + 打通入口、返回、进度」。只补链接不能满足闭环；把整卷答案与作文稿合成一份会改变既有提交语义，本轮不做。
- 本轮不做自动评阅、父稿反馈伴随修改、评分或复杂 diff；刷新反馈和手机定位等已发现问题另列后续，不夹带成全站重构。

## 不可破坏的边界

1. writing 的正文、稿次、反馈维持现有单真源；不复制到普通 paper/file 作答，不伪造 generic verdict。
2. 列表、进度查询、打开历史、返回原题、F5 都只读；创建只在用户明确点击「开始写作／开始修改」后发生。
3. 整卷入口明确标注「专项练习（不计入本次试卷作答）」。原卷已有作文文本不得静默导入，不自动提交原卷、不自动给分。
4. 来源题可能出现在多张卷中；返回本次进入的上下文，不能用任意一张关联卷替代。
5. 不重写 0038。优先无迁移实现；新增接口需同步 DTO、授权、OpenAPI、生成客户端和治理。
6. 隔离 worktree 实施。共享入口 L3Page、L3PapersPage、L3ExamPaper、operations/schema 由同一集成者串行修改，保护 study-notes 产物。
7. 3099 是用户当前体验服务，`vocab_writing_test` 已有用户体验数据：禁止重置、清表或执行有全局清理的测试 setup。另建专用验收库与端口；不改 3001/live 库，不部署生产。

## 目标交互与导航契约

### 原题上的入口

| 原题对应的写作状态 | 主操作 | 读面信息 |
|---|---|---|
| 无活跃整篇任务 | 开始写作 | 尚未开始 |
| 有草稿 | 继续写作 | 有进行中草稿；已有提交稿数量 |
| 无草稿，有已提交稿 | 查看本稿 | 最新第 n 稿；尚无反馈／已有反馈／正文已清理 |
| 多个匹配任务或仅有归档历史 | 查看写作记录 | 列出匹配任务，明确区分归档；不得任意挑一条或自动创建 |
| 查询失败 | 重试 | 不把失败显示为「尚未开始」 |

原题入口默认整篇 whole，方向继承所在上下文；自由练习、段落专项不能误当整篇作答。回看已清理稿只能见占位，不能导出或复制其旧正文。

### 来源上下文

- 保留既有 `/l3?section=writing&writingTaskId=...&sheet=...` 契约，另加可选、版本化的结构化 `origin` 参数。
- `origin` 只允许 file/paper 两种枚举与明确字段：questionId、题型、sourceId/fileKey 或 paperId、进入时实际 paper/file sheetId。以严格 schema 解析，限制长度；不是任意 returnUrl，不接受协议、外站地址或脚本。
- origin 随查看其他稿、开始修改、对照与 F5 保留；不写进 task 的来源真相，不用它决定数据访问权限。
- 原题关联由 task.questionId 校验；来源读取必须 owner 范围，验证题目确实属于对应文件/卷。参数无效或来源不可达时给明确提示，回退作文列表；不得自动开纸或创建来源。
- 工作区显示「来自：题型／文件或试卷标题」，提供「返回原题」与次级「全部作文」。自由写作不伪造来源。
- 返回时恢复原文件/卷及题目位置；若进入时已有草稿题纸，恢复那个 sheet；若已 sealed，进入只读。不得通过通用 openSheet 代替按 ID 读取。不得依赖浏览器 history.back 或仅内存 state。
- 一级作文列表直接打开来源题任务时，没有 origin 就至少显示关联题面与题型；不猜测唯一试卷来源。原入口创建的任务必须也出现在该列表中。

## I0：现场与行为基线

**文件**：本计划、`docs/plan/writing-practice-integration-log-2026-09-18.md`（新建）。

- [ ] 读取实际 main/head/status、现有计划/ADR/导航契约；创建隔离 worktree，记录本轮文件所有权。
- [ ] 只读确认 fileKey 浏览、source 文件、整卷草稿、整卷回看四个分支，记录入口现状。
- [ ] 建立专用验收库和新端口，以合成题创建小作文、大作文与包含作文的试卷；记录迁移与角色验证结果。
- [ ] 日志记录固定基座、预期用户路径、与用户体验环境隔离方式；点名提交本计划与日志，不夹带 README 并发修改。

## I1：来源导航与返回

**文件**：扩展 `src/frontend/viewModels/writingNavigation.ts`；新增 `tests/frontend/writing-navigation.test.ts`；后续集成修改 `L3Page.tsx`、`L3PapersPage.tsx`、`L3WritingPage.tsx`。

- [ ] 先写失败用例：origin 序列化往返；缺省兼容旧链接；非法结构和外站输入拒绝；换稿/对照保留来源；返回 URL 不创建数据。
- [ ] 实现统一 parse/build 工具与 origin 类型，禁止在各按钮中自行拼接路径。
- [ ] 接入只读来源解析与返回：复用已有 owner 读接口；确有缺少的关系读面时新增薄接口，不通过写接口探测来源。
- [ ] 用组件测试验证 F5、返回原题定位、来源删除/无权时的降级，以及普通 F-1 深链仍可用。
- [ ] 定向测试通过后独立提交。

## I2：原题进度只读查询

**文件**：`src/domain/l3-writing.ts`、`src/repositories/l3-writing.repository.ts`、`src/services/l3-writing-task.service.ts`、`src/http/routes/l3/writing-tasks.ts`、响应契约、operations、writingClient；对应 repo/service/HTTP 测试。

- [ ] 增加 owner-only 批量只读摘要 `GET /api/l3/writing/question-summaries?questionId=<uuid>&questionId=...&kind=whole&direction=...`；1–100 个去重 questionId，strict 校验。
- [ ] 响应逐题返回可访问的匹配任务摘要：taskId、taskStatus、draftSheetId、latestSubmittedSheetId、latestRevisionNo、revisionCount、最新已提交稿的 feedbackState/contentStatus；无匹配用明确空数组。方向不同的上下文分批查询。
- [ ] 多个匹配任务返回列表，不任意挑选。不存在/他人题不得返回其任务或存在性信息，统一按不可用处理；读取零 INSERT/UPDATE，agent 无权限。
- [ ] 聚合查询按 owner + question + kind + direction，避免前端逐题串行查询或拉全量任务后过滤。摘要只返回状态，不泄漏正文/反馈文本。
- [ ] 验证无稿、草稿、待评、有反馈、清理、归档、多任务、跨 owner 与失败状态；更新生成物并运行 API governance，独立提交。

## I3：所有作文入口与安全跳转

**文件**：`L3PapersPage.tsx`、`L3ExamPaper.tsx`；新增共享 `src/frontend/components/writing/WritingQuestionEntry.tsx`；`tests/frontend/l3-papers.test.tsx` 和新增 `writing-question-entry.test.tsx`。

- [ ] 先写入口矩阵失败测试：short_essay/long_essay × fileKey/source/整卷草稿/整卷回看；非作文题不新增入口。
- [ ] 共用入口组件消费 I2 摘要，落实上述操作表。原题先有草稿时「继续」只 GET；无草稿有提交稿时「查看」只 GET；仅「开始」调用 createTask，并保留一次点击意图的 requestId 用于未知结果重试。
- [ ] 来源题面、题型和方向使用现有权威数据，不重复粘贴题面；同题同形式同方向多次进入复用任务。
- [ ] 整卷跳转前沿用并核实保存屏障：等待在途保存和最新输入确认，失败留在原页并保留文本。不得仅调用一个吞错/未等待完成的 flush 就导航；已提交卷只读跳转。
- [ ] 返回原题后重新拉摘要，及时体现提交、反馈与清理结果；加载失败保留诚实错误态。
- [ ] 集成者运行入口与原卷保存回归，独立提交。不要同时让多个执行者修改 L3ExamPaper。

## I4：作文工作区的来源闭环

**文件**：`L3WritingPage.tsx`、必要的来源展示小组件、`tests/frontend/writing-workspace.test.tsx`。

- [ ] 显示来源标题、返回原题与全部作文；独立作文入口保留，但来源练习的主返回不再指向汇总列表。
- [ ] 稿件切换、开始修改、对照、刷新均保留 origin；未保存稿离开仍受现有保存/导航保护，禁止绕过。
- [ ] 将固定「开始修改（第二稿）」改为「开始修改」，避免第三稿文案错误。
- [ ] 验证同一题从两张不同卷进入，各次返回各自来源，但复用同一符合条件的 task；无来源参数时不出现错误的卷归属。
- [ ] 组件测试通过后独立提交。

## I5：真实浏览器验收、PR 与体验交付

**文件**：新增 `e2e/writing-origin.spec.ts`，必要的 CI 接线、测试计数校验器、执行日志。

- [ ] 完成真 API + 专用 PG + 实际前端旅程：题型空间选作文 → 开始 → 保存 → 返回原题见草稿 → 继续同稿 → 提交 → agent HTTP 写回 → 返回见已有反馈 → 查看同稿 → 第二稿 → 返回 → 重进与 F5。
- [ ] 每个关键节点同时记录 UI 与 task/sheet/attempt 数量；F5、返回、查看、继续操作前后数量不变。
- [ ] 整卷测试：已保存普通答案进入专项再返回，同一个原卷 sheet、相同原卷答案；慢保存等待、保存失败不跳转；writing 提交不改变原卷 answers、status、grading。
- [ ] 覆盖两卷同题返回不同来源、已归档/已清理/来源不可用、移动端入口与返回；所有测试使用合成数据，不操作用户体验稿件。
- [ ] 新旅程接入实际执行的 Writing E2E 必需检查；当前 validator 固定收集 4 条，增加测试文件时同步调整检查与回归断言，不能放宽成允许零执行/跳过。
- [ ] 运行 `npm run typecheck`、`npm run arch:check`、定向组件/HTTP测试、`npm run api:governance`、`npm run frontend:build`；按实际 PR base 执行仓库要求的全量/分层门禁，等待最终 SHA 三项必需 CI。
- [ ] 建立 draft PR 并附到执行任务；描述最终用户行为、证据、剩余限制，不把 HTTP/API 有能力等同于 UI 交付。
- [ ] 提供独立体验地址，直接打开有合成作文题的题型空间，让用户从原入口体验。保留现有 3099 与用户体验数据库，不擅自切换。

## 完成条件与授权终态

完成意味着用户无需先去独立作文列表，就能从原题开始/继续/回看，并准确返回原题、看到更新后的状态。入口与来源问题以真浏览器和数据库计数双证验收。

外派范围允许隔离实现、专用测试库、测试数据、分支提交、推送、draft PR 和独立体验服务；不合并、不部署、不改 live 库、不重置用户体验库。需要库连接凭据时从现有受控配置读取，日志不得输出。

若审查工具配额不足，可先完成实施和自查，但独立审查状态必须标记未完成；不要反复空派或将自查记作独立审查通过。
