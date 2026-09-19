# 换机开发与数据恢复手册

基线见 [交接入口](README.md) 与 [状态快照](workspace-snapshot.json)。命令以 PowerShell 为例，在独立新目录执行。旧电脑保留到新电脑验证完成。

## 需要搬走什么

| 资产 | 如何保全/恢复 | 不能误解的地方 |
|---|---|---|
| 已提交代码与四个本地分支 | 本轮 `repository.bundle`，已做校验与独立镜像恢复检查；也可从可信 origin 重新 clone | bundle 不保存未提交内容、reflog、hooks、Git config 或工作区暂存状态 |
| 未提交设计与本文 | 本轮 `handoff-docs.zip`，按原相对目录保留 | 这些资料尚未发布到远端，仅 clone 不会得到它们 |
| main 的临时提取/种子脚本 | 快照列出 6 个 `scripts/tmp-*`；由旧机另行私密保全 | 本轮资料包只收文档，不自动复制可能带凭据或语料的脚本 |
| PostgreSQL 学习数据 | 专用备份账户创建 dump＋manifest＋签名密钥的独立保管，并在新机空库恢复演练 | Git、Docker 镜像、源码 ZIP 都不包含学习进度与题纸数据 |
| 私密配置 | `.env*` 的真实文件、数据库各角色凭据、owner/agent/LLM/tunnel 配置 | 本轮只记录文件存在，不读取或打包其内容；新机重配绝对路径、端口和 origin |
| 用户文件/证据 | Obsidian/MD 原始材料、原始试卷/语料、`deliverables/` 截图、`build-analysis/`、必要 `.tmp` 证据 | 若文档引用 `D:/tmp/...`，仅搬仓库仍会丢证据。按报告清单另外复制并校验 |
| Git 事故备份 | 旧机 `D:/tmp/rel-gitmeta-backup/`、`rel-wt-recovery/`、`rel-wt-old-hold/` 及 closeout 目录 | 本轮不确认这些外部备份完整性；根因调查保留，不能当新机正常启动方式 |
| 依赖和构建 | 从 lockfile 安装、重新 build | 不搬 node_modules/dist 作为可重复环境；Playwright 浏览器另装 |

资料包不是全机备份，也没有数据库。本轮不停止服务、不转移写入流量、不复制真实密钥。

## 旧机出发前

- [x] 记录最后一次写入时间与准备迁移的数据库身份（只记 host/port/db 和 owner ID，不记密码）。开发库、验收库、个人学习库分别标识。（2026-09-19 收尾轮完成：见 [收尾事实](local-closeout-facts-2026-09-19.md) 与功能地图的数据库拓扑）
- [ ] 将数据类资产（数据库 dump、语料、截图、私密配置；**不含代码与文档**）复制到另一块磁盘/新机并在目的端复核 SHA-256；代码与文档已通过 GitHub 交接收尾轮独立保全，不受此步阻塞。（本地保全副本已就绪：`pack-staging`＋`private-backups`；外部复制仍未执行）
- [ ] 若仍在持续学习，最终切换前安排停止业务写入，再做最终数据库备份；之前的演练备份不能代表最终一致数据。
- [ ] 保留原有 Git 事故证据；默认 fsck=0 不等于根因查明。所有 Git 元数据写操作由一个执行者协调。

## 新机恢复代码

**首选（GitHub；2026-09-19 交接收尾后可用）**：

```powershell
git clone https://github.com/looseP/vocab-ob-reborn.git vocab-ob
cd vocab-ob
git switch --track origin/local-closeout-2026-09-19   # 先读交接文档，再按任务选择功能分支
git fetch origin reliability-batch writing-practice-v1
```

三个目标分支分别保全：`local-closeout-2026-09-19`（交接文档与快照）、`reliability-batch`（可靠性补修，PR #124 draft）、`writing-practice-v1`（作文原题整合，PR #123 draft）。它们**不是**一个已整合的“全功能合集”；整合顺序见 `feature-map.md` 末节。

