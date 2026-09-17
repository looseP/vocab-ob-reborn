import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "../helpers/mock-db";

const mock = createMockPool({ recordTxControl: false });
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  checkPoolHealth: vi.fn(),
  resetPool: vi.fn(),
}));

import { createRepositories } from "@/index";

const SESSION_ROW = {
  id: "sess-1",
  user_id: "u1",
  type: "cram_pack",
  title: "Cram",
  plan: {
    version: 1,
    days: 2,
    seed: "seed-1",
    items: [
      { day: 1, contextIds: ["ctx-1"] },
      { day: 2, contextIds: ["ctx-2"] },
    ],
  },
  version: 1,
  status: "active",
  started_at: "2026-09-11T00:00:00Z",
  ended_at: null,
  created_at: "2026-09-11T00:00:00Z",
};

const PLAN = {
  version: 1,
  days: 2,
  seed: "seed-1",
  items: [
    { day: 1, contextIds: ["ctx-1"] },
    { day: 2, contextIds: ["ctx-2"] },
  ],
};

beforeEach(() => mock.reset());

describe("L3SessionRepository", () => {
  it("inserts a session with the plan as JSONB and returns the row", async () => {
    mock.setRows([SESSION_ROW]);
    const repos = createRepositories();

    const row = await repos.l3Sessions.insertSession({
      user_id: "u1",
      type: "cram_pack",
      title: "Cram",
      plan: PLAN,
      version: 1,
    });

    expect(row).toBe(SESSION_ROW);
    expect(mock.lastQuery?.text).toContain("INSERT INTO l3_sessions");
    expect(mock.lastQuery?.text).toContain("(user_id, type, title, plan, version)");
    expect(mock.lastQuery?.text).toContain("$4::jsonb");
    expect(mock.lastQuery?.text).toContain("RETURNING *");
    expect(mock.lastQuery?.params).toEqual(["u1", "cram_pack", "Cram", JSON.stringify(PLAN), 1]);

    const sql = mock.calls.map((call) => call.text).join("\n");
    expect(sql).not.toContain("user_word_progress");
    expect(sql).not.toContain("user_word_l2_progress");
    expect(sql).not.toContain("review_logs");
  });

  it("fails loudly when the session insert returns no row", async () => {
    mock.setRows([]);
    const repos = createRepositories();

    await expect(
      repos.l3Sessions.insertSession({ user_id: "u1", type: "knowledge", title: null, plan: PLAN, version: 1 }),
    ).rejects.toThrow("L3 session insert returned no row");
  });

  it("finds a session scoped to the owner", async () => {
    mock.setRows([SESSION_ROW]);
    const repos = createRepositories();

    const found = await repos.l3Sessions.findSessionByIdForUser("u1", "sess-1");

    expect(found).toBe(SESSION_ROW);
    expect(mock.lastQuery?.text).toContain("WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(mock.lastQuery?.params).toEqual(["sess-1", "u1"]);
  });

  it("updates status and stamps ended_at only when ended is true", async () => {
    mock.setRows([{ ...SESSION_ROW, status: "completed", ended_at: "2026-09-11T01:00:00Z" }]);
    const repos = createRepositories();

    const updated = await repos.l3Sessions.updateStatus("u1", "sess-1", "completed", { ended: true });

    expect(updated?.status).toBe("completed");
    expect(mock.lastQuery?.text).toContain("UPDATE l3_sessions");
    expect(mock.lastQuery?.text).toContain("ended_at = CASE WHEN $4::boolean THEN now() ELSE ended_at END");
    expect(mock.lastQuery?.params).toEqual(["sess-1", "u1", "completed", true]);

    await repos.l3Sessions.updateStatus("u1", "sess-1", "abandoned", { ended: false });
    expect(mock.lastQuery?.params).toEqual(["sess-1", "u1", "abandoned", false]);
  });

  it("samples context ids deterministically via md5(seed) with offset-free limit", async () => {
    mock.setRows([{ id: "ctx-1" }, { id: "ctx-2" }]);
    const repos = createRepositories();

    const ids = await repos.l3Sessions.sampleContextIds({ userId: "u1", limit: 10, seed: "seed-1" });

    expect(ids).toEqual(["ctx-1", "ctx-2"]);
    expect(mock.lastQuery?.text).toContain("FROM l3_contexts c");
    expect(mock.lastQuery?.text).toContain("JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id");
    expect(mock.lastQuery?.text).toContain("WHERE c.user_id = $1::uuid");
    // 确定性：偏移量由 seed 决定，同 seed 恒同顺序 / 同结果。
    expect(mock.lastQuery?.text).toContain("ORDER BY md5(c.id::text || $2)");
    expect(mock.lastQuery?.text).toContain("LIMIT $3");
    expect(mock.lastQuery?.params).toEqual(["u1", "seed-1", 10]);
  });

  it("applies the space/direction axes when sampling", async () => {
    mock.setRows([{ id: "ctx-9" }]);
    const repos = createRepositories();

    await repos.l3Sessions.sampleContextIds({
      userId: "u1",
      space: "阅读",
      direction: "考研",
      limit: 5,
      seed: "seed-2",
    });

    expect(mock.lastQuery?.text).toContain("AND EXISTS (SELECT 1 FROM l3_source_spaces sp");
    expect(mock.lastQuery?.text).toContain("sp.space = $2");
    expect(mock.lastQuery?.text).toContain("AND s.direction = $3");
    expect(mock.lastQuery?.text).toContain("ORDER BY md5(c.id::text || $4)");
    expect(mock.lastQuery?.text).toContain("LIMIT $5");
    expect(mock.lastQuery?.params).toEqual(["u1", "阅读", "考研", "seed-2", 5]);
  });

  it("returns an empty array for an empty id set without querying", async () => {
    const repos = createRepositories();

    const rows = await repos.l3Sessions.findContextsByIds("u1", []);

    expect(rows).toEqual([]);
    expect(mock.calls).toHaveLength(0);
  });

  it("loads context summaries by id scoped to the owner", async () => {
    mock.setRows([
      { id: "ctx-1", text: "A vivid context.", context_type: "sentence", source_id: "src-1", source_title: "Essay" },
    ]);
    const repos = createRepositories();

    const rows = await repos.l3Sessions.findContextsByIds("u1", ["ctx-1", "ctx-2"]);

    expect(rows[0]?.source_title).toBe("Essay");
    expect(mock.lastQuery?.text).toContain("WHERE c.user_id = $1::uuid AND c.id = ANY($2::uuid[])");
    expect(mock.lastQuery?.params).toEqual(["u1", ["ctx-1", "ctx-2"]]);
  });
});
