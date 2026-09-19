# L3 题纸可靠性 × 作文专项工作区 · 整合验收报告（2026-09-19）

> 任务：从 `reliability-batch@b96b972` 创建独立整合工作树与分支 `integration/l3-reliability-writing`，
> 以普通 merge 合入 `writing-practice-v1@b11f3ee`，解决冲突，完成 Task C（旧主观题入口诚实化），并做联合验收。
> 基线：`main@ccc6fb4`。本报告为批次证据台账，结论以 PR #125 的 CI 三项必需检查为最终门。

## 1. 交付对象

- **独立工作树**：`D:/Temp/Myawesomeapp/vocab-ob'/wt-integration`（新建；`main` / `wt-writing` / `wt-practice` 全程未切换、未修改）。
- **分支**：`integration/l3-reliability-writing`
- **提交链**：
  - `b96b972`（reliability-batch head，起点）
  - `fc5766f` — `Merge branch 'writing-practice-v1' into integration/l3-reliability-writing`（含冲突解决与整合修补）
  - `92854da` — `fix(l3): route subjective input through supported workflows`（Task C）
- **远端**：PR **#125（draft）** https://github.com/looseP/vocab-ob-reborn/pull/125
- **未合并、未部署、未推送 main**。

### 环境注记（本沙箱两条非标准行为，已有恢复防线）

1. **嵌套分支 ref 不持久**：`refs/heads/integration/…` 的写入（git 命令与直写均在 commit 后丢失）；已用 loose 直写 + `.git/packed-refs` 双级维护，SHA 与恢复命令登记于 `D:/tmp/integration-recovery-notes.md`。
2. **本机 Playwright runner 收尾间歇挂死**：三种完整姿势（自起 webServer / 预启复用 / 不同时间）中出现 "worker-0 process did not exit within 300000ms"——**全部用例执行完成且全绿**后仅卡在 worker 退出（rel 批次先例同款、环境性）。用例层证据不受影响；最终门以 CI 为准（见 §7）。

## 2. 冲突解决记录

### 2.1 唯一内容冲突：`src/frontend/components/l3/L3ExamPaper.tsx`

两个交错冲突区，均为"两侧各插入代码"形态，非语义互斥：

- **区一（动作锁/作文块交错边界）**：保留 reliability 的 `acquireActionLock/releaseActionLock`（F2）完整闭合；并入 practice 的作文入口块（题组批量摘要 effect、`?question=` 滚动定位、`makeWritingOrigin`）；**删除 practice 侧遗留的防抖 PATCH 老协议设施**（`pendingAnswers/flushTimer/flushInFlight/老 flushAnswers/ensureAnswersSaved`）。
- **区二（作文题渲染块）**：保留 practice 的结构（`data-question-id` 定位包层 + `WritingQuestionEntry` 入口 + `beforeAction` 屏障），锁语义取 reliability 的 `interactionLocked`（= `readOnly || actionLocked`）。
- **jumpBarrier 适配新协议**：原 practice 版基于老协议判 boolean；整合后经单在途控制器 `flush()`（覆盖在途+等待期新输入），并**新增粘性 error 显式 `retry()` 排出**——否则控制器 error 后 `flush` 立即拒绝，"重试进入写作"将永远无法通过（真实整合缺陷，已修）。
- **作文保存协议未退化**：writing text/version 专用协议（writingSaveController + task/sheet/origin/resume）原样保留（原则 3）。

### 2.2 自动合并复核（双向往返 diff + 生成物重生成）

| 文件 | 复核结论 |
|---|---|
| `writingSaveController.ts` | rel 的 Task A/settled-snapshot 修复 + practice 的 `isDisposed()` 增量并集 ✓ |
| `interfaces.ts` / `schemas/http` / `schemas/service` | rel（expectedDraftVersion CAS / expectedVersion 导出）与 practice（sourceId+fileKey 精确过滤 / question-summaries）双向增量均在 ✓ |
| `docs/api/openapi.json` / `generated/openapi.ts` | `api:openapi` 重生成后**零 diff**（与源码同步） ✓ |
| `docs/api/openapi-breaking-approval.json` | `currentSha256` 重锚至整合快照（base=ccc6fb4c 不变；2 条 required-field issues 与实测集合一致）；走全量校验路径（approval 相对 base 有变更）✓ |
| `e2e/writing.spec.ts` / `verify-writing-e2e-report.ts` / `writing-e2e.yml` | 文案改动 + 收集数 4→7（4 writing + 3 origin）与 spec 实际顶层数一致（`grep ^test` = 4 + 3）✓ |
| `l3-papers.test.tsx` 两例保存屏障测试 | 适配新协议自动重试语义：失败注入由无 status 错误改 **422 不可重试**（固定失败路径）✓ |