**备选（离线 bundle）**：需要离线恢复时，用交接包 `repository.bundle`（含 5 分支快照）按下方流程执行。工具基线：Node **22.22.2**（`.nvmrc`）、npm **10.9.7**（`packageManager`）、Git、PowerShell；数据库使用 PostgreSQL **17**。Docker Desktop/WSL2 在选择容器方案时需要。备份脚本需 pg_dump/pg_restore；容器工具链固定版本以 Dockerfile 为准。

建议使用无引号的短路径，如 `D:/dev/vocab-ob`，不沿用旧机外层目录名与四个 `.git` 指针。恢复到不存在的新目录：

```powershell
# 在包含 repository.bundle 的交接目录执行，目标目录必须不存在。
git clone --branch main ./repository.bundle D:/dev/vocab-ob
if ($LASTEXITCODE -ne 0) { throw 'clone failed' }
Set-Location D:/dev/vocab-ob
git fsck --full --no-reflogs
git branch --all

# bundle clone 的 origin 暂时是本地文件；确认分支齐全后设置真实远端。
git remote set-url origin https://github.com/looseP/vocab-ob-reborn.git
# bundle clone 留下的 origin/* 是打包时快照；先恢复本地分支，再做任何远端 prune。
git branch reliability-batch origin/reliability-batch
git branch writing-practice-v1 origin/writing-practice-v1
git branch writing-v1 origin/writing-v1
git log -1 --oneline reliability-batch
git log -1 --oneline writing-practice-v1
```

如果分支名已存在，先核对 SHA，不重复创建或覆盖。`writing-practice-v1@b11f3ee` 与 `reliability-batch@b96b972` 已于 2026-09-19 核实存在于远端且 SHA 一致（旧 tracking 记录可能过时）。暂不 `fetch --prune`。

解开 `handoff-docs.zip` 到单独检查目录：`wt-main/docs/...` 对应新仓库 `docs/...`。比较现有文件再拷入；`wt-practice/docs/plan` 与 `wt-reliability/docs/plan` 是分支资料，不混写主线同名文件。资料包中保留 SHA 与目录来源。

```powershell
$env:HUSKY = '0'
node --version
npm --version
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
git config --show-origin --get core.hooksPath
git fsck --full --no-reflogs
npx playwright install chromium
```

`HUSKY=0` 是临时隔离，不跳过手工工程检查。不要恢复旧机 Git 全局配置、代理或 hooks；按新机实际网络重配。后续如需并行工作，由新 clone 的 Git 正常创建 worktree，不直接搬旧 worktree 的 `.git` 文件。

## 数据库与身份恢复

遵循 [PostgreSQL 备份恢复合同](../operations/postgresql-backup-recovery.md) 和 [单机部署指南](../operations/single-host-deployment.md)。先创建隔离空目标库；恢复程序要求目标名以 `_drill`、`_restore` 或 `_test` 结束，并要求精确确认目标身份。

步骤与命令：

1. 旧机从私密配置载入专用 backup URL 到 `DATABASE_URL`，指定私密 `BACKUP_DIR`，按既有签名策略载入 `BACKUP_SIGNING_KEY`；执行 `npm run db:backup`。
2. 将该次实际 manifest 路径记为 `$migrationManifest`，执行 `npm run db:backup:verify -- $migrationManifest`。同时转移对应 dump，签名密钥单独保管。
3. 新机先安装与备份兼容的 PostgreSQL 17 工具链和角色。配置 `DRILL_DATABASE_URL` 指向隔离空库、`ALLOW_DESTRUCTIVE_RESTORE` 为该库精确 `host:port/database`；执行 `npm run db:restore:drill -- $migrationManifest`。不得把这些变量指向旧机个人库。
4. 恢复后使用与源数据兼容的代码 SHA，检查迁移 journal、表/函数、核心行数与样例；如需升级，用 migration 角色按权威迁移历史推进。不要先迁移目标空库再覆盖 dump，不要 `db:push` 或重放全部 SQL 修补已恢复库。
5. 保留原用户 UUID/`LOCAL_OWNER_ID` 及所有权关系；重建 secret 可以，随意更换 owner ID 会表现为“恢复成功但看不到旧数据”。

