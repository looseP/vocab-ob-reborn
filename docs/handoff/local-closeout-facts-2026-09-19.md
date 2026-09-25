# 本地收尾事实与保全索引（2026-09-19）

基准：`main@ccc6fb4` 工作区实测。本文件记录 2026-09-19 本地收尾轮（代码/资料/数据库保全与恢复验证）的实际结果、私密位置与遗留事项。**本文件不含任何凭据值**；凭据只存在于私密目录。

**范围更新（09-19 晚 GitHub 交接收尾轮）**：本文件的数据库与资产操作系旧机本地收尾的**历史记录**。GitHub 交接收尾仅覆盖代码、已提交文档与指定开发分支；数据库、原始语料、截图、私密配置与备份继续留在旧机，不在本次交接内，数据恢复与外部介质复制也不是本次完成条件。

## 1. 代码保全

- 四个本地分支 HEAD 未变：`main@ccc6fb4`、`reliability-batch@b96b972`、`writing-practice-v1@b11f3ee`、`writing-v1@baf971e`；默认 `git fsck --full --no-reflogs` exit 0（保留既有 dangling commit 观察项，无可达对象缺失）。
- 本轮文档收敛到本地分支 `local-closeout-2026-09-19`；初始提交 SHA 记录在外层 `deliverables/machine-closeout-2026-09-19/LOCAL-CLOSEOUT-REPORT.md`。该分支与两个功能分支的远端保全见 `README.md` 新机入口（GitHub 交接收尾轮）。
- 最终离线 bundle：外层交接包 `repository.bundle`，包含 5 个分支（四个原分支 + 交接分支）与四个 worktree HEAD 记录；独立恢复与 fsck 结果见收尾报告。
- 未提交内容的实际副本：`D:\tmp\local-closeout-2026-09-19\pack-staging\repo-uncommitted\`（docs 17 个文件 + 五个 `scripts/tmp-*` 迁移脚本，目录按仓库结构保留）。

## 2. 数据库学习数据（三库已备份；仅主库完成恢复演练）

三个承载用户数据的库已用现有 `postgres-backup` 工具执行单次签名备份（HMAC-SHA256，密钥见私密目录）：

| 来源库 | 内容定位 | dump 字节 | SHA-256 |
|---|---|---|---|
| `vocab_practice_accept`（本机 5433） | L3 练习主库；本机 3100 服务当前连接 | 307,633 | `ce4acc36901c3d1ed026a8c4e16c989c6663880ca9c3d341233ce3b85d78bec9` |
| `vocab`（本机 5433） | accept 的兄弟快照；含 1 条 accept 无的题纸 | 320,872 | `af2d350f7e826db8d1b041191e1ce1db88bf00cc5ca99ed44f458d3dce612b11` |
| `vocab`（compose 网络） | 3001 live 卷库；6768 词 + 40 条复习（L1 数据） | 5,234,429 | `94c7c6e2114b593c5ff80ac1810ad3f4254caf4846d3816ffb214c1719147599` |

- 三份 manifest 已在宿主以 `db:backup:verify` 复核：exit 0、`signed:true`；日志 `private-backups/evidence/verify-backups.log`。
- **恢复演练**（主库）：`vocab_practice_accept` → 隔离空库 `vocab_practice_accept_restore`（本机 5433，库名满足 `_restore` 约束，`ALLOW_DESTRUCTIVE_RESTORE` 精确确认）：
  - `db:restore:drill`（restore-only）exit 0，耗时约 6 秒；结构证据 `migrationCount=39, tableCount=52, functionCount=73` 与 manifest 完全一致。
  - 业务抽样：23 张关键表行数逐一比对一致（`evidence/counts-accept.txt` / `counts-restore.txt`）；代表性记录（3 卷、09-19 02:07 最新题纸、09-18 最新作答）在恢复库可读。
  - 恢复库暂留以供复核（未删除）。
- 私密位置（同一磁盘、非仓库、非同步盘）：`D:\tmp\local-closeout-2026-09-19\private-backups\`（`db/`、`keys/`、`env/`、`config/`、`evidence/`）。
- 注意：这是**准备阶段备份**（源库仍在接受写入）；最终换机切换前需停写并重做最终快照备份。

验证命令模板（凭据从私密目录载入，不写入任何提交或普通包）：

```powershell
# 读取密钥文件内容（不要把文件路径当作密钥值）；.Trim() 去掉末尾换行。
$env:BACKUP_SIGNING_KEY = (Get-Content -Raw '<private-backups>\keys\backup-signing-key.txt').Trim()
$env:BACKUP_DIR = 'D:\tmp\local-closeout-2026-09-19\private-backups\db'
npm run db:backup:verify -- .\vocab_practice_accept-<timestamp>.manifest.json
```

## 3. 资料保全（外层资产）

`D:\tmp\local-closeout-2026-09-19\pack-staging\`（约 0.98 GB，按来源保留目录结构）：

| 子目录 | 内容 | 分类 |
|---|---|---|
| `repo-uncommitted/` | 未提交文档与脚本副本（见第 1 节） | 必须迁移 |
| `evidence/wt-main-tmp/` | `.tmp` 截图 48 张、walkthrough/验收脚本、日志（27 MB） | 必须迁移 |
| `evidence/wt-main-learnings/` | `.learnings`（ERRORS/FEATURE_REQUESTS/LEARNINGS） | 必须迁移 |
| `outer/deliverables/` | L1 报告、software-company 派单文档与 demo、既有交接包（含旧 bundle） | 必须迁移 |
| `outer/build-analysis/` | 各期状态目录；`git-closeout-20260919-124144/` 含事故收尾证据（recovered.bundle、fsck 基线、隔离记录） | 必须迁移（证据） |
| `outer/l1-audit-full/`、`outer/l1-review/` | L1 审计/评审脚本与中间快照（含 `_snapshots` 111 MB） | 必须迁移（历史证据，部分可重建） |
| `outer/staging/`、`outer/核心对话导出/`、`outer/_archive-2026-08/`、`outer/typewords-dict/` | L0/L1 修复材料、方案梳理、词典素材 JSON | 必须迁移 |
| `outer/d-tmp-evidence/` | `rel-gitmeta-backup`、`rel-wt-recovery`、`rel-wt-old-hold`、`writing-v1-release-backup` | 必须迁移（事故证据） |
| `outer/d-tmp-loose/`、`outer/outer-root-files/` | D:/tmp 与外层根散落文件全量副本（3,478 + 56 个） | 仅历史证据 |
| `outer/notes-d/L1_雅思词汇_迁移包_2026-08-22/` | 原始语料权威副本（6767 词/11992 义项，114 MB） | 必须迁移 |
| `outer/d-tmp-vocab-backup-20260910/` | 旧 bundle 群与 L1 语料 tar（114 MB；cookies 归档已移入私密区） | 必须迁移 |

未复制项（可重建，保留原位）：`wt-main/node_modules`、`dist`、顶层 `tools/node-v22.22.2-win-x64`（官方可下载）、`old-odds/`（旧版本历史，酌情处理）。

## 4. 私密资产（不随普通包流转）

`D:\tmp\local-closeout-2026-09-19\private-backups\`：

- `db/` — 三份 dump + manifest；
- `keys/backup-signing-key.txt` — 备份签名密钥（与本地 compose 备份策略一致）；
- `env/` — 备份/恢复运行环境文件（含数据库连接凭据，不得进入 Git 或普通文档包）；
- `config/` — `tmp-local-db-setup.ps1`（含本地角色初始密码）、`cookies.txt-archived-20260910.txt`。

真实 `.env` 现状：`wt-main/.env` 仅含 `DATAMUSE_ENABLED`；旧目录 `old-odds/**/.env*` 含历史配置（见 `private-config-migration-checklist` 一览，凭据未复述）。本机 3100 服务的运行配置来自启动会话环境变量，未落盘为文件，**新机须按 machine-migration 手册重配并以 `/readyz` 验证数据库身份**。

## 5. 校验与证据索引

- 既有交接包顶层 SHA-256：6/6 一致（本轮复核）。
- 默认 fsck（四 worktree 同库）：exit 0。
- bundle verify + 独立 clone --mirror + 默认 fsck：见收尾报告。
- 数据库：三份 `db:backup:verify` exit 0（三库备份全部验证）；恢复演练 exit 0 仅针对 `vocab_practice_accept`（行数一致 + 抽样一致）。
- 资料包：`machine-closeout-2026-09-19` 包内逐文件 SHA-256 见该目录 `SHA256SUMS.json`。

## 6. 本收尾轮的遗留（历史记录）与后续范围

1. **外部介质复制（本收尾轮未做）**：以上本地保全产物均在旧机同一磁盘。随后的 GitHub 交接收尾轮已将代码与文档通路独立完成；数据类资产（dump、语料、截图、私密配置）仍保留旧机，需要时另行复制并校验（清单：pack-staging + private-backups + `deliverables/machine-closeout-2026-09-19`）。
2. compose 库（compose `vocab`）未单独跑恢复演练；其备份管道（backup-scheduler 容器）健康，建议将来按同一合同演练。
3. 最终切换快照：旧机停写后重做备份（本轮的为准备阶段备份）。
4. 旧机清理、PR 合并、部署均不在收尾范围；后续开发顺序见 `feature-map.md`“最值得先做”：可靠性整合 → 作文练习分支与 Task C → 学习笔记 N1。
