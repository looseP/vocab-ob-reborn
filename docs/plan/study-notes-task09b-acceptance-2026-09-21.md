# Task 09B 有限验收补批台账（2026-09-21）

> 性质：**补批验收台账**。范围限 Task 09B；不进入 Task 10 / N2 / 合并流程。
> 任务书：`docs/plan/study-notes-task09b-readiness-2026-09-21.md`
> 执行台账：`docs/plan/study-notes-task09b-execution-2026-09-21.md`
> 本台账只登记证据；**未完成项不预填通过**。

---

## 0. 基线核验（接管时，实测）

| 项 | 预期 | 实测 | 判定 |
| --- | --- | --- | --- |
| 分支 | `study-notes-n1-task09b` | `study-notes-n1-task09b` | ✅ 一致 |
| 本地 HEAD | `98810690` | `9881069309600dd680e5fb92c54a80082d3b7f58` | ✅ 一致 |
| 远端 `origin/study-notes-n1-task09b` | 同 HEAD | `9881069309600dd680e5fb92c54a80082d3b7f58` | ✅ 一致 |
| PR #131 head | `98810690` | `9881069309600dd680e5fb92c54a80082d3b7f58` | ✅ 一致 |
| PR #131 base | `task09a-unified` | `task09a-unified`；draft/OPEN | ✅ 一致 |
| 依赖 PR #130 | draft/OPEN，不 retarget | draft/OPEN，head `task09a-unified` | ✅ 未改动 |
| PR #129 | draft/OPEN，不关闭 | draft/OPEN | ✅ 未改动 |
| 工作区 | clean | `git status --short` 空 | ✅ |
| `git fsck` | exit 0 | 仅 dangling，无错误 | ✅ |
| 运行时 | Node 22.22.2 / npm 10.9.7 | `v22.22.2` / `10.9.7` | ✅ |

### 0.1 文档核对

| 文档 | 状态 |
| --- | --- |
| `docs/plan/study-notes-task09b-readiness-2026-09-21.md` | 存在（已在本批 Task 0 校准） |
| `docs/plan/study-notes-task09b-execution-2026-09-21.md` | 存在 |
| `docs/superpowers/plans/2026-09-21-task09b-paper-notes-implementation.md` | **存在但为未跟踪本地文件**（不在本分支 Git 树内，`git cat-file` 确认 HEAD 无此路径）。已读取用于对照，**不作为基线证据**。 |
| `AGENTS.md` | 仓库内**不存在**（全树搜索无命中）；以 `CONTEXT.md` 与 package scripts 为适用说明。 |

### 0.2 本轮隔离环境（实测）

| 项 | 值 |
| --- | --- |
| 验收库 | `vocab_study_notes_task09b_accept2`（5433 `vocab-local-pg`，本轮**新建**） |
| 迁移 | `npx tsx scripts/run-rls-acceptance-migrations.ts` → **exit 0**，40 journal entries |
| 角色 bootstrap | `prepare` → exit 0；`converge` → exit 0 |
| app 角色可见表 | 49 |
| 服务 | 端口 3098，`NODE_ENV=test SERVE_FRONTEND=true`；Node 22.22.2 |
| 上游库 | 仅使用上述隔离库；未接触任何真实用户库 |

---

## 1. 证据分类口径

| 类别 | 含义 |
| --- | --- |
| **本轮实测** | 本轮同一 SHA（`98810690` + 本轮后续提交）上亲自执行的命令与结果 |
| **复用历史** | 09B 前序批次已记录、本轮**未复跑**的证据（必须显式标注，不计入本轮通过） |
| **未执行** | 本轮范围内但尚未做的验收项 |
| **CI 未触发** | main-only 工作流在依赖分支上不会触发；属后续合并门禁 |
| **环境性失败** | 与产品行为无关的失败；必须单独复跑并记录复跑结果 |

---

## 2. 本轮补验清单（初始状态）

| 项 | 场景 | 初始状态 | 终态 |
| --- | --- | --- | --- |
| A | M3 sealed 题纸打开侧栏 | ❌ 未执行 | ✅ 真实栈通过 |
| B | M5 题纸与笔记同时 dirty 时切题 | ❌ 未执行 | ✅ 6 例（deferred）+ 变异鉴别 |
| C | M6/M7 切题纸与切笔记期间迟到回包隔离 | ❌ 未执行 | ✅ 4 例 + 变异鉴别 |
| D | M14 IME 组合输入期间的关闭与离页 | ❌ 未执行 | ✅ 4 例 + 变异鉴别（修 1 真实缺陷） |
| E | M15 反向引用与返回定位 | ❌ 未执行 | ✅ 真实栈通过 |
| F | 回归：`vitest run tests/frontend` | ❌ 未执行 | ✅ 724/724 |
| G | 回归：09A reference-loop / workspace E2E | ❌ 未执行 | ✅ 33/33 |
| H | 回归：09B 侧栏 E2E | ❌ 未执行 | ✅ 6/6 |
| I | `npm run verify:engineering`（BASE_REF=8f48761…） | ❌ 未执行 | ✅ exit 0（20 阶段） |
| J | `npm run test:e2e`（默认 Playwright） | ❌ 未执行 | ✅ exit 0（14 passed / 7 skipped） |
| K | `npm run verify:db` | ❌ 未执行 | ⚠️ 聚合入口非 0（环境/分工原因）；四个子门禁分别实测见 §4.4 |

