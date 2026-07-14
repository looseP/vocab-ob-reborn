# 单机 Docker Compose 部署

本指南适用于个人自用的一台 Linux 主机。目标是最小但安全的运行基线：Caddy 仅暴露 80/443，应用与 PostgreSQL 只在 Docker 内部网络通信；Caddy 只能访问 Web，Web 与后台服务才能访问数据库，数据库有本机持久卷，逻辑备份写入宿主机目录。

## 边界

- 这不是多主机高可用方案；主机不可用时服务不可用。
- PostgreSQL 没有映射宿主机端口，不能从公网直接访问。
- Caddy 使用公网 DNS 和 ACME 自动申请 TLS 证书；必须先将域名的 A/AAAA 记录指向主机。
- 不要将 `compose.single-host.yaml` 与 `compose.yaml` 或 `compose.production.yaml` 组合使用。

## 0. 主机前置条件

1. 使用受支持的 Linux 发行版，安装 Docker Engine 与 Compose plugin。
2. SSH 仅允许密钥登录；关闭 root 与密码登录；防火墙仅放行 22、80、443（若 SSH 使用其他端口则相应替换）。
3. 确保 80/443 未被其他反向代理占用，且域名解析已生效。
4. 为服务创建目录并限制权限：

```bash
sudo install -d -m 700 -o "$USER" -g "$USER" /srv/vocab-observatory
sudo install -d -m 700 -o "$USER" -g "$USER" /srv/vocab-observatory/backups
```

## 1. 准备部署文件

在受限目录中放置以下文件：

- `compose.single-host.yaml`
- `Caddyfile`
- `.env`（由 `.env.single-host.example` 复制后填写）

`.env` 必须使用真实值并限制权限：

```bash
cp .env.single-host.example .env
chmod 600 .env
```

要求：

- 五个镜像（应用、迁移、备份、Caddy、PostgreSQL）均使用 `@sha256:` digest，不使用 `latest` 或可变 tag。Caddy 与 PostgreSQL digest 应从经审核的目标 release 解析后填入。
- `APP_ORIGIN` 必须为 `https://` URL；`CADDY_SITE_ADDRESS` 为同一域名。`SINGLE_HOST_DEPLOYMENT=true` 仅用于此配置：它允许 Web 到内部 `postgres` 服务的非 TLS Docker 网络连接；不得用于外部数据库或跨主机拓扑。
- `BACKUP_HOST_DIR` 必须是绝对路径，不应位于仓库或 Docker 临时目录。
- `POSTGRES_PASSWORD`、API token 与 `BACKUP_SIGNING_KEY` 必须各自独立且随机。
- 若未启用 LLM，保持全部 LLM 变量为空。

先进行无启动渲染，确认变量没有遗漏：

```bash
docker compose --env-file .env -f compose.single-host.yaml config --quiet
```

## 2. 首次启动

先拉取固定镜像，然后启动。迁移服务必须以退出码 0 完成，其他依赖服务才会启动：

```bash
docker compose --env-file .env -f compose.single-host.yaml pull
docker compose --env-file .env -f compose.single-host.yaml up -d --wait
```

验证内部服务与公网入口：

```bash
docker compose --env-file .env -f compose.single-host.yaml ps
curl --fail --silent --show-error https://YOUR_DOMAIN/healthz
curl --fail --silent --show-error https://YOUR_DOMAIN/readyz
```

确认暴露面仅含 Caddy：

```bash
docker compose --env-file .env -f compose.single-host.yaml port caddy 80
docker compose --env-file .env -f compose.single-host.yaml port caddy 443
# 下列命令应失败；web/postgres 不应有发布端口。
docker compose --env-file .env -f compose.single-host.yaml port web 3001
```

## 3. 日常备份与恢复验证

`backup-scheduler` 按 `BACKUP_INTERVAL_MS` 创建签名逻辑备份，并按保留数量清理本机旧副本。至少每周复制最新备份到脱离主机的位置；单机本地目录不是灾备。

每次升级前：

```bash
docker compose --env-file .env -f compose.single-host.yaml exec backup-scheduler \
  ./node_modules/.bin/tsx scripts/postgres-backup.ts create
```

每月至少做一次恢复演练，按 `docs/operations/postgresql-backup-recovery.md` 在隔离数据库执行。不要在运行中的生产数据库上直接恢复。

## 4. 更新与回滚

1. 保留当前 `.env` 的受限备份，并先执行一份数据库备份。
2. 将 `.env` 中五项镜像 digest 一并更新到同一已验证版本。
3. 运行 `config --quiet`、`pull`、`up -d --wait`，然后检查 `/readyz`。
4. 若迁移、健康检查或 smoke 验证失败，停止继续操作；把五项镜像 digest 恢复为上一版本，执行：

```bash
docker compose --env-file .env -f compose.single-host.yaml pull
docker compose --env-file .env -f compose.single-host.yaml up -d --wait
```

数据库迁移可能不可逆。遇到不兼容迁移时，先从升级前备份在隔离环境恢复并确认，而不是直接回滚应用容器。

## 5. 故障排查与日常检查

```bash
docker compose --env-file .env -f compose.single-host.yaml logs --tail=200 web caddy
docker compose --env-file .env -f compose.single-host.yaml ps
df -h /srv/vocab-observatory/backups
docker compose --env-file .env -f compose.single-host.yaml exec postgres \
  pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

不要将 PostgreSQL、容器日志、`.env` 或备份签名密钥暴露到公网或提交到 Git。
