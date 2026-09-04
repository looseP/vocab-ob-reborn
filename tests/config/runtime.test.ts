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
      LLM_PROVIDER: "",
      LLM_MODEL: "",
      LLM_API_KEY: "",
      LLM_BASE_URL: "",
    })).toMatchObject({
      APP_DATABASE_URL: undefined,
      METRICS_BEARER_TOKEN: undefined,
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

  it("rejects invalid bounds and partial LLM configuration", () => {
    expect(() => loadRuntimeConfig({ ...base, DB_POOL_MAX: "0" })).toThrow(/DB_POOL_MAX/);
    expect(() => loadRuntimeConfig({ ...base, LLM_PROVIDER: "openai" })).toThrow(/LLM_MODEL/);
  });
});
