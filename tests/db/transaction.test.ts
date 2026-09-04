import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockPool } from "../helpers/mock-db";

const mock = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
}));

import { withTransaction } from "@/db/transaction";

const ACTOR_A = "00000000-0000-4000-8000-000000000011";
const ACTOR_B = "00000000-0000-4000-8000-000000000021";

describe("withTransaction RLS actor propagation", () => {
  beforeEach(() => mock.reset());

  it("sets a transaction-local RLS claim after BEGIN and before callback queries", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await withTransaction(async (tx) => {
        await tx.query("SELECT current_setting('request.jwt.claim.sub', true)");
      }, { actorId: ACTOR_A });

      expect(mock.calls).toEqual([
        { text: "BEGIN", params: [] },
        {
          text: "SELECT set_config('request.jwt.claim.sub', $1, true)",
          params: [ACTOR_A],
        },
        { text: "SELECT current_setting('request.jwt.claim.sub', true)", params: [] },
        { text: "COMMIT", params: [] },
      ]);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("does not project an actor into infrastructure transactions", async () => {
    await withTransaction(async (tx) => {
      await tx.query("SELECT 1");
    });

    expect(mock.calls).toEqual([
      { text: "BEGIN", params: [] },
      { text: "SELECT 1", params: [] },
      { text: "COMMIT", params: [] },
    ]);
  });

  it("projects a UUID actor in test mode so the RLS contract matches production", async () => {
    await withTransaction(async () => undefined, { actorId: ACTOR_A });

    expect(mock.calls).toEqual([
      { text: "BEGIN", params: [] },
      {
        text: "SELECT set_config('request.jwt.claim.sub', $1, true)",
        params: [ACTOR_A],
      },
      { text: "COMMIT", params: [] },
    ]);
  });

  it("does not leak actor A into a later pooled transaction for actor B", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await withTransaction(async () => undefined, { actorId: ACTOR_A });
      await withTransaction(async () => undefined, { actorId: ACTOR_B });

      expect(mock.calls.filter((call) => call.text.includes("set_config"))).toEqual([
        {
          text: "SELECT set_config('request.jwt.claim.sub', $1, true)",
          params: [ACTOR_A],
        },
        {
          text: "SELECT set_config('request.jwt.claim.sub', $1, true)",
          params: [ACTOR_B],
        },
      ]);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("rejects malformed actors before acquiring a pool client in every environment", async () => {
    await expect(withTransaction(async () => undefined, { actorId: "untrusted-header" }))
      .rejects.toThrow("Transaction actorId must be a UUID");
    expect(mock.pool.connect).not.toHaveBeenCalled();
  });

  it("rolls back an actor transaction when the callback fails", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(withTransaction(async () => {
        throw new Error("stop");
      }, { actorId: ACTOR_A })).rejects.toThrow("stop");

      expect(mock.calls.map((call) => call.text)).toEqual([
        "BEGIN",
        "SELECT set_config('request.jwt.claim.sub', $1, true)",
        "ROLLBACK",
      ]);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });
});
