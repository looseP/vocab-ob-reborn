# 作文与试卷台整合：I0 后续跑外派计划

> 执行者使用 executing-plans，按下列批次持续推进；本文件不授权当前指导会话启动并发实施者。已完成 I0，不重建 worktree、不重建验收库。

**目标**：在原小作文／大作文题型空间中完成「选题 → 写作 → 返回原题见进度 → 继续／回看」，整卷入口也可进入同一专项工作区并准确返回。

**架构**：复用作文 v1 task/sheet/feedback。questionId 是题目关联；origin 是本次导航上下文；原卷答案与专项稿件独立。一级作文保留汇总与自由练习入口。

**技术栈**：现有 React/Hono/Drizzle/PostgreSQL，项目 Node 22.22.2；不引入新框架。

## 0. 接手位置与边界

- 2026-09-19 本轮只读核对：`wt-practice` / `writing-practice-v1`，HEAD `f075142`，工作区原先干净。main 合并基座 `ccc6fb4c`；实施前重新检查实际状态，若已有后续提交或未提交实现，先辨认并承接，不 reset 或重做。
- I0 已完成：`e74e749`、`f075142`。原计划：`writing-practice-integration-repair-2026-09-18.md`；原启动指令及执行日志同目录。本续跑计划补充顺序和验收细节，不取代原设计边界。
- 固定使用专用库 `vocab_practice_accept`（5433）与端口 3100。I0 报告迁移 39/39、角色 verifier 通过；本次指导会话未重新跑数据库核验。
- 3099 / `vocab_writing_test` 有用户数据；3001/live、其他库及其他 worktree 的业务产物不得修改。3100 开放给用户后也不得再运行清库 setup，后续自动测试另用专用库。
- 单集成者拥有共享文件。现有 node_modules 是 junction，不擅自 npm install、npm ci、更新锁文件或删除依赖目录。
- 允许实施、测试、点名提交、推送分支、draft PR、启动独立体验服务；不合并、不部署生产、不迁移 live。
- 不扩展自动评阅、数字评分、全文 diff、整卷答案自动回填；先完成原入口整合。

## 1. 执行批次与依赖

| 批次 | 对应原任务 | 交付 | 依赖 |
|---|---|---|---|
| A | I1 + I2 | 来源导航契约、owner 关系校验、按题批量进度读面 | I0 |
| B | I3 首条路径 + I4 必要接线 | fileKey 原题 → 写作 → 返回 → 继续同稿的真环境闭环 | A |
| C | I3 剩余入口 + I4 收口 | source 文件、整卷草稿、整卷回看，多卷同题与全稿次来源保留 | B |
| D | I5 | 完整旅程、CI、draft PR、3100 体验交付 | C |

每批内部按「失败用例 → 最小实现 → 定向验证 → 点名提交」执行。批次回报是进度同步，不是重新申请授权；无真实阻塞时继续下一批。

## 2. 批次 A：导航与进度契约

### A1 / I1：来源身份与精确返回

**文件**：`src/frontend/viewModels/writingNavigation.ts`；新增 `tests/frontend/writing-navigation.test.ts`；必要的 domain/owner 读面契约。页面接线在 B/C，避免现在就大范围改宿主。

- [ ] 先测试：旧作文 URL 兼容；origin 解析往返；超长、未知字段、非法 UUID、外站值拒绝；换稿/对照保留 origin；同题不同来源返回不同位置。
- [ ] origin 固定 version=1，使用 file/paper 判别联合，包含 questionId 与原题型。file 必须明确 sourceId 或 fileKey；paper 必须有 paperId；进入时已有原卷/file sheet 就携带其 ID。不要复用当前 writing 的 sheet 参数存来源题纸。
- [ ] 用统一 parse/build 工具传递 origin，禁止任意 returnUrl、history.back、仅靠内存 location.state。只用参数生成站内 URL，不用参数推断权限。
- [ ] 确认 owner、来源、questionId、原 sheet 的真实关系。来源对应题必须等于 task.questionId，不能凭“题和卷都属于我”就视为关联。缺读面时增加最小 owner-only 关系读取，走项目授权与契约流程。
- [ ] 明确恢复模式：原 sheet 仍 draft → 按 ID 读取后恢复可编辑；原 sheet 已 sealed → 同 ID 只读；discarded/不可达 → 明确提示并回到来源列表。**不能把 draft 塞进仅支持 sealed 的 F-1 回看组件，也不能用 openSheet 补一个新 draft。**
- [ ] 对失效 origin 仅降级来源功能，不丢失合法作文稿件正文或清空编辑状态；用户仍可回到全部作文。
- [ ] 提交导航契约和测试。

