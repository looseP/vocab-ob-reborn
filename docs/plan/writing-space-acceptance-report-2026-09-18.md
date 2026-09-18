# 作文子空间 v1 · 真实验收报告（2026-09-18）

> 状态：**待验收（draft PR）**。本地门禁与真环境矩阵已完成；CI 首跑待 push 后由 Actions 复验。
> 基座：`main @ f03ffe35`（PR 唯一基座；study-notes 线未合入 → 无迁移序号/schema 冲突待解）。
> 分支：`feat/writing-space-v1`（本地 `writing-v1`）。

## 1 · 提交链（base → head）

`f03ffe35`(base) ← `2b754a1`(计划文档) ← `44ab3f3`(ADR/baseline/log) ← `da1317c`(W1 迁移 **0038** + domain/DTO + RLS) ← `3d759e1`(W4 保存控制器) ← `ba26a82`(W2 任务生命周期) ← `09a44f0`(W3 稿件生命周期) ← `d7a26ff`(W5 反馈) ← `08d9c44`(W5 收口) ← `b0bee63`(W5 自查) ← `3396150`(W6 HTTP/授权) ← `371355e`(回填) ← `02eb1aa`(W9 导出/清理) ← `2063461`(W8 反馈/对照) ← `ba2c082`(W7 页面) ← `9a9e4df`(e2e 冒烟) ← `333eead`(日志) ← `1b68af8`(提交屏障) ← `f45c8de`(输入可见性 P0) ← `f55e40b`(冲突文案) ← `4d14ebf`(e2e 矩阵) ← `9e48325`(外审修复) ← `5d5ea04`(CI workflow) ← `6cde7a6`(shell 守卫) ← `61ad3d3`(覆盖补强) ← `802318e`(报告) ← `3304e92`(CI 修复) ← `《docs 提交（本报告回填）》`

## 2 · 用户使用路径与本版范围

- **写作**：`/l3?section=writing`（或主页「作文」卡 / 试卷台 essay 题「在作文空间练习」）→ 开始整篇/段落/自由写作（≤2 次主要点击，光标入正文）或从已有作文题继承题面 → 自动保存（800ms 防抖 / 单请求在途 / 1-2-4s 退避 / IME 合成不落半截）。
- **提交**：锁定编辑 → `flush()` 回执（已确认正文+版本）→ GET **仅核对**（同文同版才放行；不符/409 → 冲突提示，本地正文保留，**绝不**盲采最新版、不自动重试）→ CAS 提交；重复提交幂等（同 attemptId/稿号）。
- **评阅**：agent 经专用入口只读**指定已提交稿** context、写该稿 feedback（绑定 sheetId+正文 SHA256、UTF-16 锚点逐字校验；64KiB 解析前双闸）；owner 手动刷新见反馈，可「跳至原句」定位。
- **第二稿/对照/历史**：默认复制父稿；两稿正文/反馈互不借用；稿次列表（反馈状态派生）+ 清理（正文+反馈同事务，幂等）；URL 深链 `?section=writing&writingTaskId&sheet`、F5 同稿零新增、关闭重开同稿。
- **导出**：单稿 Markdown（独立 schemaVersion=1；JSON 可提取；反引号动态围栏；hash 按「去校验行重算」规则可复算；文件名 `writing-<sheetId>.md`）；**先 flush，失败不导出**。
- **明确非目标**：数字评分、计时模拟、自动 agent 守护、代写、素材推荐、全站搜索、音视频、离线队列。

## 3 · 迁移与消费者兼容

