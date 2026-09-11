import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";
import { createMockPool } from "../helpers/mock-db";

const mock = createMockPool({ recordTxControl: false });
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  checkPoolHealth: vi.fn(),
  resetPool: vi.fn(),
}));

import { createRepositories, withTransaction } from "@/index";
import { BusinessRuleError } from "@/errors";

const ATTEMPT_ROW = {
  id: "att-1",
  user_id: "u1",
  context_id: "ctx-1",
  occurrence_id: null,
  session_id: null,
  practice_type: "essay_dictation",
  outcome: "wrong",
  payload: { taskId: "essay_dictation:aaaaaaaaaaaaaaaa" },
  created_at: "2026-09-11T00:00:00Z",
};

beforeEach(() => mock.reset());

describe("L3PracticeRepository", () => {
  it("inserts an attempt into l3_practice_attempts only, never FSRS tables", async () => {
    mock.setRows([ATTEMPT_ROW]);
    const repos = createRepositories();

    const row = await repos.l3Practice.insertAttempt({
      user_id: "u1",
      context_id: "ctx-1",
      occurrence_id: null,
      session_id: null,
      practice_type: "essay_dictation",
      outcome: "wrong",
      payload: { taskId: "essay_dictation:aaaaaaaaaaaaaaaa" },
    });

    expect(row).toBe(ATTEMPT_ROW);
    expect(mock.lastQuery?.text).toContain("INSERT INTO l3_practice_attempts");
    expect(mock.lastQuery?.text).toContain(
      "(user_id, context_id, occurrence_id, session_id, practice_type, outcome, payload)",
    );
    expect(mock.lastQuery?.text).toContain("RETURNING *");
    expect(mock.lastQuery?.params).toEqual([
      "u1",
      "ctx-1",
      null,
      null,
      "essay_dictation",
      "wrong",
      JSON.stringify({ taskId: "essay_dictation:aaaaaaaaaaaaaaaa" }),
    ]);

    const sql = mock.calls.map((call) => call.text).join("\n");
    expect(sql).not.toContain("user_word_progress");
    expect(sql).not.toContain("user_word_l2_progress");
    expect(sql).not.toContain("review_logs");
  });

  it("keeps occurrence/session ids and defaults a null payload to an empty object", async () => {
    mock.setRows([ATTEMPT_ROW]);
    const repos = createRepositories();

    await repos.l3Practice.insertAttempt({
      user_id: "u1",
      context_id: "ctx-1",
      occurrence_id: "occ-1",
      session_id: "sess-1",
      practice_type: "context_quiz",
      outcome: "skip",
      payload: null,
    });

    expect(mock.lastQuery?.params).toEqual([
      "u1",
      "ctx-1",
      "occ-1",
      "sess-1",
      "context_quiz",
      "skip",
      "{}",
    ]);
  });

  it("fails loudly when the insert returns no row", async () => {
    mock.setRows([]);
    const repos = createRepositories();

    await expect(
      repos.l3Practice.insertAttempt({
        user_id: "u1",
        context_id: "ctx-1",
        occurrence_id: null,
        session_id: null,
        practice_type: "essay_dictation",
        outcome: "correct",
        payload: { taskId: "t-1" },
      }),
    ).rejects.toThrow("L3 practice attempt insert returned no row");
  });

  it("finds an attempt by owner + payload taskId (idempotency identity)", async () => {
    mock.setRows([ATTEMPT_ROW]);
    const repos = createRepositories();

    const found = await repos.l3Practice.findAttemptByTaskId("u1", "essay_dictation:aaaaaaaaaaaaaaaa");

    expect(found).toBe(ATTEMPT_ROW);
    expect(mock.lastQuery?.text).toContain("payload->>'taskId' = $2");
    expect(mock.lastQuery?.text).toContain("WHERE user_id = $1::uuid");
    expect(mock.lastQuery?.params).toEqual(["u1", "essay_dictation:aaaaaaaaaaaaaaaa"]);
  });

  it("takes a taskId-scoped advisory lock inside a transaction", async () => {
    const locked = await withTransaction(async (tx) => {
      const repos = createRepositories(tx);
      await repos.l3Practice.lockAttemptIdentity("u1", "t-1");
      return true;
    });

    expect(locked).toBe(true);
    const lockCall = mock.calls.find((call) => call.text.includes("pg_advisory_xact_lock"));
    expect(lockCall?.text).toContain("pg_advisory_xact_lock(hashtext($1), hashtext($2))");
    expect(lockCall?.params).toEqual(["u1", "t-1"]);
  });

  it("refuses the advisory lock outside a transaction", async () => {
    const repos = createRepositories();

    await expect(repos.l3Practice.lockAttemptIdentity("u1", "t-1")).rejects.toBeInstanceOf(
      BusinessRuleError,
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("lists attempts by owner with offset pagination defaults", async () => {
    mock.setRowMap({
      "SELECT a.*": [ATTEMPT_ROW],
      "SELECT count(*)": [{ total: "1" }],
    });
    const repos = createRepositories();

    const page = await repos.l3Practice.listAttempts({ userId: "u1", limit: 10, offset: 0 });

    expect(page).toEqual({ items: [ATTEMPT_ROW], total: 1, limit: 10, offset: 0 });
    const listCall = mock.calls.find((call) => call.text.includes("SELECT a.*"));
    expect(listCall?.text).toContain("FROM l3_practice_attempts a");
    expect(listCall?.text).toContain("JOIN l3_contexts c ON c.id = a.context_id AND c.user_id = a.user_id");
    expect(listCall?.text).toContain("LEFT JOIN l3_sources s ON s.id = c.source_id AND s.user_id = c.user_id");
    expect(listCall?.text).toContain("WHERE a.user_id = $1::uuid");
    expect(listCall?.text).toContain("LIMIT $2 OFFSET $3");
    expect(listCall?.params).toEqual(["u1", 10, 0]);
  });

  it("applies the practiceType/outcome/space/direction filters in one bounded query", async () => {
    mock.setRowMap({
      "SELECT a.*": [ATTEMPT_ROW],
      "SELECT count(*)": [{ total: "7" }],
    });
    const repos = createRepositories();

    const page = await repos.l3Practice.listAttempts({
      userId: "u1",
      practiceType: "context_quiz",
      outcome: "wrong",
      space: "阅读",
      direction: "考研",
      limit: 5,
      offset: 10,
    });

    expect(page.total).toBe(7);
    const listCall = mock.calls.find((call) => call.text.includes("SELECT a.*"));
    expect(listCall?.text).toContain("AND a.practice_type = $2");
    expect(listCall?.text).toContain("AND a.outcome = $3");
    expect(listCall?.text).toContain("AND EXISTS (SELECT 1 FROM l3_source_spaces sp");
    expect(listCall?.text).toContain("sp.space = $4");
    expect(listCall?.text).toContain("AND s.direction = $5");
    expect(listCall?.text).toContain("LIMIT $6 OFFSET $7");
    expect(listCall?.params).toEqual(["u1", "context_quiz", "wrong", "阅读", "考研", 5, 10]);
  });

  it("reports zero total when the count query returns no row", async () => {
    mock.setRowMap({
      "SELECT a.*": [],
      "SELECT count(*)": [],
    });
    const repos = createRepositories();

    const page = await repos.l3Practice.listAttempts({ userId: "u1", limit: 20, offset: 0 });

    expect(page).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  });

  it("derives the error book by forcing outcome='wrong' (no second source of truth)", async () => {
    mock.setRowMap({
      "SELECT a.*": [ATTEMPT_ROW],
      "SELECT count(*)": [{ total: "1" }],
    });
    const repos = createRepositories();

    await repos.l3Practice.listWrongAttempts({
      userId: "u1",
      outcome: "correct",
      limit: 10,
      offset: 0,
    });

    const listCall = mock.calls.find((call) => call.text.includes("SELECT a.*"));
    expect(listCall?.text).toContain("AND a.outcome = $2");
    expect(listCall?.params[1]).toBe("wrong");
    expect(mock.calls.map((call) => call.text).join("\n")).not.toContain("INSERT");
  });

  it("exposes the registered l3Practice repository through the factory", () => {
    const repos = createRepositories({} as PoolClient);
    expect(typeof repos.l3Practice.insertAttempt).toBe("function");
    expect(typeof repos.l3Practice.listWrongAttempts).toBe("function");
  });
});