### A2 / I2：按题批量只读摘要

**文件**：`src/domain/l3-writing.ts`、`src/repositories/l3-writing.repository.ts`、`src/services/l3-writing-task.service.ts`、`src/http/routes/l3/writing-tasks.ts`、响应契约、注册表、`src/frontend/api/writingClient.ts`；对应 repo/service/HTTP/client 测试与生成物。

- [ ] 实现原计划约定的 owner-only GET question-summaries：questionId 可重复传入，限制原始数量及去重后数量，最多 100；kind/direction 严格校验。
- [ ] 逐题返回匹配任务摘要：taskId/status、draftSheetId、latestSubmittedSheetId、latestRevisionNo/revisionCount、最新已提交稿反馈和正文可用状态；无匹配明确空数组。draft 与最新 sealed 摘要分开，不能把前稿反馈显示成当前草稿反馈。
- [ ] 一个 owner 范围的集合查询或固定数量查询完成聚合，避免逐题 N+1；查询失败不能在客户端归一为空结果。
- [ ] 汇总同题同 kind/direction 的匹配记录，归档历史也可识别。多个记录不任意取第一条；有唯一活跃匹配时优先继续它，其他历史可展开；多个活跃或只有归档时展示记录选择。
- [ ] 测试跨 owner、agent 拒绝、无记录、草稿+前稿反馈并存、清理、归档、多匹配、101 输入、查询失败；只读接口零写断言。检查静态路径不被动态 `/:taskId` 误匹配。
- [ ] 同步 OpenAPI/生成客户端，运行 API governance，独立提交。

**A 回报**：提交 SHA、实际 schema/DTO、关系授权与零写证据、失败/多任务决策表。不声称用户闭环完成。

## 3. 批次 B：先跑通一条用户路径

**文件**：新增 `src/frontend/components/writing/WritingQuestionEntry.tsx`；修改 `L3PapersPage.tsx`、`L3WritingPage.tsx`；`tests/frontend/l3-papers.test.tsx`、`writing-workspace.test.tsx`、新增 `writing-question-entry.test.tsx`。

- [ ] 入口状态测试先失败：尚未开始→开始；有 draft→继续；无 draft 有 sealed→查看；多记录/归档→记录选择；读失败→重试。
- [ ] fileKey 小作文和大作文接入共用组件。摘要由所在列表批量读取并向下传递，不让每个按钮自行请求整套摘要。
- [ ] 「开始」显式调用 createTask，单次意图 requestId 跨未知结果重试保持；「继续／查看」按已知 ID 只读导航。点击防重，后端同题复用仍是兜底。
- [ ] 工作区接入来源条、「返回原题」和次级「全部作文」。返回保留文件、题型、题目位置；保留未保存内容导航保护。
- [ ] 回到原题重新读取进度，不能沿用进入前的“尚未开始”。进度明确标注为专项写作，不当作原卷答题状态。
- [ ] 3100 真浏览器跑：原题→开始→输入保存→返回见草稿→继续同一个 sheet→F5→返回。统计 task/sheet/attempt：只有显式首次开始增加任务/草稿，返回、继续、F5 不新增。
- [ ] 提交→返回原题显示待评→查看精确 sealed 稿；读取不能新建下一稿。记录 UI 与库核证据，独立提交。

**B 回报**：可点击的 fileKey 合成原题地址、路径截图、开始前后及只读操作前后的数量；继续 C，不以截图替代计数。

## 4. 批次 C：剩余入口、原卷保存与多稿

**文件**：`src/frontend/components/l3/L3ExamPaper.tsx`、`L3PapersPage.tsx`、`src/frontend/pages/L3Page.tsx`、`L3WritingPage.tsx` 与相关测试。集成文件由一人串行改动。

