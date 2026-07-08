# I1: PostgreSQL 5432 端口被 wslrelay 占用

## 问题现象

启动 Docker PostgreSQL 容器时报 `ports are not available: exposing port TCP 127.0.0.1:5432`。

## 根因分析

本机 WSL 的端口转发进程 `wslrelay.exe`（PID 30656）占用了 5432 端口，但它实际不接受 TCP 连接（`Connection refused`）。这是一个"幽灵占用"——端口被 WSL relay 占了但没有真正可用的 PG 服务。

## 解决方案

将 Docker 容器端口映射改为 5434（避开冲突），同步更新 `.env.local`：

```yaml
# docker-compose.yml
ports:
  - "127.0.0.1:5434:5432"  # 宿主机 5434 → 容器 5432
```

```env
# .env.local
DATABASE_URL=postgresql://vocab:vocab@localhost:5434/vocab
```

## 验证方式

- `docker compose up -d postgres` 成功启动
- `docker exec vocab-db pg_isready -h 127.0.0.1 -U vocab` 返回 accepting
- 集成测试用 5434 端口连接成功

## 注意

这是环境特定的解决方案。如果 5432 端口后来释放了，可以改回 5432。不影响代码逻辑（端口只影响连接串）。
