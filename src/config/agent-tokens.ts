/**
 * AGENT_API_TOKENS 解析与校验（ADR-0029 决策 5）。
 *
 * 格式：`id:token,id:token,...`
 * - 按**第一个** `:` 分割（token 本身为 hex/base64url，不允许再含 `:`）；
 * - agentId 约束 `^[a-z0-9][a-z0-9-]{0,31}$`；
 * - 每个条目必须**恰好一个**冒号、agentId 合法、token 非空、agentId 不重复；
 * - 任一 agent token 不得与 `OWNER_API_TOKEN` 相同。
 *
 * 任何违规都抛错：该函数是启动 fail-fast 与运行时解析的共用真源
 * （`src/config/runtime.ts` 在启动时调用；`src/http/middleware/auth.ts` 在解析
 * bearer 时调用）。裸 token（无冒号）是旧格式，必须显式拒绝并提示迁移，绝不静默降级。
 *
 * agentId 是**服务端认定**的信任锚，不是调用方自述字段。撤销语义 = 改 env 重启。
 */
export interface AgentTokenEntry {
  readonly agentId: string;
  readonly token: string;
}

/** agentId 词法：小写字母/数字开头，其后小写字母/数字/连字符，总长 1–32。 */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 专用错误类型，便于启动配置层与中间件区分"配置错误"与其它异常。 */
export class AgentTokenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTokenConfigError";
  }
}

/**
 * 解析 `AGENT_API_TOKENS`。空/未设置为合法（本机无 agent 接入）。
 * @param raw 环境变量原始值
 * @param ownerToken `OWNER_API_TOKEN`；提供时校验 agent token 与之不同
 */
export function parseAgentTokens(raw: string | undefined, ownerToken?: string): AgentTokenEntry[] {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return [];

  const entries: AgentTokenEntry[] = [];
  const seenAgentIds = new Set<string>();

  for (const rawEntry of trimmed.split(",")) {
    const entry = rawEntry.trim();
    if (entry === "") {
      throw new AgentTokenConfigError(
        "AGENT_API_TOKENS contains an empty entry; use comma-separated `agentId:token` pairs",
      );
    }
    const separator = entry.indexOf(":");
    if (separator === -1) {
      throw new AgentTokenConfigError(
        `AGENT_API_TOKENS entry "${entry}" is missing the agentId prefix; migrate bare tokens to the "agentId:token" format`,
      );
    }
    if (entry.indexOf(":", separator + 1) !== -1) {
      throw new AgentTokenConfigError(
        `AGENT_API_TOKENS entry "${entry}" contains more than one ":"; the token must be hex/base64url without colons`,
      );
    }
    const agentId = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    if (!AGENT_ID_PATTERN.test(agentId)) {
      throw new AgentTokenConfigError(
        `AGENT_API_TOKENS agentId "${agentId}" must match ${AGENT_ID_PATTERN.source}`,
      );
    }
    if (token === "") {
      throw new AgentTokenConfigError(`AGENT_API_TOKENS agentId "${agentId}" has an empty token`);
    }
    if (ownerToken && token === ownerToken) {
      throw new AgentTokenConfigError(
        `AGENT_API_TOKENS token for agentId "${agentId}" must differ from OWNER_API_TOKEN`,
      );
    }
    if (seenAgentIds.has(agentId)) {
      throw new AgentTokenConfigError(`AGENT_API_TOKENS contains duplicate agentId "${agentId}"`);
    }
    seenAgentIds.add(agentId);
    entries.push({ agentId, token });
  }

  return entries;
}
