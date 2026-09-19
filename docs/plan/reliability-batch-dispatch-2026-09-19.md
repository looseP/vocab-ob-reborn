# 有限可靠性修复批次 Implementation Plan

> For agentic workers: 使用 executing-plans 按任务执行；用户已授权派发并实施本批次，无需再次询问是否开始。任务由一个执行者统筹，涉及同一文件的步骤顺序完成。

**Goal:** 修复作文网络恢复误确认、普通题纸保存/定格/导出屏障，以及旧主观题输入入口误导，交付可审查的实现与真实验证证据。

**Architecture:** 保留现有 HTTP→service→repository→PostgreSQL 分层。作文仍用专用 text/version 保存协议；普通题纸保留逐题答案语义，完善单在途与服务端并发保护；旧主观题使用明确的受支持入口，不新增翻译工作台。只做必要的局部抽取。

**Tech Stack:** TypeScript ESM / React / Hono / Drizzle / PostgreSQL / Vitest / Playwright。Node 22.22.2，npm 10.9.7。

## Global Constraints

- 派发基线：`ccc6fb4c90f45c6e13f0d581298bb617a79baac2`，本地主线已含 #121 与 #122。开工重新记录实际 HEAD，不用过时报告推断状态。
- 真正 Git 包根：`D:/Temp/Myawesomeapp/vocab-ob'/wt-main`。外层项目目录不是 Git 仓库。
- 从已合并基线创建独立 worktree；可在外层工作区内新建目录。不要切换、清理或覆盖 wt-main、wt-writing、wt-practice；不带入他人未提交改动。本任务书可单独复制入新 worktree。
- 本轮不开发学习笔记、分页、备份调度、统一复盘、完整翻译工作台，不顺带重构全站；注记评审的跨题绑定/确认竞态另列后续任务。
- 禁止修改真实 dev 业务数据作测试。真库测试只在隔离验收库/专属随机 owner 上进行；不 truncate 业务表。
- 不新增库依赖，不新增离线存储或全局调度器。保持 L3 与 FSRS 隔离、owner/agent 权限、F-1 只读回看及 writing 专用端点守卫。
- 用户批准的是修复交付。执行到针对性与所需工程验证、提交、可审查结果；有可用远端时可以创建 draft PR 并附着任务。合并与部署不在本次范围。
- 使用 TDD 与 systematic-debugging：先失败复现，再最小修复。缺少环境时准确记录阻塞，不把 skip/未执行写成通过。

## 参考证据

开工读取以下已存在文件（仓外路径在任何 worktree 均可直接读取）：

- `D:/Temp/Myawesomeapp/vocab-ob'/build-analysis/status-2026-09-19/项目深度分析与后续行动指导.md`
- 同目录 `save-audit-probe.mjs` 和 `save-audit-probe-results.json`。探针只注入网络/timer，不是真库或浏览器证据。
- 包内 `docs/plan/writing-space-design-2026-09-18.md`、`writing-space-acceptance-report-2026-09-18.md`。
- 包内 `docs/plan/l3-upgrade-task-breakdown-2026-09-11.md` §0、相关 ADR 和当前 AGENTS.md（若存在）。

## Task 0：独立基线与证据台账

**Files:** Create `docs/plan/reliability-batch-execution-2026-09-19.md`。

- [ ] 在包根检查 status、HEAD、worktree list、Node/npm。现有 wt-main 的 README、三份 study-notes 计划与临时 scripts 不属于本任务。
- [ ] 创建独立 checkout，记录实际 base SHA 和运行时路径。Node 可使用 `D:/Temp/Myawesomeapp/vocab-ob'/tools/node-v22.22.2-win-x64/node.exe`。
- [ ] 基于实际 base 设置 COVERAGE_BASE_REF / API_CONTRACT_BASE_REF / ROUTE_COMPLEXITY_BASE_REF；不能设成 HEAD 绕过差异门禁。
- [ ] 先跑现有相关测试确认环境；逐条记录原失败、修复后结果、未覆盖项。复制任务书只复制本文件，不批量复制 main 未提交文件。

## Task A：作文恢复确认绑定请求序号

**Files:** Modify `src/frontend/state/writingSaveController.ts`；Test `tests/frontend/writing-save-controller.test.ts`；按需扩展 `tests/frontend/writing-workspace.test.tsx` 与 `e2e/writing.spec.ts`。

**合同:** `createWritingSaveController` 现有公开 API 保持；`flush()` 仅在调用时输入序号已确认后返回与确认正文/版本相匹配的 receipt。

已复现：重试耗尽后 load 返回已落库 A/version 2；此时本地已是 B。reconcile 把 committedSeq 设为当前 inputSeq，外层 success 后 break，最终 local=B/server=A/state=clean。计时器触发也不补发 B。

- [ ] 用 deferred Promise 与注入 timer 写失败回归：前三次失败，第四次 A 在途期间 setText(B)，第四次丢响应，load 回 A/version 2；第二个 flush 必须等待 B 确认，不得返回 A。不能只测最终 text，须核对 save 请求、receipt、version 与 state。
- [ ] 增加无新输入恢复 A 的成功场景、恢复读取期间输入 B、未落库纯网络失败与409保留本地内容场景。
- [ ] 修复时把确认序号绑定到 sentSeq；恢复成功后如有新输入继续串行发送，满足对应 flush waiter。不能简单将所有 waiter resolve，不能盲采服务端新版覆盖本地。

```text
收到 A 的正常响应或恢复确认 → 只确认 sentSeq(A)
inputSeq > committedSeq → 继续发送最新输入
waiter.targetSeq <= committedSeq → 才能返回已确认正文及版本
```

