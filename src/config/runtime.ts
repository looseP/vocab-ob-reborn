import { z } from "zod";

const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");
const integer = (minimum: number, maximum: number) => z.coerce.number().int().min(minimum).max(maximum);

const runtimeSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: integer(1, 65_535).default(3_001),
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  OWNER_API_TOKEN: z.string().min(24),
  METRICS_BEARER_TOKEN: z.string().min(24).optional(),
  LOCAL_OWNER_ID: z.string().uuid(),
  APP_ORIGIN: z.string().url(),
  TRUST_PROXY: booleanString.default(false),
  SERVE_FRONTEND: booleanString.default(false),
  READINESS_TIMEOUT_MS: integer(100, 10_000).default(500),
  SHUTDOWN_GRACE_MS: integer(1_000, 120_000).default(25_000),
  DB_POOL_MAX: integer(1, 100).default(10),
  DB_IDLE_TIMEOUT_MS: integer(1_000, 600_000).default(30_000),
  DB_CONNECT_TIMEOUT_MS: integer(100, 60_000).default(5_000),
  DB_KEEPALIVE_DELAY_MS: integer(0, 600_000).default(10_000),
  LOGIN_RATE_LIMIT_WINDOW_MS: integer(1_000, 3_600_000).default(60_000),
  LOGIN_RATE_LIMIT_ATTEMPTS: integer(1, 1_000).default(8),
  LLM_PROVIDER: z.enum(["openai", "anthropic"]).optional(),
  LLM_MODEL: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_TIMEOUT_MS: integer(1_000, 120_000).default(30_000),
  LLM_MAX_TOKENS: integer(1, 32_768).default(2_048),
  LLM_MAX_CONCURRENCY: integer(1, 100).default(4),
  DATAMUSE_ENABLED: booleanString.default(false),
}).superRefine((value, context) => {
  if (value.NODE_ENV === "production") {
    if (!value.METRICS_BEARER_TOKEN) {
      context.addIssue({ code: "custom", path: ["METRICS_BEARER_TOKEN"], message: "required in production" });
    }
    if (!value.APP_ORIGIN.startsWith("https://")) {
      context.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "must use https in production" });
    }
    if (value.METRICS_BEARER_TOKEN === value.OWNER_API_TOKEN) {
      context.addIssue({ code: "custom", path: ["METRICS_BEARER_TOKEN"], message: "must differ from OWNER_API_TOKEN" });
    }
  }
  if ((value.LLM_PROVIDER && !value.LLM_MODEL) || (!value.LLM_PROVIDER && value.LLM_MODEL)) {
    context.addIssue({ code: "custom", path: ["LLM_MODEL"], message: "LLM_PROVIDER and LLM_MODEL must be configured together" });
  }
});

export type RuntimeConfig = z.infer<typeof runtimeSchema>;

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = runtimeSchema.safeParse(environment);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid runtime configuration: ${details}`);
  }
  return parsed.data;
}
