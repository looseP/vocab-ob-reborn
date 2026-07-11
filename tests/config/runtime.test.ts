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

  it("requires distinct metrics credentials and HTTPS in production", () => {
    expect(() => loadRuntimeConfig({ ...base, NODE_ENV: "production" })).toThrow(/METRICS_BEARER_TOKEN|https/);
    expect(() => loadRuntimeConfig({
      ...base,
      NODE_ENV: "production",
      APP_ORIGIN: "https://vocab.example.com",
      METRICS_BEARER_TOKEN: base.OWNER_API_TOKEN,
    })).toThrow(/must differ/);
  });

  it("rejects invalid bounds and partial LLM configuration", () => {
    expect(() => loadRuntimeConfig({ ...base, DB_POOL_MAX: "0" })).toThrow(/DB_POOL_MAX/);
    expect(() => loadRuntimeConfig({ ...base, LLM_PROVIDER: "openai" })).toThrow(/LLM_MODEL/);
  });
});
