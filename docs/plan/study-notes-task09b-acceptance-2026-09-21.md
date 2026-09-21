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
| A | M3 sealed 题纸打开侧栏 | ❌ 未执行 | ❌ |
| B | M5 题纸与笔记同时 dirty 时切题 | ❌ 未执行 | ❌ |
| C | M6/M7 切题纸与切笔记期间迟到回包隔离 | ❌ 未执行 | ❌ |
| D | M14 IME 组合输入期间的关闭与离页 | ❌ 未执行 | ❌ |
| E | M15 反向引用与返回定位 | ❌ 未执行 | ❌ |
| F | 回归：`vitest run tests/frontend` | ❌ 未执行 | ❌ |
| G | 回归：09A reference-loop / workspace E2E | ❌ 未执行 | ❌ |
| H | 回归：09B 侧栏 E2E | ❌ 未执行 | ❌ |
| I | `npm run verify:engineering`（BASE_REF=8f48761…） | ❌ 未执行 | ❌ |
| J | `npm run test:e2e`（默认 Playwright） | ❌ 未执行 | ❌ |
| K | `npm run verify:db` | ❌ 未执行 | ❌ |

---

## 3. 未覆盖 / 环境限制（持续更新）

- 待本轮完成后填写。

---

## 4. 实测证据（逐项追加）

（每项完成后追加：测试文件、实际命令、collected/passed/failed/skipped/retries、退出码、关键请求与数据库证据。）