---

## 3. 本轮修复的真实产品缺陷（验收暴露，非环境问题）

| # | 缺陷 | 影响 | 修复 | 鉴别 |
| --- | --- | --- | --- | --- |
| D1 | 卷面宿主合成屏障时，笔记侧被拒**原因**永远回落到通用文案 | IME/冲突/需修复的**不同恢复指引**在卷面离页提示里全部退化成同一句 | `useStudyNoteEditor` 增 `navigationError` 的 **ref 同步镜像** + `getNavigationError()`；编辑器挂到注册屏障上；适配层优先读同步 getter | 绕过同步 getter → IME 归因用例必红 |
| D2 | 侧栏在**无题型**上下文下列表**永不取数** | 列表查询契约要求 `venue` 必填；传 null → `buildQuery` 返回 null → `refresh()` 早退。表现为**空白面板**（无行、无空态） | `L3ExamPaper` 文件题型空间用该文件自身题型；`StudyNoteSidePanel` 兜底到 `L3_QUESTION_TYPES[0]` | 去掉兜底 → 3 例必红 |

> 两处均在**隔离副本上**做变异验证，验证后逐字节还原（`diff` 确认 identical），未提交变异。

---

## 3.1 未覆盖 / 环境限制

- **`npm run verify:db` 聚合入口**：其 `test:integration` 步骤在**单一固定 env** 下运行全部集成文件，
  但仓库内存在**按库分工**的用例（`l3-study-notes-repair.integration.test.ts` 自带库身份守卫，
  默认只接受 `vocab_study_notes_repair_accept`）。因此聚合运行必然在这些文件上失败——
  这是**用例设计使然**，不是回归。四个子门禁分别实测均通过（§4.4）。
- **`l2-drill-fr12.integration.test.ts`**：在共享 RLS 验收库上计数敏感（`expected N to be 1`）。
  已在**基线 SHA `8f48761`** 的临时工作树上复跑，**同样失败**（`expected 5 to be 1`）→ 判定为
  **既有状态累积问题，与本批无关**。复跑后已移除临时工作树。
- **main-only CI**：`Engineering Gate` / `Browser E2E` 等工作流在依赖分支上不触发；
  属后续合并门禁，本轮**未触发**，不得记为通过。
- 本轮未重跑 Writing E2E（改动不含作文接线）。

---


## 4. 实测证据（本轮同一 SHA）

### 4.1 提交序列

| SHA | 内容 |
| --- | --- |
| `652c69d` | 本台账骨架 + 接管核验 |
| `8d766db` | fix：M14 宿主屏障归因失真（缺陷 D1）+ 组合语义测试 4 例 |
| `1c0b102` | test：M5 双 dirty 切题时序 6 例（deferred） |
| `218c9bf` | fix：侧栏题型默认值为空导致列表永不取数（缺陷 D2）+ M6/M7 4 例 |
| `e6ea0e6` | test：M3 sealed 题纸 + M15 返回定位真实栈用例 |

### 4.2 单元 / 组件级（Node 22.22.2）

| 项 | 测试文件 | 命令 | 结果 |
| --- | --- | --- | --- |
| M14 | `tests/frontend/study-note-side-panel-ime.test.tsx` | `vitest run <file>` | 4 passed / 0 failed（exit 0） |
| M5 | `tests/frontend/study-note-paper-notes-m5.test.ts` | 同上 | 6 passed / 0 failed（exit 0） |
| M6/M7 | `tests/frontend/study-note-side-panel-late-response.test.tsx` | 同上 | 4 passed / 0 failed（exit 0） |
| 前端全量 | `tests/frontend`（55 文件） | `node_modules/vitest/vitest.mjs run tests/frontend` | **55 files / 724 tests passed**，0 failed（exit 0） |

计数说明：本批起点为 710 passed；`+4`(M14) `+6`(M5) `+4`(M6/M7) = **724**。

### 4.3 真实栈 E2E（真实浏览器 + 真实 HTTP + 隔离 PG）