权威迁移配置是 `drizzle.config.ts`：目录 `drizzle-release/`，journal 表 `vocab_migrations.__v2_release_migrations`。表数据恢复不自动等同于数据库 LOGIN 角色/权限配置恢复；结合 prepare/converge/verifier 复核应用、worker、migration、backup 角色。

验收记录至少包含：源/目标数据库身份、备份时间、dump/manifest 哈希、代码 SHA、迁移计数、users/词汇/进度/L3 source/question/sheet/attempt/writing 的行数对照及代表性对象回看、恢复耗时。表名以该 SHA 的 schema 为准；不要用新导入数据掩盖恢复缺失。

## 启动开发环境

选择两种方式之一：

- **前后端源码开发**：恢复到可访问的隔离开发数据库；后端 3001、Vite 5173。`.env.example` 中 `postgres` 是容器内 DNS，宿主进程要改成实际数据库地址。必须显式加载 env；`npm run dev` 本身没有自动加载 `.env` 的保证。
- **Windows 单机 HTTPS**：按 `docs/operations/single-host-deployment.md` 使用 `compose.single-host.yaml` 和独立私密 env；Caddy、镜像 digest、备份挂载按新机重配。不要与 `compose.yaml` 混合。

源码开发的两个终端，均在包根目录执行，且使用已配置、未提交的 `.env`：

```powershell
# 终端 A：.env 内配置真实开发库和原 owner；不在命令中粘贴密钥。
$env:HUSKY = '0'
node --env-file=.env --import tsx --watch src/server.ts
```

```powershell
# 终端 B：明确代理目标；APP_ORIGIN 应与浏览器访问源一致。
$env:API_PROXY_TARGET = 'http://127.0.0.1:3001'
npm run frontend:dev
```

`PORT=3001`、浏览器使用 `http://127.0.0.1:5173` 时配置对应 `APP_ORIGIN`；不要混用 localhost 与 127.0.0.1 排查 Cookie/CSRF。3000/3100/3108 是旧机某次会话端口，不是固化合同。worker 单独运行，LLM 未配置时允许显式降级。

## 最小验证与停止点

1. **代码**：默认 fsck=0、目标分支 SHA 正确、资料包哈希一致。
2. **静态与组件**：`npm run typecheck`、`npm run arch:check`、`npm run frontend:build`；在可靠性分支运行生命周期/保存相关用例。不要在 main 上寻找只存在于 #124 的测试文件。
3. **工程基线**：完整 `verify:engineering` 前选择真实比较 base，配置 `COVERAGE_BASE_REF`、`API_CONTRACT_BASE_REF`、`ROUTE_COMPLEXITY_BASE_REF`。不能让 base=HEAD 绕过差异门禁。当前可靠性批次比较基线为 `ccc6fb4`，合并后重新选择。
4. **真实 E2E**：使用独立验收库，先读 `e2e/constants.ts`、`global-setup.ts`、Playwright 配置及 Writing workflow。明确数据库身份和端口再执行；这些脚本会写入/清理合成测试数据，不能指向个人学习库。先重建 `dist/frontend`，避免验收旧构建；不要复用不明旧服务。
5. **用户链路**：登录 → 词书/复习 → L2 → L3 原文定位 → 题纸保存/定格/回看/导出 → 作文续写/提交/反馈；核对个人历史样例与行数，而不只打开首页。
6. **后台**：核对 outbox/reaper 和备份调度实际启动、成功备份时间与恢复证据。备份服务 healthcheck 不能替代最近备份成功证明。

全部通过后才切换日常学习入口。新机异常时保留新机增量，回到旧机前确认新旧写入分叉；不让两机长期同时写各自数据库并期待 Git 合并数据。旧机清理另行安排。
