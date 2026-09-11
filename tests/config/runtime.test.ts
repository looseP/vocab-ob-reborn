import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/runtime";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:password@localhost:5432/vocab_test",
  OWNER_API_TOKEN: "owner-token-at-least-24-characters",
  LOCAL_OWNER_ID: "00000000-0000-4000-8000-000000000001",
  APP_ORIGIN: "http://localhost:3001",
};

describe("runtime configuration", () => {
  it("parses bounded defaults and booleans", () => {
    expect(loadRuntimeConfig({ ...base, TRUST_PROXY: "true" })).toMatchObject({
      PORT: 3001,
      TRUST_PROXY: true,
      DB_POOL_MAX: 10,
      SHUTDOWN_GRACE_MS: 25_000,
    });
  });

  it("normalizes empty optional values without weakening production separation", () => {
    expect(loadRuntimeConfig({
      ...base,
      APP_DATABASE_URL: "",
      METRICS_BEARER_TOKEN: "",
      AGENT_API_TOKENS: "",
      LLM_PROVIDER: "",
      LLM_MODEL: "",
      LLM_API_KEY: "",
      LLM_BASE_URL: "",
    })).toMatchObject({
      APP_DATABASE_URL: undefined,
      METRICS_BEARER_TOKEN: undefined,
      AGENT_API_TOKENS: undefined,
      LLM_PROVIDER: undefined,
      LLM_MODEL: undefined,
      LLM_API_KEY: undefined,
      LLM_BASE_URL: undefined,
    });
    expect(() => loadRuntimeConfig({
      ...base,
      NODE_ENV: "production",
      APP_DATABASE_URL: "",
      APP_ORIGIN: "https://vocab.example.com",
      METRICS_BEARER_TOKEN: "metrics-token-at-least-24-characters",
      DB_SSLMODE: "verify-full",
    })).toThrow(/APP_DATABASE_URL/);
  });

  it("requires distinct metrics credentials and HTTPS in production", () => {
    expect(() => loadRuntimeConfig({ ...base, NODE_ENV: "production" })).toThrow(/METRICS_BEARER_TOKEN|https/);
    expect(() => loadRuntimeConfig({
      ...base,
      NODE_ENV: "production",
      APP_ORIGIN: "https://vocab.example.com",
      METRICS_BEARER_TOKEN: base.OWNER_API_TOKEN,
    })).toThrow(/must differ/);
  });

  it("allows TLS-disabled database traffic only for the explicit isolated single-host topology", () => {
    expect(loadRuntimeConfig({
      ...base,
      NODE_ENV: "production",
      SINGLE_HOST_DEPLOYMENT: "true",
      APP_ORIGIN: "https://vocab.example.com",
      METRICS_BEARER_TOKEN: "metrics-token-at-least-24-characters",
      APP_DATABASE_URL: "postgresql://user:password@postgres:5432/vocab",
      DATABASE_URL: "postgresql://user:password@postgres:5432/vocab",
      DB_SSLMODE: "disable",
    })).toMatchObject({ SINGLE_HOST_DEPLOYMENT: true, DB_SSLMODE: "disable" });
    expect(() => loadRuntimeConfig({
      ...base,
      NODE_ENV: "production",
      SINGLE_HOST_DEPLOYMENT: "true",
      APP_ORIGIN: "https://vocab.example.com",
      METRICS_BEARER_TOKEN: "metrics-token-at-least-24-characters",
      APP_DATABASE_URL: "postgresql://user:password@postgres:5432/vocab",
      DATABASE_URL: "postgresql://user:password@postgres:5432/vocab",
      DB_SSLMODE: "verify-full",
    })).toThrow(/isolated in-Docker PostgreSQL/);
    expect(() => loadRuntimeConfig({
      ...base,
      NODE_ENV: "production",
      SINGLE_HOST_DEPLOYMENT: "true",
      APP_ORIGIN: "https://vocab.example.com",
      METRICS_BEARER_TOKEN: "metrics-token-at-least-24-characters",
      APP_DATABASE_URL: "postgresql://user:password@external-db.example:5432/vocab",
      DB_SSLMODE: "disable",
    })).toThrow(/internal postgres service/);
  });

  it("fails fast on malformed AGENT_API_TOKENS (ADR-0029 decision 5)", () => {
    expect(loadRuntimeConfig({ ...base, AGENT_API_TOKENS: "ci-runner:agent-secret-1" }))
      .toMatchObject({ AGENT_API_TOKENS: "ci-runner:agent-secret-1" });
    // legacy bare token：必须拒绝并提示迁移格式
    expect(() => loadRuntimeConfig({ ...base, AGENT_API_TOKENS: "legacy-bare-token" })).toThrow(/agentId:token/);
    expect(() => loadRuntimeConfig({ ...base, AGENT_API_TOKENS: "bot:1,bot:2" })).toThrow(/duplicate agentId/);
    expect(() => loadRuntimeConfig({ ...base, AGENT_API_TOKENS: `bot:${base.OWNER_API_TOKEN}` }))
      .toThrow(/must differ from OWNER_API_TOKEN/);
    expect(() => loadRuntimeConfig({ ...base, AGENT_API_TOKENS: "Bad_Id:token" })).toThrow(/AGENT_API_TOKENS/);
    expect(() => loadRuntimeConfig({ ...base, AGENT_API_TOKENS: "bot:" })).toThrow(/empty token/);
  });

  it("rejects invalid bounds and partial LLM configuration", () => {
    expect(() => loadRuntimeConfig({ ...base, DB_POOL_MAX: "0" })).toThrow(/DB_POOL_MAX/);
    expect(() => loadRuntimeConfig({ ...base, LLM_PROVIDER: "openai" })).toThrow(/LLM_MODEL/);
  });
});