## 3. Task C · 旧主观题入口诚实化

### 3.1 实现

- `WrittenQuestion` **移除无持久化链的可编辑输入**（旧 textarea 的输入无处保存）：
  - essay（short/long）：作答经下方「专项练习（不计入本次试卷作答）」**作文空间入口**（`WritingQuestionEntry`，沿用 task/sheet/origin 协议）；
  - translation：**诚实降级**——明示「当前支持查看题目与参考译文；译文作答保存暂未开放」，不假装支持全文翻译作答；
  - 保留：题面、参考答案显式揭示、已清理状态、定格后只读纪律（客观题锁定、揭示纪律不变）。
- 入口协议保持：**点击前零创建**（开始写作才 `createTask`）；返回/F5/历史查看**不重复建纸**（resumeSheet 按 ID 恢复 + 摘要只读）；origin 携带 `questionId`/来源/返回位置。

### 3.2 测试（先红后绿 + 变异证明）

| 层 | 用例 | 先红证据 | 后绿 |
|---|---|---|---|
| 组件 | `exam-sheet-integration` 新增 3 例：作文题零输入框 / 翻译降级+揭示 / sealed 零输入框 | 实现前 3×`×`（textarea 存在） | 56/56（与 l3-papers 合并跑） |
| 组件 | `l3-papers` 4 处旧断言适配（resume draft/sealed、StrictMode ×2 → 无输入框 + 入口状态） | 实现后即红（4 failed）→ 适配 | 全绿 |
| HTTP | `l3-writing` 新增：question-summaries 只读零创建 | **变异**：注入 `create()` 调用 → 该用例红 | 撤销变异 → 20/20 |
| 浏览器 | `writing-origin` C 场景：整卷卷面无旧输入框 | **变异**：`git show HEAD:` 还原旧卷面 + rebuild → `Expected 0, Received 1` 红（error-context/trace/video 留档） | 恢复 + rebuild → 单场景绿；完整 7 用例 3 轮全绿 |

## 4. 测试命令与退出码（本地实测）

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `npm run typecheck` / `tsc -p e2e/tsconfig.json` | 0 / 0 | — |
| 2 | `npm run arch:check` | 0 | 391 模块 0 违规 |
| 3 | `npm run frontend:build` | 0 | 多次重跑（含 Task C 后重建） |
| 4 | `npx vitest run tests/frontend` | 0 | **36 文件 435/435** |
| 5 | 后端关键组（sheets+writing 13 文件：domain/repo/service/http/scripts） | 0 | **299/299** |
| 6 | `npm run api:governance`（base=ccc6fb4c） | 0 | openapi→client→contract(10)→breaking→breaking-contract(31)→complexity 全绿 |
| 7 | `npx playwright test e2e/writing-origin.spec.ts`（3105 + 隔离库） | 0 | 3/3（首轮含新断言） |
| 8 | `npx playwright test writing.spec + writing-origin.spec` + validator | 0（首轮） | 首轮 `collected=7 executed=7 skipped=0 failed=0 passed=7 (pw_exit=0)`，validator exit 0；后两轮 7/7 用例全绿但 worker 退出挂死（json 未落） |
| 9 | `npx playwright test e2e/l3-sheet-reliability.spec.ts` | 0 | **5/5**（含双标签冲突/导出屏障/故障阻断） |
| 10 | 变异轮（Task C 单场景 / HTTP / 组件） | 红→绿 | 见 §3.2 |

## 5. 真实库证据

- **隔离验收库**：`vocab_integration_accept`（docker `vocab-local-pg` :5433；由空模板 `vocab_e2e_origin` 克隆——39 迁移、0 卷/0 任务；owner=vocab_migration；app 角色连通验证）。
- **真实数据未触碰**：未动 `vocab_practice_accept`（36 卷/3 任务）、3099/`vocab_writing_test`、`vocab`、3001 live；未执行任何迁移到业务库；未 truncate 任何业务表。
- **库核断言（e2e 内）**：原题闭环"仅显式开始 +task/+sheet；返回/继续/F5 零新增"；整卷"保存屏障先行落库、resumeSheet 同纸、零新增零判定泄漏"；题纸"定格物化、题纸清空、零多建纸、双标签 409 不写入"。

## 6. 浏览器证据清单

