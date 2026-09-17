# Secret rotation

## Secret inventory

| Secret | Environment variable | Consumer | Rotation frequency |
|--------|---------------------|----------|-------------------|
| Owner API token | `OWNER_API_TOKEN` | Web process (owner bearer + browser session exchange) | Quarterly or after incident |
| Agent API tokens | `AGENT_API_TOKENS` | Web process (agent bearer) | Quarterly or after incident |
| Metrics bearer token | `METRICS_BEARER_TOKEN` | Web process, smoke, drill | Quarterly or after incident |
| Database password (owner) | `POSTGRES_PASSWORD` | PostgreSQL container | Quarterly |
| App database URL | `APP_DATABASE_URL` | Web process | Quarterly or after role change |
| Worker database URL | `WORKER_DATABASE_URL` | Outbox worker, LLM reaper | Quarterly or after role change |
| Backup database URL | `BACKUP_DATABASE_URL` | Backup scheduler | Quarterly or after role change |
| Migration database URL | `MIGRATION_DATABASE_URL` | Migration one-shot job | Quarterly or after role change |
| Lifecycle database URL | `DATA_LIFECYCLE_DATABASE_URL` | Data lifecycle one-shot job | Quarterly or after role change |
| Backup signing key | `BACKUP_SIGNING_KEY` | Backup scheduler | Semi-annually or after incident |
| LLM API key | `LLM_API_KEY` | LLM provider client | Per provider policy |
| Alertmanager receiver URLs | `/run/secrets/alertmanager_*` | Alertmanager | Semi-annually or after incident |

## Secret manager integration

All secrets must be injected at runtime from the deployment secret manager. Never bake secrets into container images, CI artifacts, or `.env` files committed to the repository.

### Supported injection patterns

1. **Environment variables**: Set directly on the container or via an env-file mounted from the secret manager.
2. **File-based secrets**: Mount secret files under `/run/secrets/` and reference them by path (Alertmanager `url_file` pattern).
3. **External secret operator**: Use the platform's secret operator (e.g., Kubernetes Sealed Secrets, AWS Secrets Manager CSI, HashiCorp Vault Agent) to sync secrets into the runtime environment.

### What the repository does NOT store

- Real database passwords, API tokens, or signing keys.
- Alertmanager receiver webhook URLs or chat channel identifiers.
- TLS private keys or CA certificates.
- GitHub personal access tokens or deploy keys.

## Rotation procedure

### 1. Database role passwords

```text
# In the managed database control plane:
ALTER ROLE app_role WITH PASSWORD '<new-password>';
ALTER ROLE worker_role WITH PASSWORD '<new-password>';
ALTER ROLE backup_role WITH PASSWORD '<new-password>';
ALTER ROLE migration_role WITH PASSWORD '<new-password>';
```

Update the secret manager entries for `APP_DATABASE_URL`, `WORKER_DATABASE_URL`, `BACKUP_DATABASE_URL`, and `MIGRATION_DATABASE_URL` with the new passwords.

Rolling-restart the affected services. The old password becomes invalid immediately; ensure all replicas are restarted before the next rotation.

### 2. Owner API token, agent API tokens and metrics token

**Token 语义（ADR-0029）**

- `OWNER_API_TOKEN`：**只给人**（浏览器会话兑换 + 命令行），拥有全部权限（角色 `owner`）。
- `AGENT_API_TOKENS`：给外部 Agent / MCP 桥使用，格式为 `agentId:token,agentId:token,...`。
  - `agentId` 是**服务端认定**的信任锚，形如 `^[a-z0-9][a-z0-9-]{0,31}$`（如 `ci-runner`）；它不是调用方自述字段。
  - `token` 为 hex/base64url，**不含冒号**；按**第一个** `:` 分割，且每个条目必须**恰好一个**冒号。
  - agent 角色为 `agent`：可读全量语料、可写 proposal；**升级动作（confirm / accept / validate / apply / restore 等）一律 403**。
- `METRICS_BEARER_TOKEN`：仅 `/metrics`（Prometheus）使用，与上面两者完全独立。

**启动 fail-fast**（任一违规即拒启，不静默降级）：

- 旧格式裸 token（无 `:`）→ 拒启并提示迁移为 `agentId:token`；
- `agentId` 不匹配词法、token 为空、`agentId` 重复 → 拒启；
- 任一 agent token 与 `OWNER_API_TOKEN` 相同 → 拒启。

**轮换步骤**

1. 生成新 token（最小 24 字符，密码学随机）；为每个 Agent 分配稳定的 `agentId`。
2. 更新 secret manager 条目（`AGENT_API_TOKENS` 为整体字符串，按 `agentId:token` 拼接）。
3. Rolling-restart web 进程。
4. 更新外部消费者（smoke 脚本、drill 工具）使用新的 metrics token / agent token。
5. 验证旧 token 被拒绝；撤销 = 从 `AGENT_API_TOKENS` 移除对应 `agentId:token` 并重启（与设备会话对称）。

### 3. Backup signing key

1. Generate a new signing key.
2. Update `BACKUP_SIGNING_KEY` in the secret manager.
3. Rolling-restart the backup scheduler.
4. New backups will be signed with the new key; existing backups retain the old signature.
5. Verify the HMAC manifest of the next backup cycle.

### 4. LLM API key

1. Obtain a new key from the LLM provider.
2. Update `LLM_API_KEY` in the secret manager.
3. Rolling-restart the web process.
4. Revoke the old key at the provider.
5. Verify a test draft generation succeeds.

### 5. Alertmanager receiver URLs

1. Rotate the webhook URL at the receiver (PagerDuty, Slack, etc.).
2. Update the secret file at `/run/secrets/alertmanager_*_webhook_url`.
3. Reload or restart Alertmanager.
4. Run a staging drill to verify delivery.

## GitHub credentials

The repository remote must not contain embedded personal access tokens. Use SSH or a git credential helper with short-lived tokens. If a PAT was ever embedded in the remote URL, treat it as compromised:

1. Revoke the token immediately at GitHub Settings > Developer settings > Personal access tokens.
2. Remove the token from the git remote URL:
   ```sh
   git remote set-url origin https://github.com/<owner>/<repo>.git
   ```
3. Audit git logs and CI for unintended exposure.
4. Use `gh auth login` or a credential helper for future authentication.

## Verification

After any rotation:
- Run `npm run release:smoke` against the staging environment.
- Verify `/readyz` returns 200.
- Verify the metrics endpoint returns expected content with the new token.
- For database password rotations, verify a test review session and outbox processing cycle.
- For backup key rotations, verify the next backup manifest HMAC.
