# Windows Docker Desktop 单机部署

本指南适用于一台 Windows 10/11 个人电脑，使用 Docker Desktop 的 WSL2/Linux containers 模式。本机模式的唯一目标是让该电脑上的浏览器通过 `https://localhost` 访问应用；它**不会**发布局域网或公网服务。

## 安全边界

- Caddy 是唯一映射到 Windows 宿主机的服务，并固定绑定 `127.0.0.1:80`、`127.0.0.1:443`。
- Web、PostgreSQL、worker 与备份服务没有宿主机端口。PostgreSQL 只能在 Docker 内部 `database` 网络访问。
- Caddy 使用内部 CA 为 `localhost` 签发 TLS 证书。应用继续以 production + HTTPS origin 运行，因此会话 Cookie、CSRF 和安全头保持生产约束。
- 五个镜像必须使用 `@sha256:` digest；真实 `.env`、数据库卷和备份都不能提交或放入 OneDrive 等同步目录。
- 不要将 `compose.single-host.yaml` 与 `compose.yaml` 或 `compose.production.yaml` 组合使用。

本机模式默认不暴露局域网或公网。若需要公网访问，使用本仓库的 Cloudflare Tunnel 覆盖层，而不是把 `127.0.0.1` 改成 `0.0.0.0`。局域网直连仍需单独评估。

## 0. Windows 前置条件

1. Docker Desktop 使用 **WSL2 backend** 和 **Linux containers**，并设置为登录后启动。
2. 在非同步磁盘创建目录：

```text
D:\vocab-observatory\app
D:\vocab-observatory\backups
D:\vocab-observatory\env
```

3. 将仓库或部署清单放入 `D:\vocab-observatory\app`，并确认 Docker Desktop 可访问 `D:`。
4. 真实 `.env` 仅放在 `D:\vocab-observatory\env\.env`；使用 NTFS ACL 限制为当前 Windows 账户和必要管理员读取。
5. 在 PowerShell 确认：

```powershell
docker version
docker compose version
```

## 1. 准备环境文件

在 PowerShell 中执行：

```powershell
Copy-Item .env.single-host.example D:\vocab-observatory\env\.env
notepad D:\vocab-observatory\env\.env
```

必须替换所有镜像 digest 与密码/token 占位符，并保留以下本机默认值：

```dotenv
CADDY_SITE_ADDRESS=localhost
APP_ORIGIN=https://localhost
CADDY_HTTP_BIND_ADDRESS=127.0.0.1
CADDY_HTTPS_BIND_ADDRESS=127.0.0.1
CADDY_CONFIG_FILE=D:/vocab-observatory/app/Caddyfile
BACKUP_HOST_DIR=D:/vocab-observatory/backups
```

Windows bind mount 路径必须使用绝对路径和正斜杠，例如 `D:/vocab-observatory/backups`。不要使用 Linux 的 `/srv/...` 路径，也不要将备份目录设在仓库、临时目录或同步盘。

先仅渲染配置，不启动容器：

```powershell
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml config --quiet
```

渲染失败时先修正路径或缺失变量；不要删除数据库卷来“解决”配置问题。

## 2. 首次启动与本机验证

```powershell
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml pull
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml up -d --wait
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml ps
```

确认发布面只有 Caddy：

```powershell
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml port caddy 80
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml port caddy 443
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml port web 3001
```

最后一条必须失败。也可用下列命令确认 Windows 没有监听 PostgreSQL：

```powershell
Get-NetTCPConnection -LocalPort 5432 -ErrorAction SilentlyContinue
```

Caddy 会为 `localhost` 创建内部 CA。首次启动后导出根证书，再由当前用户导入 Windows 的受信任根证书存储：

```powershell
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml cp caddy:/data/caddy/pki/authorities/local/root.crt D:\vocab-observatory\env\caddy-local-root.crt
Import-Certificate -FilePath D:\vocab-observatory\env\caddy-local-root.crt -CertStoreLocation Cert:\CurrentUser\Root
```

仅信任这台电脑上运行的 Caddy 根证书；不要把它复制给不受控设备。随后在该 Windows 主机浏览器访问 `https://localhost`，并验证：

```powershell
Invoke-WebRequest https://localhost/healthz
Invoke-WebRequest https://localhost/readyz
```