- 截图：`D:/tmp/integration-e2e-final/`（writing 主旅程 01-05、故障矩阵 10-13、origin 01-06）、失败留档 `wt-integration/test-results/...C｜整卷...`（含 `test-failed-1.png` / `trace.zip` / `video.webm`，即变异红）。
- 服务日志：`D:/tmp/integration-server-3105.log`（真实 HTTP 200/201/409 序列）。
- 轮次汇总：writing-origin 3/3（×4 轮含首轮）、writing 7/7（×3 轮）、l3-sheet-reliability 5/5（×1，正常收尾）。

## 7. CI（PR #125，最终门）

**首轮（@92854da）三项必需检查全部 pass：**

| 检查 | 结果 | 时长 | 备注 |
|---|---|---|---|
| Browser E2E (Playwright) | **pass** | 1m47s | 主 CI 浏览器套件 |
| Engineering Gate + Migration Rehearsal | **pass** | 6m0s | typecheck/arch/unit/governance/build/runtime 全链 |
| Writing E2E（真环境闭环 + 故障矩阵） | **pass** | 2m14s | 完整 7 用例 + validator fail-closed（`collected=7`） |

- Writing E2E workflow 即"7 用例 + validator"的权威执行环境（`collected=7` 校验、零跳过零失败）；本机 runner 的收尾 flake 由此绕开。

## 8. 未完成项与剩余风险

1. 本机 runner 收尾挂死为**环境性**（用例层全绿已三证）；如需本机完整单次报告，重试偶发成功（首轮已成功一次）。
2. `HUSKY=0` 仍为临时隔离（沿 rel 批次纪律；钩子根因仍未定论）。
3. 嵌套 ref 不持久为**本沙箱**行为；已双级维护 + 恢复记录，不影响推送到远端的分支内容。
4. 导出屏障 E2E 变体、R2 竞争路径可观测性沿用 reliability 批证据（本整合未改动其代码路径）。
5. N2 边界（注记/评析摘录、稿次/feedback 引用、历史 attempt/grading 引用）不在本批。

## 9. N1（学习笔记）开工条件（只记录，不启动开发）

依据 `docs/plan/study-notes-design-2026-09-18.md`（wt-main 未提交区）与 handoff 计划：

- **前置**：Task C 关闭（本任务完成 ✓；翻译旧入口已按真实能力降级 ✓）。
- **基线**：从整合分支 `integration/l3-reliability-writing` 合入后的新基线重新核对（不提交/覆盖进行中改动）。
- **协议依赖（须兼容，不另起一套）**：
  - F-1 只读回看深链：`/l3?sheet=<id>`、`?paper=<id>`、`L3ExamPaper.replaySheetId`、`刷新评卷`；
  - 作文稿次协议（task/sheet/origin/resume）已合并（本整合）——N1 引用输入 strict 枚举，不预留可任意写 JSON 的后门（N2 条件另列）。
- **设计文档随批落位**：design / execution-plan / start-prompt 三件（当前在 wt-main 未提交区，属他人产物，未带入本分支）。
- 本轮**未启动**学习笔记开发。

## 10. 复现指引（关键命令）

```bash
# 环境
export PATH="/c/Users/20564/.workbuddy/binaries/node/versions/22.22.2-3:/usr/bin:/bin:$PATH"
cd "D:/Temp/Myawesomeapp/vocab-ob'/wt-integration"

# 单测 / 门禁
npx vitest run tests/frontend --coverage.enabled=false
API_CONTRACT_BASE_REF=ccc6fb4c… ROUTE_COMPLEXITY_BASE_REF=ccc6fb4c… npm run api:governance

# 真浏览器（隔离库；服务可由 playwright 自起或以如下 env 预启复用）
E2E_PORT=3105 E2E_WRITING_SMOKE=1 \
E2E_OWNER_TOKEN=test-owner-token-for-e2e-0123456789 E2E_AGENT_TOKEN=test-agent-token-for-e2e-0123456789 \
DATABASE_URL='postgresql://vocab_app:***@127.0.0.1:5433/vocab_integration_accept' \
E2E_SETUP_DATABASE_URL='postgresql://vocab_migration:***@127.0.0.1:5433/vocab_integration_accept' \
AGENT_API_TOKENS='agent-a:test-agent-token-for-e2e-0123456789' DB_SSLMODE=disable \
npx playwright test e2e/writing.spec.ts e2e/writing-origin.spec.ts
npx tsx scripts/verify-writing-e2e-report.ts <json>
npx playwright test e2e/l3-sheet-reliability.spec.ts
```
