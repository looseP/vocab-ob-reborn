# 自用栈 / 开发栈双栈边界

生效：2026-10-05 · 相关文件：`compose.dev.yaml`、`scripts/dev-stack.ts`

## 1. 为什么需要

在这个文件出现之前，**「每天在用的实例」与「正在开发的实例」是同一个**：

| 共享的东西 | 后果（都是实际发生过的） |
|---|---|
| 镜像（`vocab-observatory-v2:local`） | `docker compose build web` 从**工作区**构建 —— 连未提交的改动一起进镜像，用到的就是半成品 |
| 数据卷（`vocab-observatory_postgres-data`） | 开发动作（跑迁移、写测试数据、误评分）直接作用在**唯一一份真实数据**上 |
| 端口（3001） | 开发栈无法与自己共存 |
| 容器（`vocab-observatory-*`） | `up -d --force-recreate web` 会重启正在用来复习的服务 |

而自用库里有**不可重建的资产**：FSRS 调度状态、6768 词的全部内容、**118 条手工圈记的 L3 语境**、复习日志。代码丢了能重写，这些丢了就没了。

> 结论：`main` 分支保护 + 三项必检保护的是**代码**；它对"运行实例与数据"零保护。两者是不同层的问题。

## 2. 两条栈

| | 自用栈 | 开发栈 |
|---|---|---|
| project name | `vocab-observatory`（compose.yaml 的 `name:`，**不要改**） | `vocab-dev`（`-p vocab-dev`） |
| compose 文件 | `compose.yaml` | `compose.yaml` + `compose.dev.yaml` |
| web | `http://127.0.0.1:3001` | `http://127.0.0.1:3101` |
| 镜像 tag | `:local`（由 `promote` 更新） | `:dev`（随时构建） |
| 数据卷 | `vocab-observatory_postgres-data` | `vocab-dev_postgres-data` |
| 容器名前缀 | `vocab-observatory-*` | `vocab-dev-*` |
| 定时备份 | 开（每天） | 关（`--profile dev-backups` 可开） |

隔离靠三件事，缺一不可：**项目名前缀**（容器 + 命名卷）、**端口**、**镜像 tag**。

### 为什么镜像 tag 写在 `compose.dev.yaml` 里而不是环境变量

若靠 `APP_IMAGE=…:dev` 传入，那么任何人（包括脚本外的自己）手动跑一次不带该变量的
`docker compose build`，就会把自用栈正在用的 `:local` **重新打上** —— 隔离当场失效，且无任何提示。
写在 overlay 文件里，则任何调用路径都拿不到那个副作用。

### 项目名隔离不了的东西

**宿主相对路径**。`backup-scheduler` 挂的是 `${BACKUP_HOST_DIR:-./backups}`，项目名对它无效，
不覆盖就会和自用栈往同一个目录写备份 —— 所以 `compose.dev.yaml` 用 `!override` 把它换到 `./.dev/backups`
（并已加进 `.gitignore`）。

## 3. 日常命令

```bash
npx tsx scripts/dev-stack.ts status       # 两条栈对照（只读）
npx tsx scripts/dev-stack.ts up           # 构建并启动开发栈
npx tsx scripts/dev-stack.ts down         # 停开发栈（保留数据卷）
npx tsx scripts/dev-stack.ts refresh-db   # 用自用库快照刷新开发库
npx tsx scripts/dev-stack.ts promote      # 把当前 main 发布到自用栈
```

不要手敲 `-p` / `-f`：`docker compose -f compose.yaml -f compose.dev.yaml up -d` **不带 `-p`** 时
会落到自用栈的项目名上，于是端口 3001 冲突、并向自用数据卷写入。脚本把这一层封死了。

## 4. 自用栈的更新与回滚

**唯一入口是 `promote`**，它有两道闸：

- 工作区**必须干净**（构建用的是工作区内容，脏树会把半成品推进自用实例）；
- **必须在 `main` 上**（已合并、已过三项必检的代码）。

流程：构建 → 打 `use-<日期>` 标签（回滚锚点）→ `up -d --force-recreate` 重建自用栈。

```bash
# 回滚到某个锚点
docker tag vocab-observatory-v2:use-20261005 vocab-observatory-v2:local
docker compose -f compose.yaml up -d --force-recreate web
```

> ⚠️ **不要对自用栈跑 `docker compose build`**。要更新就跑 `promote`。
> 自用栈只认 `:local` 这一个 tag，而它现在只由 `promote` 更新 —— 这是刻意的。

## 5. 数据边界

- **`refresh-db` 对自用库只读**（`pg_dump`），写操作全部落在 `vocab-dev-*`。任何命令都不会
  `down` 自用栈，更不会删 `vocab-observatory_postgres-data`。
- 开发库是**一次性副本**：随时可重建、可写脏、可 drop。它不该承载任何"只有这里有"的东西。
- 开发库与自用库**结构相同、数据是某一时刻的快照** ⇒ 用它复现 bug 时，要先确认快照日期
  （`refresh-db` 结束时会打印两侧 `words` 行数供对账）。
- 自用库的备份是既有设施（`backup-scheduler` + `scripts/postgres-backup.ts`），本文件不改动它。
  但要记住：**备份没被恢复验证过就不算备份** —— 主库的隔离恢复演练仍是一件独立待办。

## 6. 常见故障

| 现象 | 原因 | 处置 |
|---|---|---|
| 开发栈起不来，报 3001 端口占用 | 忘了 `-p vocab-dev`，落到自用栈项目名上 | `down` 掉误起的那套，改用脚本 |
| `refresh-db` 报 pg_restore 返回 1 | `--clean` 时部分对象本就不存在（正常） | 看脚本打印的行数自检是否一致 |
| 开发栈 web 起来但页面报数据库错误 | 角色未收敛（restore 覆盖后 grant 丢了） | 脚本第 4 步已自动重跑 `database-role-converge`；手动可 `docker compose -p vocab-dev ... run --rm database-role-converge` |
| 自用栈"怎么没更新" | `:local` 只由 `promote` 更新 | 跑 `promote`；别 build |

## 7. 相关纪律

- **半成品不要靠"记得别开"来隔离**：新功能默认走**新入口 / 新模式**，让代码路径**结构性不可达**
  （正面例子：阶梯会话从"全局布尔开关"改成显式第 5 个模式，ADR-0036 §4）。
  双栈是同一思路在**运行环境**层的应用：靠结构隔离，不靠自觉。
- 路由复杂度棘轮同理（`scripts/verify-route-complexity.ts`）：受限文件不许增长，新端点另立薄文件。
  约束写在机器里，比写在文档里可靠。