- [ ] 扩展入口至 source 文件、整卷 draft、整卷 sealed 回看；short_essay/long_essay 均覆盖；其他题型不显示作文入口。
- [ ] 原卷旁显示「专项练习（不计入本次试卷作答）」。原答案不复制、不自动提交、不回填、不增加 generic grading。
- [ ] 在原卷跳转前锁定本次跳转意图，等待最新输入及在途保存确认。保存失败、版本冲突、未知结果必须留页保留正文；不能仅检查 save label 或 await 一个吞错的 flush。
- [ ] 测试慢 PATCH 后又有输入、PATCH 失败、重复点击、已有 sealed 原卷；校验能保存成功后才跳转，失败时既不跳转也不悄悄创建 writing task。
- [ ] 返回时按 A1 恢复原 sheet 与题目位置。进入后若另一标签已提交原卷，返回同 sheet 只读，不能创建新卷或显示可编辑假象。
- [ ] origin 随提交、开始修改、看历史、对照、刷新保留；把固定“第二稿”按钮改为“开始修改”。
- [ ] 同题同方向同 kind 放入卷 A、卷 B：复用同一 writing task，但各自来源链接返回各自卷/sheet；两个标签不共享一个全局 origin 状态。
- [ ] 直接从全部作文打开时不猜某张卷；保留题面关联，自由任务不伪造来源。清理稿、归档任务、来源不可达的状态按计划诚实展示。
- [ ] 各分支通过定向测试后提交；保存屏障若需修复，单独提交并记录先红后绿证据。

**C 回报**：四分支入口矩阵、原卷答案/status/attempt/grading 未被专项操作改变的证据、多卷同题返回证明与剩余风险。

## 5. 批次 D：最终验收与体验交付

**文件**：`e2e/writing-origin.spec.ts`、`.github/workflows/writing-e2e.yml`、`scripts/verify-writing-e2e-report.ts` 及对应回归测试、执行日志和验收报告。

- [ ] 真环境覆盖 B/C 路径，加上真实 agent HTTP 写反馈→返回原题显示已有反馈→查看→第二稿→对照→回看第一稿；验证每稿反馈独立，不写虚构“AI 已评阅”。
- [ ] 小屏验证原题入口、来源标题、返回与稿次操作均可用；桌面录制主旅程。保留原 file/paper F-1 回看回归。
- [ ] 新测试必须进入 Writing E2E 必需检查的实际执行命令。同步当前“4 条”固定收集数与断言，仍要求进程退出码 0、global errors 空、零 skipped/failed，不能通过弱化 validator 获得绿灯。
- [ ] 运行现有定向测试、typecheck、arch、API governance、frontend build、按实际 PR base 的全量与分层门禁。数据库测试仅连专用库；最终证据注明代码 SHA、base、库、端口、执行/跳过数。
- [ ] 推分支，创建并附加 draft PR，等待最终 head 的三项必需 CI。遇到真实阻塞如实记录，不擅自降低保护或改豁免。
- [ ] 为 3100 留一套有小/大作文与试卷的合成体验数据，启动受限 app 角色服务；核验 health/readyz、登录、原题页与写作入口可用。
- [ ] 交付地址必须直接进入题型空间中可选题的页面，同时给登录方式和服务停止方式；不只给独立作文首页。
- [ ] 更新日志/验收报告。不要反复仅为“当前最终 SHA”文案新增提交，历史跑次保留其 SHA，最终状态可在 PR 描述绑定。

**D 最终回报**：PR、head/base、三项检查链接、四入口矩阵、真实旅程证据、3100 原题体验链接、未完成项。未合并、未部署。

## 6. 可直接复制的续跑指令

```text
继续 wt-practice / writing-practice-v1 的作文与试卷台整合修复。

先读 docs/plan/writing-practice-continuation-plan-2026-09-19.md，结合原 repair 计划与执行日志执行。I0 已完成，已知 HEAD f075142；先核对现场，承接已有产物，不重建 worktree/库、不重做 I0。

按 A→B→C→D 持续推进：
A：I1 来源导航和关系验证 + I2 按题批量进度；
B：fileKey 原题→写作→返回→继续同稿，先完成真环境闭环；
C：补 source 文件与整卷草稿/回看、保存屏障、多卷同题、多稿来源；
D：完整 E2E/必需 CI、draft PR、3100 原题体验地址。

单集成者串行修改共享面。只使用 vocab_practice_accept 与 3100；不得停止或重置 3099/vocab_writing_test，不动 3001/live 和他线产物，不改变共享 node_modules。

核心验收：用户从原小/大作文子空间选题即可开始、继续、查看反馈并返回同一原题；返回/查看/F5 零新增；专项稿不改变原卷答案与评卷；未保存原卷必须完成保存后才跳转。

授权至实施、专用库合成数据、提交/推送、draft PR、独立体验服务；不合并、不部署。节点回报后继续执行，无真实阻塞无需等待再次授权。最后给可点击的原题体验地址，不转入生产发布讨论。
```