- **唯一新迁移：`0038_empty_blink.sql`**（journal 顺序追加；0037 未动、既有迁移零改写）。内容：`l3_writing_tasks` / `l3_writing_feedback` 两表 + `l3_submissions` 四列（`writing_task_id`/`parent_sheet_id`/`revision_no`/`draft_version`）+ 双 RESTRICT 复合 FK + 三 CHECK 改写 + `l3_question_attempts.venue` 扩 `writing` + `(sheet_id) WHERE venue='writing'` 部分唯一 + RLS 两表策略。
- **旧数据零影响**：file/paper 全量回归绿（含 F-1 档案/导出/刷新评卷）。
- **消费者升级点（设计预期，非放水）**：sheet `scope`/`venue` 枚举扩 `writing` —— 通用 sheet/grading/export 面**不得消费 writing**（patch/seal/discard/deleteAttempt/grading 已封堵；**导出面守卫本轮补齐** `9e48325`）。breaking approval 按 ADR-0035 勘误口径在**真实变更时**重锚（base=f03ffe3/current/issues 实测，两次重锚均对应真实 API 面变化）。
- **部署前必做（角色链）**：`bootstrap-database-roles.ts converge`（新表 `vocab_app` 四权 + verifier `exactPrivileges`）。

## 4 · 门禁结果（本地绑定代码冻结提交 `61ad3d3`；push 后 CI 在最终 HEAD 复验）

| 门禁 | 命令（关键 env） | exit | 证据 |
|---|---|---|---|
| 全量单测 + 分层覆盖 | `COVERAGE_BASE_REF=f03ffe3` 全套件（沙箱内覆盖产物以 `--exclude "**/run-alerting-drill.test.ts"` 生成，见 §8） | 0 | **3188 passed / 6 skipped**；**Diff 92.62%（1518/1639）PASS**；层表 domain 98/97.6、service 95.21/92.87、**repository 92.85/91.17**、http 91.2/88.26 全 PASS；Baseline ratchet PASS；收集 228/228 |
| typecheck | `npm run typecheck` | 0 | 0 error |
| 架构 | `npm run arch:check` | 0 | 388 模块 / 1670 依赖 无违规 |
| API governance | `API_CONTRACT_BASE_REF=f03ffe3 npm run api:governance` | 0 | openapi 再生一致 / client:check / 契约 10+31 passed / breaking「未发现」/ 复杂度棘轮 passed |
| schema drift | `db:schema:drift`（dev + `vocab_writing_test`） | 0 | OK ×2（search vector + owner RLS policies + SECURITY DEFINER 一致） |
| 前端构建 | `npm run frontend:build` | 0 | dist 重建（21:12:49），SPA 由 API 进程实载 |
| **Writing E2E（真栈）** | `E2E_WRITING_SMOKE=1 npx playwright test e2e/writing.spec.ts` | 0 | **4/4 passed（36.2s）**：主旅程 / 故障与并发 / 分页与生命周期 / 清理不泄漏 |
| RLS 与并发集成（真 PG 两连接） | `vitest.integration.config.ts`：writing-rls + writing-concurrency + writing-cleanup | 0 | **22/22**（10 + 10 + 2，含提交屏障交错与清理×反馈双向屏障） |
| F-1/旧面回归 | 全套件含全部 F-1 用例（l3-sheet-archive / l3-sheet / l3-sheet-export 等） | 0 | 计入 3188 passed，0 失败 |

## 5 · writing E2E 实际执行证据

- 4 用例：①主旅程（开始→保存→提交→agent 真实 HTTP 评阅→刷新反馈→定位→第二稿→对照→关闭→重开→F5 库核零新增→真实导出下载）②故障与并发（退避恢复/失败阻止提交与导出/延迟不丢输入/IME 不存半截/双标签页不覆盖，均含库核）③分页与生命周期（25 任务 20+5、25 稿次 1..25、搜索、归档恢复、题面继承）④清理不泄漏（占位可见、正文/评语/quote 全页不泄漏、导出拒绝、库核双零）。
- 本地最终跑：**4/4 passed（36.2s）**，栈 = `SERVE_FRONTEND` 单进程 + 最终 dist + 独立验收库。
- 截图 12 张（仓外 `D:/tmp/ws7-acceptance/`）：01–06 桌面 1440×900 / 07–08 手机 390×844 / 09 暗色 / 10 失败阻止提交与导出 / 11 双标签冲突 / 12 清理占位无泄漏。
- CI：`.github/workflows/writing-e2e.yml` fail-closed（JSON reporter → collected=4 / skipped=0 / failed=0 才算绿，输出计数行；validator 已用 mock 三用例本地自证：过→0、skip→1、少收集→1）。
- **CI 实跑记录**：首跑（`802318e`）因 workflow 手动预占 3099 与 config webServer（CI 下 `reuseExistingServer=false`）冲突 → `collected=0`，**validator 按设计拦截「空跑绿」**并打印 `report.errors`；修复 `3304e92`（webServer 自起 + `AGENT_API_TOKENS` 白名单透传 + env 形状对齐本地语义，本地 `CI=true` 仿真 4/4 预演）。**终跑（`3304e92`）全绿**：`collected=4 executed=4 skipped=0 failed=0 passed=4 (pw_exit=0)`（1m46s）。

