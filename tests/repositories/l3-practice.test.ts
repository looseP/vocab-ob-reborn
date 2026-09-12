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
import { decodeCursor, encodeCursor } from "@/repositories/l3-cursor";
import { BusinessRuleError, ValidationError } from "@/errors";

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

/** 错题库 SQL 行：attempt 行 + 语境级聚合列（snake_case 透出，仓库映射为 camelCase）。 */
const WRONG_ROW_ENRICHED = {
  ...ATTEMPT_ROW,
  wrong_count: 2,
  latest_outcome: "correct",
  latest_at: "2026-09-12T03:00:00Z",
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

  it("derives the error book by forcing outcome='wrong' with server-side context aggregation", async () => {
    mock.setRowMap({
      "SELECT a.*, agg.wrong_count": [WRONG_ROW_ENRICHED],
      "SELECT count(*)": [{ total: "1" }],
    });
    const repos = createRepositories();

    const page = await repos.l3Practice.listWrongAttempts({
      userId: "u1",
      outcome: "correct",
      limit: 10,
      offset: 0,
    });

    // 入参 outcome='correct' 被忽略（错题口径唯一）；聚合字段由服务端给出。
    expect(page.items[0]).toEqual({
      ...ATTEMPT_ROW,
      wrongCount: 2,
      latestOutcome: "correct",
      latestAt: "2026-09-12T03:00:00Z",
    });
    expect(page.nextCursor).toBeNull();
    const listCall = mock.calls.find((call) => call.text.includes("SELECT a.*"));
    expect(listCall?.text).toContain("AND a.outcome = $2");
    expect(listCall?.params[1]).toBe("wrong");
    expect(listCall?.text).toContain("JOIN LATERAL");
    expect(listCall?.text).toContain("count(*) FILTER (WHERE w.outcome = 'wrong')");
    expect(listCall?.text).toContain("array_agg(w.outcome ORDER BY w.created_at DESC, w.id DESC)");
    expect(listCall?.text).toContain("array_agg(w.created_at ORDER BY w.created_at DESC, w.id DESC)");
    expect(listCall?.text).toContain("w.user_id = a.user_id AND w.context_id = a.context_id");
    expect(mock.calls.map((call) => call.text).join("\n")).not.toContain("INSERT");
  });

  it("aggregates wrongCount over the whole context history, beyond any page window", async () => {
    // 语境历史 130 条 wrong（远超任何回看窗口）：条目 wrongCount/total 必须为 130。
    mock.setRowMap({
      "SELECT a.*, agg.wrong_count": [{ ...WRONG_ROW_ENRICHED, wrong_count: 130 }],
      "SELECT count(*)": [{ total: "130" }],
    });
    const repos = createRepositories();

    const page = await repos.l3Practice.listWrongAttempts({ userId: "u1", limit: 20, offset: 0 });

    expect(page.items[0].wrongCount).toBe(130);
    expect(page.total).toBe(130);
    const fetchCall = mock.calls.find((call) => call.text.includes("SELECT a.*, agg.wrong_count"));
    expect(fetchCall?.text).toContain("LIMIT $3");
    const countCall = mock.calls.find((call) => call.text.includes("SELECT count(*) AS total"));
    expect(countCall?.text).not.toContain("LIMIT");
    expect(countCall?.text).not.toContain("OFFSET");
  });

  it("keeps the offset compatibility path and probes one extra row for nextCursor", async () => {
    const pageRows = [
      { ...WRONG_ROW_ENRICHED, id: "00000000-0000-4000-8000-000000000003" },
      { ...WRONG_ROW_ENRICHED, id: "00000000-0000-4000-8000-000000000002" },
      WRONG_ROW_ENRICHED,
    ];
    mock.setRowMap({
      "SELECT a.*, agg.wrong_count": pageRows,
      "SELECT count(*)": [{ total: "3" }],
    });
    const repos = createRepositories();

    const page = await repos.l3Practice.listWrongAttempts({ userId: "u1", limit: 2, offset: 0 });

    expect(page.items).toHaveLength(2);
    expect(page.offset).toBe(0);
    expect(page.total).toBe(3);
    expect(decodeCursor(page.nextCursor)).toEqual({ createdAt: pageRows[1].created_at, id: "00000000-0000-4000-8000-000000000002" });
    const listCall = mock.calls.find((call) => call.text.includes("SELECT a.*, agg.wrong_count"));
    expect(listCall?.text).toContain("LIMIT $3 OFFSET $4");
    expect(listCall?.params).toEqual(["u1", "wrong", 3, 0]);
  });

  it("pages with the cursor keyset (offset ignored) and reports the end of the list", async () => {
    const cursor = encodeCursor("2026-09-11T00:00:00Z", "00000000-0000-4000-8000-000000000002");
    mock.setRowMap({
      "SELECT a.*, agg.wrong_count": [{ ...WRONG_ROW_ENRICHED, id: "att-9" }],
      "SELECT count(*)": [{ total: "5" }],
    });
    const repos = createRepositories();

    const page = await repos.l3Practice.listWrongAttempts({ userId: "u1", limit: 1, offset: 4, cursor });

    expect(page.offset).toBe(0);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    const listCall = mock.calls.find((call) => call.text.includes("SELECT a.*, agg.wrong_count"));
    expect(listCall?.text).toContain("AND (a.created_at, a.id) < ($3::timestamptz, $4::uuid)");
    expect(listCall?.text).not.toContain("OFFSET");
    expect(listCall?.params).toEqual([
      "u1",
      "wrong",
      "2026-09-11T00:00:00Z",
      "00000000-0000-4000-8000-000000000002",
      2,
    ]);
  });

  it("rejects a malformed cursor before querying", async () => {
    const repos = createRepositories();

    await expect(
      repos.l3Practice.listWrongAttempts({ userId: "u1", limit: 10, offset: 0, cursor: "bm90LWEtY3Vyc29y" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it("applies the two-axis filters to the aggregated error-book query", async () => {
    mock.setRowMap({
      "SELECT a.*, agg.wrong_count": [WRONG_ROW_ENRICHED],
      "SELECT count(*)": [{ total: "1" }],
    });
    const repos = createRepositories();

    await repos.l3Practice.listWrongAttempts({
      userId: "u1",
      space: "阅读",
      direction: "考研",
      limit: 5,
      offset: 2,
    });

    const listCall = mock.calls.find((call) => call.text.includes("SELECT a.*, agg.wrong_count"));
    expect(listCall?.text).toContain("AND EXISTS (SELECT 1 FROM l3_source_spaces sp");
    expect(listCall?.text).toContain("sp.space = $3");
    expect(listCall?.text).toContain("AND s.direction = $4");
    expect(listCall?.text).toContain("LIMIT $5 OFFSET $6");
    expect(listCall?.params).toEqual(["u1", "wrong", "阅读", "考研", 6, 2]);
    const countCall = mock.calls.find((call) => call.text.includes("SELECT count(*) AS total"));
    expect(countCall?.params).toEqual(["u1", "wrong", "阅读", "考研"]);
  });

  it("reports zero total when the aggregated count query returns no row", async () => {
    mock.setRowMap({
      "SELECT a.*, agg.wrong_count": [],
      "SELECT count(*)": [],
    });
    const repos = createRepositories();

    const page = await repos.l3Practice.listWrongAttempts({ userId: "u1", limit: 20, offset: 0 });

    expect(page).toEqual({ items: [], total: 0, limit: 20, offset: 0, nextCursor: null });
  });

  it("exposes the registered l3Practice repository through the factory", () => {
    const repos = createRepositories({} as PoolClient);
    expect(typeof repos.l3Practice.insertAttempt).toBe("function");
    expect(typeof repos.l3Practice.listWrongAttempts).toBe("function");
  });
});