隔离库：`vocab_study_notes_task09b_accept2`（5433；迁移 40 journal entries；角色 prepare/converge exit 0；
app 角色可见 49 表）。服务端口 3098，`NODE_ENV=test SERVE_FRONTEND=true`。

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 09B 侧栏 | `@playwright/test/cli.js test --config=playwright.study-notes.config.ts study-notes-sheet-side-panel.spec.ts` | **6 passed**（M1/M2、M8/M9、M4、M10、**M3**、**M15**），0 failed（exit 0） |
| 09A/08 回归 | 同上，`study-notes-reference-loop` + `workspace` + `ref-picker-close` + `task08-fix-regression` | **33 passed**，0 failed（exit 0） |
| 默认 Browser E2E | `npm run test:e2e`（`--list` 实测 collect **21 tests in 5 files**） | **14 passed / 7 skipped**，0 failed（exit 0） |

**M3 关键实测纠正**：定格后用 `?paper=` 重开会**新建一份草稿**（`openSheet` 幂等范围仅限
`status='draft'`），并非「打开已定格题纸」；正确入口是只读回看深链 `?sheet=<id>`（F-1 合同：
不调 openSheet、不新建草稿）。另：seal 的 CAS 锚点是 `draft_version`（误用 `version` 得 400）。

**M3 断言**：只读态「已定格」可见且「定格题纸」入口计数 0；侧栏打开后列表/空态可见；
窗口内**零**题纸 POST/PUT/PATCH/DELETE；题纸数、作答数、笔记数三者不变。

**M15 断言**：入口 `data-question-id` 为真实 UUID（非纸张/attempt/展示序号）；
`?paper&question=` 返回后 `#question-<id>` 到位；题纸数与作答数不变（零创建草稿）。

### 4.4 工程门禁

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 完整工程门禁 | `COVERAGE_BASE_REF=API_CONTRACT_BASE_REF=ROUTE_COMPLEXITY_BASE_REF=8f48761… npm run verify:engineering` | **exit 0**，20 阶段全跑；unit **261 files / 3890 passed / 6 skipped** |
| 默认 Browser E2E | `npm run test:e2e` | **exit 0**（14 passed / 7 skipped） |
| DB 发布校验 | `npm run test:db-release` | **exit 0**（Release database verification passed） |
| DB 角色校验 | `npm run test:db-roles`（需全角色 URL） | **exit 0**，全部不变量 `true` |
| 容量校验 | `npm run test:capacity`（需 `_capacity` 库名 + `CAPACITY_TEST_CONFIRM`） | **exit 0**（4 workers / 865 events/s / 0 duplicates） |
| RLS 验收链 | `npm run rls:acceptance:verify` | **exit 0** |
| study-notes 集成 | `repair` + `l3-study-notes` 用其**文档指定库** | **49 passed**（含 repair 15） |

`verify:db` 的 `test:integration` **聚合步骤**在本仓库无法恒为 0（见 §3.1 的分工守卫），
故按子门禁分别实测并如实登记，**不把分段通过冒充聚合通过**。

### 4.5 环境性失败与复跑

| 失败 | 初次现象 | 根因 | 复跑结果 |
| --- | --- | --- | --- |
| `test:e2e` | `password authentication failed for user "vocab"` | 默认配置指向 5432 未发布端口 | 指向隔离库后 **exit 0**（14/7） |
| `test:integration` | `permission denied for function word_similarity` | `TEST_DATABASE_URL` 用了 `vocab_migration`（无该函数 EXECUTE；授权只给 `vocab_app`） | 改用文档指定的 admin/角色组合后 139/141 |
| `test:integration`（余 2 例） | `expected 0 to be greater than 0` / `expected 3 to be 1` | repair 用例自带**库身份守卫**；l2-drill 计数敏感于共享库状态 | repair 用其指定库 **15/15**；l2-drill 在**基线 SHA 同样失败**（`5 to be 1`）→ 判定既有问题 |
| `test:db-roles` / `test:capacity` | 缺 `DATABASE_ADMIN_URL` / 库名守卫拒绝 | 需显式环境变量与合规库名 | 补齐后均 **exit 0** |

---

## 5. 推送阻塞（如实登记，2026-09-21）

本轮全部验收与门禁完成后，**普通推送失败**：本机 Git 配置的代理
`http://127.0.0.1:17891` 已停止监听（`netstat` 无该端口；`--noproxy '*'` 直连亦不可达），
`git push` 报 `Failed to connect to github.com port 443 via 127.0.0.1`。

- 已连续重试 5 次（间隔数秒），均同一错误 → 判定为**环境性网络阻塞**，非仓库问题。
- 影响：远端 `origin/study-notes-n1-task09b` 仍停在 `98810690`；
  本批 5 个提交（`652c69d`→`d48e930`）**已全部本地提交、工作区 clean、fsck 无错误**，
  未丢失。
- 恢复网络后需执行：`git push origin study-notes-n1-task09b`（普通推送，不强推），
  随后更新 PR #131 描述。
- **未执行**：推送、PR #131 描述更新、远端/PR head 一致性核对（因网络阻塞）。