## 6 · 独立审查结论与修复

- 审查者：外派只读（未参与实现；前 4 次因配额 429 失败，第 5 次完成）。
- 结论：**通过为主**；处置 3 项（测试断言缺陷修正 / 通用导出补 409 守卫 / deleteAttempt 误报核实并补锁定测试），修复提交 `9e48325`。

## 7 · 证据位置

- 截图：`D:/tmp/ws7-acceptance/`（01–06 桌面 1440×900、07–08 手机 390×844、09 暗色、10 失败阻止提交与导出、11 双标签冲突、12 清理占位无泄漏）——仓外，不随 PR。
- trace/失败产物：`test-results/`（CI 由 workflow 上传 artifact）。
- DB 双证：e2e 用例内 admin 直查（零新增/attempt/feedback 计数）+ 集成测试（`vocab_writing_test`，两连接屏障）。

## 8 · 未验证项与已知限制（如实）

- ✅ **CI 已全绿（最终 HEAD `3304e92`）**：Writing E2E `passed=4`（fail-closed 计数行）/ Browser E2E ✓ / Engineering Gate + Migration Rehearsal ✓。
- 分支保护尚未把 Writing E2E 列为必需检查（需仓库设置；命令见 §10）。
- 真 PG 集成测试在本地跑于 `vocab_writing_test`；CI 使用临时 service 容器复建。
- `题库进入`（questionId 路径）在浏览器层未覆盖（服务层全测；UI 按钮已实现）——浏览器断言以 `prompt` 路径（段落/自由写作）覆盖。
- 其余既有 E2E（auth/phase5c）不在本轮改动面，交由 CI Browser E2E 继续看护。
- **沙箱环境性障碍（非本线产物，CI 清洁跑不受影响，已如实记录）**：
  - `tests/scripts/run-alerting-drill.test.ts` 在 WorkBuddy 沙箱内因 safe-delete shim 拦截其锁文件删除而**间歇失败**（本轮既有「全过（3186 passed）」观测、也有「9 例失败」观测；失败均为 shim 报错而非断言失败）。**分层覆盖产物以排除该文件的干净跑生成**（3205→3188 passed 差额即该文件）；CI 的 `npm run test:unit` 在 GitHub runner（无此 shim）执行全套件，即权威口径。
  - vitest 启动清 `coverage`/`coverage/.tmp`、vite 清 `dist/frontend/assets`、drift 脚本清临时配置文件——均被 shim 的批量删除护栏拦截；处置=「挪移代替删除」或重试窗口通过（未绕过任何安全护栏）；重试后 drift/vite 均 exit 0。

## 9 · 部署前必须完成的事项

1. `converge` 角色链 + verifier（新表授权）。
2. 分支保护添加 **Writing E2E** 为必需检查（否则仅普通 red/green）。
3. CI 首次绿跑确认后，将本 PR 从 draft 转正并合并（授权后）。
4. 生产/预发环境按迁移 0038 + 角色 converge 顺序发布（0038 幂等，可重放）。

## 10 · 附：分支保护命令（待用户/管理员执行）

```bash
gh api -X POST repos/<owner>/<repo>/branches/main/protection/required_status_checks/contexts \
  -f "contexts[]=Writing E2E / Writing E2E（真环境闭环 + 故障矩阵）"
```
（或经 GitHub UI → Settings → Branches → main → Require status checks 勾选。）
