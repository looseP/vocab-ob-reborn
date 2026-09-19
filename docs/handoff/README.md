# 项目接手与换机入口

更新：2026-09-19（GitHub 交接收尾）。用途：在没有旧会话记忆的新机器上，恢复项目认知、代码分支与验证路径。本文是交接导航，功能事实以对应 SHA 的代码和证据为准。

## 新机入口（仅用 GitHub）

```powershell
git clone https://github.com/looseP/vocab-ob-reborn.git vocab-ob
cd vocab-ob
git switch --track origin/local-closeout-2026-09-19
# 然后先读 docs/handoff/README.md（即本文），再按任务选择功能分支。
```

- 三个分支 `local-closeout-2026-09-19`、`reliability-batch`、`writing-practice-v1` 分别保全，**不代表已整合成一个可运行版本**；不存在“所有最新功能的合集分支”。
- 本次交接范围仅限 GitHub 上的代码、已提交文档与指定分支。数据库、原始语料、截图、私密配置与备份均保留在旧机，不在本次交接内；理解基本接手步骤不需要旧机 `D:/tmp` 或任何仓外文件。

## 先读这四份资料

1. [已有功能全景](feature-map.md)：用户能做什么、代码在哪里、哪些能力只在分支上。
2. [开发与数据迁移手册](machine-migration.md)：旧机保全、新机启动、数据库恢复、验证与回退。
3. [下一轮执行计划](../plan/machine-handoff-execution-plan-2026-09-19.md)：先做什么、完成条件与可直接复制的启动指令。
4. [本机状态快照](workspace-snapshot.json)：实测 SHA、分支、未提交文件及本地资产位置；这是历史快照，不是实时状态。

## 当前落点

| 层级 | 2026-09-19 本地事实 | 接手原则 |
|---|---|---|
| 已合入主线 | `main@ccc6fb4`，含作文空间 PR #122、题纸回看 PR #121 | 作为共同基线，不代表最新可靠性修复已合入 |
| 可靠性补修 | `reliability-batch@b96b972`，PR #124 交付状态为 draft | 本地关键测试 64/64、独立探针 4/4、默认 fsck=0；远端 CI 依据交付记录，接手时核验 |
| 作文练习整合 | `writing-practice-v1@b11f3ee`，不在本地主线祖先链中 | 有 origin/返回原题/保存屏障等成果；2026-09-19 已核实远端同名分支 = `b11f3ee`（本地 tracking 的 “gone” 为过时记录） |
| 作文基础分支 | `writing-v1@baf971e` | 已随 PR #122 合入 main；保留基线用于比对 |
| 学习笔记 | 三份 `docs/plan/study-notes-*` 设计/计划/提示词已随 `local-closeout-2026-09-19` 提交（此前仅存在于旧机工作区） | **文档已提交 ≠ 功能已开发**：独立学习笔记系统仍未实现；方向为“轻量自由笔记＋专题＋引用现有对象” |

该轮（09-19 上午）未合并分支、未部署、未备份或恢复数据库。换机准备资料可用，不等于数据迁移完成。

2026-09-19 收尾两轮：①本地收尾轮——三个学习数据库已签名备份（均通过 `db:backup:verify`；其中**仅 `vocab_practice_accept` 完成隔离恢复演练**，compose 库未单独演练）、外层资料全量本地保全。②GitHub 交接收尾轮——交接文档修正并锁定到 `local-closeout-2026-09-19`，新机可仅凭 GitHub clone 恢复代码与文档（见上方“新机入口”）。

范围声明：GitHub 交接收尾不含数据库、原始语料、截图、私密配置与备份的迁移，这些资产保留在旧机；数据恢复与外部介质复制不作为本次完成条件。三分支分别保全、仍未合并、未部署——不等于整合版本。

## 维护约定

- 功能条目同时记“在哪个 SHA 上实现”和“验证到什么程度”；不以测试总数或设计文档冒充功能完成。
- 合并后更新本页与功能表；迁移现场快照另存日期版本，不把旧机绝对路径当成项目常量。
- 功能真源为 `src/`；API 为 `docs/api/openapi.json`；数据库迁移唯一历史为 `drizzle-release/`；设计/任务为 `docs/plan/`；运维合同为 `docs/operations/`。
- 外层 `PROJECT-GUIDE.md` 为 2026-08-22 历史指南。其“FR-12 完全未接线”“阅读圈记不存在”等缺口结论已过时，不能再直接用于派工。
- `.git` 事故根因未锁定；`HUSKY=0` 为本机临时隔离措施。共享 Git 元数据维持单写者纪律，不能把恢复了 fsck 等同于查明事故根因。

## 资料索引：GitHub 交接 vs 旧机资产

**本次 GitHub 交接范围**（新机凭 clone 即可获得）：三个分支的全部已提交代码与文档，包含本目录与 `docs/plan/` 的交接材料。基本接手步骤不依赖下列旧机资产。

**留在旧机、不在本次范围**（需要时另行安排，不阻塞代码接手）：

- `deliverables/machine-handoff-2026-09-19/`、`deliverables/machine-closeout-2026-09-19/`：外层交接包（新/旧 bundle、资料包、收尾报告与校验清单）。
- `D:\tmp\local-closeout-2026-09-19\pack-staging\`：外层与 D:/tmp 资料的本地保全副本；`private-backups\`：数据库 dump、签名密钥与运行 env（私密，勿入 Git）。
- 数据库、原始语料（`D:/Notes/L1_雅思词汇_迁移包_2026-08-22/`）、截图与事故证据：保留旧机原件。

历史事实（不构成新机前置条件）：三库备份已完成并验证，其中仅 `vocab_practice_accept` 做过恢复演练；详见 [收尾事实](local-closeout-facts-2026-09-19.md)。