- [ ] 跑保存器和作文组件目标测试，再将该交错加入真实浏览器故障验收。验证保存/提交/导出以及离开提示的状态诚实。
- [ ] 独立提交：`fix(writing): preserve newer edits after save reconciliation`。

## Task B：普通题纸的保存、定格与导出

**Files:** Modify `src/frontend/components/l3/L3ExamPaper.tsx`、`src/services/l3-sheets.service.ts`、`src/repositories/l3-sheets.repository.ts`；按需新增独立题纸保存 controller，并维护其客户端、domain、repo interface、HTTP 输入/输出契约。Test `tests/frontend/exam-sheet-integration.test.tsx`、`tests/services/l3-sheets.test.ts`、`tests/repositories/l3-sheets.test.ts`；Create `tests/l3-sheet-reliability.integration.test.ts` 与相应浏览器验收。

**合同:** flush 必须等待在途及调用前输入完成；失败 reject；定格和草稿导出均经过该屏障。不能把 writing text controller 原样套在题目键 merge 上。

- [ ] 先补两个失败测试：PATCH reject 后 seal 未调用；已有 PATCH 在途时二次 flush 未 resolve。补快速 A→B、延迟旧响应、定格/导出期间 pending 未丢失。
- [ ] 以单在途队列与输入序号控制写入；旧响应只确认其请求，不覆盖更新本地答案。实现明确重试与未保存状态，文案必须对应实际行为。
- [ ] 定格前冻结本次提交对象/编辑窗口，等待确认回执；复制/下载草稿先等待确认。保存失败时禁止后续动作并保留本地答案；离页未确认状态要可见且可恢复操作。
- [ ] 真 PG 两连接复现：seal 读取 A 后阻塞，PATCH 写 B，再释放 seal，核对不能成功固化旧 A 并清掉 B。先记录当前失败，再决定最小行锁/版本约束。
- [ ] 服务端定格读取、验证与物化使用同一受保护版本。双标签页同题写冲突必须有明确语义，不能声称前端串行解决多设备覆盖；评估复用已有 draft_version 作 CAS。若扩展合同，更新所有消费者及 HTTP/OpenAPI 测试，不能绕过 breaking gate 或扩大到无关端点。
- [ ] 回归未答软确认、full/incremental/summary、flags/marks、F-1 指定纸回看零创建、writing 拒绝通用 PATCH/seal。
- [ ] 真浏览器覆盖作答→保存→定格→离开→同 sheet 回看→刷新评卷，并核对实际数据库答案与零多建纸；故障场景核对最后输入。只用隔离 fixture。
- [ ] 按前端保存与后端并发约束拆清晰提交，合并测试后才标完成。

## Task C：旧主观题入口诚实化

**Files:** Modify `src/frontend/components/l3/L3ExamPaper.tsx` 的 WrittenQuestion 与调用；按需复用既有作文入口/导航 helper；Test `tests/frontend/exam-sheet-integration.test.tsx`、`tests/frontend/writing-workspace.test.tsx`，浏览器覆盖题库到作文空间。

**合同:** 旧卷面不再出现暗示可保存、实际上没有持久化链的可编辑输入。保留参考答案显式揭示、题目/解析/已清理状态和定格后只读纪律。

- [ ] 先写失败测试：short_essay/long_essay 在旧卷面存在明确作文空间入口，携带当前题目；不存在未绑定保存的作文 textarea。
- [ ] 作文入口复用当前已实现的 questionId 创建/复用任务协议，由用户点击才进入/创建。查看历史或 F5 不得自动建任务/题纸。不丢题面，也不跨 owner。
- [ ] 翻译本批次仅做诚实降级：移除/禁用未保存输入并明确“当前支持查看题目与参考译文，译文作答保存暂未开放”。不开发新的 text 答案协议，不假装普通题纸已支持全文翻译作答。
- [ ] 若页面已存在其他真实保存的主观题入口，先验证后复用；不要并存两个含糊按钮。恢复与历史页面不显示误导性的空编辑框。
- [ ] 浏览器实际从现有作文题进入作文空间，核对题面继承和保存后重开；不只验自由写作入口。
- [ ] 独立提交：`fix(l3): route subjective input through supported workflows`。

## Task D：批次验收与交付

- [ ] 重跑新失败回归与现有 6 个目标文件：exam-sheet-integration、l3-grading-display、writing-save-controller、l3-sheets service、l3-grading service、l3-sheet-archive HTTP。此前 114/114 是旧基线，不作为本批次结果。
- [ ] 串行运行相关 typecheck、arch、前端构建、必要 API governance；完成仓库要求的全量单测/分层门禁和变更所需真库验证。资源不足则保留失败证据并交给可用 CI，不用调整阈值/skip 掩盖。
- [ ] 将浏览器场景并入现有 CI 或专用收集校验，检查 fail-closed 用例数；若修改 writing spec 的 top-level 数量，更新 validator 预期和其测试。不要留下默认跳过却显示全绿的验收。
- [ ] 台账逐项写：代码提交、命令/退出码、真库/浏览器结果、截图/trace、未验证项。新增问题超出本批次则记录，不扩张施工。
- [ ] 最终交付每项修复前后行为、回归证据、变更文件、剩余风险，以及 draft PR（若远端可用）。不合并、不部署。

## 批次完成判断

三类用户行为均可验证：①作文输入的新版本不会被旧请求误确认；②普通题纸只有已确认答案才能定格/导出，服务端交错不固化旧值；③旧主观题入口明确可用与未开放范围。必须分别列“已实现/已测试/环境阻塞”，不得只以测试总数宣布全部问题消失。