如果证书目录与上例不一致，先执行 `docker compose ... logs caddy` 确认 Caddy 已初始化，而不要绕过 TLS 或把应用改为 HTTP。

## 3. 可选：通过 Cloudflare Tunnel 公网访问

仅在本机模式、备份和恢复验证均完成后启用。本模式不发布 Windows 的 80/443 端口：`cloudflared` 主动建立到 Cloudflare 的出站连接，并且只连接 Docker 的 `public` 网络中的 Caddy；它不接入 `app` 或 `database` 网络。

1. 在 Cloudflare Zero Trust 创建 named tunnel 和 public hostname，并将 hostname 的 service 设置为：

```text
http://caddy:80
```

2. 为该 hostname 创建 Cloudflare Access 应用和策略，只允许你的身份；不要依赖“隐藏 URL”或只依赖应用 owner token。
3. 将 `.env.cloudflare-tunnel.example` 中的三项内容复制到同一未跟踪 `D:\vocab-observatory\env\.env`：
   - 已审核的 `CLOUDFLARED_IMAGE` digest；
   - `CLOUDFLARE_TUNNEL_TOKEN`；
   - 与公开 hostname 一致的 `CADDY_SITE_ADDRESS`、`APP_ORIGIN` 和 `CADDY_CONFIG_FILE=./Caddyfile.cloudflare-tunnel`。
4. 从仓库根目录使用基础文件加覆盖层启动：

```powershell
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml -f compose.cloudflare-tunnel.yaml config --quiet
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml -f compose.cloudflare-tunnel.yaml pull
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml -f compose.cloudflare-tunnel.yaml up -d --wait
```

5. 在 Cloudflare Access 身份验证后，通过公开域名验证 `/healthz`、`/readyz` 和登录流程。再确认以下命令不返回 Caddy、Web 或 PostgreSQL 的宿主机端口：

```powershell
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml -f compose.cloudflare-tunnel.yaml port caddy 443
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml -f compose.cloudflare-tunnel.yaml port web 3001
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml -f compose.cloudflare-tunnel.yaml port postgres 5432
```

以上三个端口查询在 Tunnel 模式都应失败；公网入口只存在于 Cloudflare。回退时停止带覆盖层的 Compose 项目，移除或禁用 Cloudflare public hostname，再用仅 `compose.single-host.yaml` 的本机模式启动。不要把 Tunnel token、Access service token、日志中可能出现的认证头提交到 Git。

## 4. 备份、恢复、更新与回滚

备份任务按 `BACKUP_INTERVAL_MS` 写入 `D:\vocab-observatory\backups`。每次升级前手动创建一份：

```powershell
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml exec backup-scheduler ./node_modules/.bin/tsx scripts/postgres-backup.ts create
```

至少每周将最新备份复制到加密外接盘或可信加密云盘；同一 Windows 磁盘上的备份不是灾备。每月至少按 `docs/operations/postgresql-backup-recovery.md` 在隔离 Docker 数据卷恢复一次，绝不直接覆盖正在使用的数据库。

升级时先记录并备份当前 `.env`，然后将五个镜像 digest 同步替换为同一已验证版本：

```powershell
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml config --quiet
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml pull
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml up -d --wait
Invoke-WebRequest https://localhost/readyz
```

健康检查失败时停止继续操作，将五个 digest 全部恢复到上一组已验证值，再执行 `pull` 与 `up -d --wait`。数据库迁移可能不可逆；不要在未做隔离恢复验证前删除 `postgres-data` 卷或盲目回滚应用。

## 5. 日常检查与 Windows 重启

```powershell
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml logs --tail=200 web caddy
docker compose --env-file D:\vocab-observatory\env\.env -f compose.single-host.yaml ps
Get-ChildItem D:\vocab-observatory\backups
```

Docker Desktop 启动后，服务的 `restart: unless-stopped` 会恢复长期运行的容器；迁移服务会在需要的依赖链中完成后退出。重启 Windows 或 Docker Desktop 后再次检查 `ps` 和 `https://localhost/readyz`。不要让 Windows 睡眠、关闭 Docker Desktop 或清理 Docker 卷后期待服务仍可用。
