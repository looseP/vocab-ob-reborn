# 作文-试卷台整合修复 · 验收报告（2026-09-19）

> 基线：main `ccc6fb4c`（PR #122 后）。分支：`writing-practice-v1`。计划/日志：`writing-practice-integration-repair-2026-09-18.md`、`writing-practice-integration-log-2026-09-18.md`、`writing-practice-continuation-plan-2026-09-19.md`。

## 1. 交付内容（A–D）

- **A** origin v1 导航契约（`ed8d3bb`）＋ 按题批量进度读面 `GET /api/l3/writing/tasks/question-summaries`（`b3c24a6`）。
- **B** 共享入口 `WritingQuestionEntry` ＋ fileKey 题组接线 ＋ 工作区来源条/返回原题/次级全部作文 ＋ origin 全透传（`838b790`）。
- **C** 四分支入口（整卷草稿 / source 文件 / 整卷 sealed 回看 / 文件 sealed 回看）＋「专项练习（不计入本次试卷作答）」＋ 跳转前保存屏障 ＋ `?resumeSheet=` 按 ID 恢复 ＋ `?question=` 卷内定位（`91bbc2a`）；「开始修改（第二稿）」→「开始修改」。
- **D** `e2e/writing-origin.spec.ts` 进入 Writing E2E 必需检查；validator 固定收集 4→7（`8884bdc`）。

## 2. 真环境发现并修复的 3 个真 bug

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 按题创建作文任务在受控环境必 500 | `l3_questions` 角色仅授 S/I/D；`FOR UPDATE` 需表级 UPDATE | advisory 锁 + 无锁 SELECT（`51ffa20`） |
| 2 | dev 下写作输入/保存全死（StrictMode） | 卸载清理 `dispose()` 终态 + StrictMode 模拟卸载 | `isDisposed()` + hook 重建（`51ffa20`） |
| 3 | 返回恢复退化 openSheet（sealed 会另建新卷） | StrictMode 双跑致深链效应双触发、resume 二次消费 | 一次性消费守卫 + 2 条 StrictMode 回归（`558fac5`） |

## 3. 验收证据（本地；代码 SHA `8884bdc`，base `ccc6fb4c`）

- **全量单测**：231 文件（230 过 / 1 跳过）；3296 用例（3290 过 / 6 跳过）。
- **分层覆盖 fail-closed**：Diff coverage **98.45%**（changed src 19 / 129 行）；四层基线＋目标全 PASS；收集 231/231。
- **门禁**：typecheck 0；arch ✔；api:governance 全绿（base=ccc6fb4c）；schema-drift ✔；runtime ✔；alerting ✔；release 契约 ✔；frontend:build ✔。
- **Writing E2E（CI 姿势）**：`collected=7 executed=7 skipped=0 failed=0 passed=7 (pw_exit=0)`，validator exit=0。
- **真环境旅程**（隔离验收库 + 合成数据）：
  - B：仅显式开始 +task/+sheet；保存/返回/继续/F5 零新增；提交 +attempt；查看 sealed 零新稿（`D:/tmp/practice-b-journey/`）。
  - C：屏障先行（离开前 PATCH 200）；resumeSheet 同纸恢复、选择保留、`opensheet_posts_after_back=0`；venue 全链零新增零泄漏（`D:/tmp/practice-c-journey/`）。
- **CI（PR #123，head `8884bdc`）**：Browser E2E ✔ / Engineering Gate + Migration Rehearsal ✔ / Writing E2E ✔。

## 4. 体验地址（本机，临时）

- 入口：`http://127.0.0.1:3100/l3?venue=short_essay&file=practice%3A%E5%B0%8F%E4%BD%9C%E6%96%87+%C2%B7+%E5%90%88%E6%88%90%E9%82%80%E8%AF%B7%E9%82%AE%E4%BB%B6&question=00000000-0000-4000-8000-0000000001b1`（登录后直达题型空间可选题页）。
- 登录：Owner token = `local-owner-api-token-only-0001`。合成数据：小作文题组（2 题）、大作文文件（1 题）、合成整卷（客观 + 写作）。
- 服务：单端口 app 服务（SERVE_FRONTEND=true，端口 3100，日志 `/d/tmp/practice-experience.log`）；停止=结束对应后台任务/关闭会话，或停掉该端口的 node 进程。

## 5. 边界与未完成项

- **未合并、未部署、未迁移 live**（PR #123 为 draft；分支保护下由合并流程另行触发）。
- 不涉及自动评阅 / 数字评分 / 整卷答案自动回填；`sentence_translation` 无作文入口（设计如此）。
- source 型回看方向查询失败时降级「通用」（低概率，不阻塞）。
- 体验服务/合成数据为本机临时物，随会话回收。
