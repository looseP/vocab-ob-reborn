# 换机接手与已有能力巩固执行计划

> **For agentic workers:** 使用 executing-plans 按检查点推进；迁移 Git 元数据由单一执行者处理，不自动并行派工。具体资料见 `docs/handoff/README.md`。

**Goal:** 新机器可重建正确代码、保留用户学习数据并继续已有功能开发。

**Architecture:** 分开交付代码、未提交资料、私密配置和数据库；先按旧 SHA 恢复再升级。保全未合并分支，不在迁移中顺带重写功能。

**Tech Stack:** Node 22.22.2 / npm 10.9.7 / PostgreSQL 17 / TypeScript / React 19 / Vite / Vitest / Playwright。

## 全局约束

- 本轮只沉淀资料与创建本地交接副本；没有授权自动合并、部署或切换数据库。
- 共享 Git 单写者，HUSKY=0 临时隔离；根因未锁定，不恢复 hooks 或清理事故备份。
- `.env`、数据库、签名密钥分别私密保管；无日志输出实际密钥。
- 所有验证绑定代码 SHA、配置和数据库身份；不能把旧 CI 或设计稿当当前功能证明。

## Task 1：资料与代码保全（本轮）

文件：新增 `docs/handoff/README.md`、`feature-map.md`、`machine-migration.md`、`workspace-snapshot.json`；本计划；`docs/plan/README.md` 导航。

- [x] 从 main、reliability、practice、writing 核对本地 HEAD 与未提交状态。
- [x] 将既有功能和分支增量分别定位到代码，修正旧指南中的过时缺口。
- [x] 在外层交接目录保全四分支 Git bundle、未提交设计文档和资料快照，生成 SHA-256 清单。
- [x] 校验 bundle，独立镜像恢复并默认 fsck，逐一比对四分支；验证资料包路径与内容。

完成条件：新机器即使暂时无法连接 GitHub，也有四分支提交和未提交设计资料；数据库/密钥仍明确单列待迁移。实际产物结果记在交接目录的 `TRANSFER-REPORT.md`。

## Task 2：旧机数据与私密资产保全（切换前执行）

消费：`docs/handoff/machine-migration.md` 的资产清单和仓内备份恢复合同。

- [ ] 选择实际学习库，确认 owner、版本、角色和外部材料位置；不把验收库当用户库。
- [ ] 生成并验证 dump/manifest，签名密钥独立保管；复制未打包的临时脚本、原始材料与所需截图证据。
- [ ] 把交接产物转移到独立介质并在目的端验 hash。
- [ ] 持续写入期间先做演练；最终切换时停止写入并重做最终备份。

完成条件：可定位的数据库备份和密钥、完整材料清单、目的端校验记录。仅源码搬运不得标记此项完成。

## Task 3：新机恢复与基线验收

- [ ] 新目录 clone bundle，恢复四个本地分支，然后配置可信 origin；先保存 practice 分支再 prune。
- [ ] 依 lockfile 安装依赖，按 `.nvmrc`/packageManager 固定工具版本。
- [ ] 在隔离空库执行恢复演练，核对迁移历史、用户身份、行数和代表性历史数据。
- [ ] 源码开发或单机 Compose 选择其一，重配路径/origin/端口，单独启动 worker。
- [ ] 跑静态门禁、对应分支组件测试和隔离真实链路；本地测试绿与恢复成功分开记录。

完成条件：`NEW-MACHINE-ACCEPTANCE.md` 记录新机 SHA、工具版本、恢复证据、测试结果、仍未迁移项；旧机保留。

## Task 4：恢复功能推进节奏

- [ ] 读取 PR #124 最终 head/CI/审查状态，处理合并流程，未授权时不代为合并。
- [ ] 从 `writing-practice-v1@b11f3ee` 核对 Task C 可复用成果；读取整合日志尾部 R1–R3，避免照抄验收报告早期已被修正的降级语义。
- [ ] 比较与 #124 共改文件：`L3ExamPaper`、保存/导航控制器、客户端合同和 E2E。整合后复验 StrictMode、原卷 flush、origin/resume、返回原纸零新增、版本冲突和定格/导出锁。
- [ ] 翻译旧入口按真实能力降级，关闭 Task C 后再排学习笔记 N1；保留“自由笔记＋专题＋深度引用”的已选方向。

## 新机首轮可复制 prompt

请先阅读 docs/handoff/README.md、feature-map.md、machine-migration.md 和本计划，按实际 Git 状态更新认知。目标是恢复并巩固现有项目，不开始新增功能。先只读核对当前仓库根、HEAD/分支/工作区、Node/npm/PG 版本、迁移历史和私密配置是否齐备；不得输出密钥。

main 的历史基线为 ccc6fb4；可靠性成果为 reliability-batch@b96b972；作文原题整合为 writing-practice-v1@b11f3ee；学习笔记还只有设计。它们是本轮交接快照，不强制回退新机器上更晚的提交。若实际状态更新，先解释差异并保留所有分支和未提交文件。

按迁移手册恢复代码与独立测试数据库，完成实际用户历史样例、组件和浏览器验收，记录准确 SHA 和命令退出码。不要把 npm ci、首页可打开或 CI 全绿当作数据库已经迁移。所有 Git 写遵守单写者，HUSKY=0 仍为临时隔离。不得自动合并 PR、覆盖数据库、删旧机文件或恢复 hooks。

恢复完成后给出 Task C 的复用清单及分支整合风险；再排学习笔记 N1。请持续完成已授权且可逆的准备工作，仅在真实缺失的数据库身份、私密材料或不可逆切换需要决策时停下说明。
