import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "../helpers/mock-db";

// Mock the connection BEFORE importing repositories
const mock = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  checkPoolHealth: vi.fn(),
  resetPool: vi.fn(),
}));

import { createRepositories } from "@/index";

const tx = { query: mock.pool.query } as never;

describe("ReviewRepository.removeCardsByWordIds（P1 队列编辑 · 移出）", () => {
  beforeEach(() => mock.reset());
  const repos = createRepositories(tx);

  it("requires an active transaction", async () => {
    const noTx = createRepositories();
    await expect(
      noTx.reviews.removeCardsByWordIds({ userId: "u1", wordbookId: "wb1", wordIds: ["w1"] }),
    ).rejects.toMatchObject({ code: "BUSINESS_RULE" });
  });

  it("returns [] without querying for an empty id list", async () => {
    const result = await repos.reviews.removeCardsByWordIds({ userId: "u1", wordbookId: "wb1", wordIds: [] });

    expect(result).toEqual([]);
    expect(mock.calls.length).toBe(0);
  });

  it("deletes scoped by (user, wordbook, ids) then writes card_removed audit rows", async () => {
    mock.setRowMap({
      "DELETE FROM user_word_progress": [{ id: "p-1", word_id: "w-1", previous_state: "review" }],
      "INSERT INTO review_logs": [],
    });

    const result = await repos.reviews.removeCardsByWordIds({
      userId: "u1",
      wordbookId: "wb-1",
      wordIds: ["w-1", "w-2"],
    });

    expect(result).toEqual(["w-1"]);
    expect(mock.calls.length).toBe(2);
    const deletion = mock.calls[0];
    expect(deletion.text).toContain("DELETE FROM user_word_progress");
    expect(deletion.text).toContain("user_id = $1 AND wordbook_id = $2::uuid");
    expect(deletion.text).toContain("word_id = ANY($3::uuid[])");
    expect(deletion.text).toContain("RETURNING id, word_id, state AS previous_state");
    expect(deletion.params).toEqual(["u1", "wb-1", ["w-1", "w-2"]]);
    const audit = mock.calls[1];
    expect(audit.text).toContain("INSERT INTO review_logs");
    expect(audit.text).toContain("jsonb_to_recordset($3::jsonb)");
    expect(audit.text).toContain("'card_removed'");
    expect(audit.text).toContain("NULL, r.previous_state");
  });

  it("skips the audit insert when no rows matched（幂等零行）", async () => {
    mock.setRowMap({ "DELETE FROM user_word_progress": [] });

    const result = await repos.reviews.removeCardsByWordIds({ userId: "u1", wordbookId: "wb-1", wordIds: ["w-x"] });

    expect(result).toEqual([]);
    expect(mock.calls.length).toBe(1);
  });
});

describe("ReviewRepository.expireCardsByWordIds（P1 队列编辑 · 提前到期）", () => {
  beforeEach(() => mock.reset());
  const repos = createRepositories(tx);

  it("requires an active transaction", async () => {
    const noTx = createRepositories();
    await expect(
      noTx.reviews.expireCardsByWordIds({ userId: "u1", wordbookId: "wb1", wordIds: ["w1"] }),
    ).rejects.toMatchObject({ code: "BUSINESS_RULE" });
  });

  it("returns [] without querying for an empty id list", async () => {
    const result = await repos.reviews.expireCardsByWordIds({ userId: "u1", wordbookId: "wb1", wordIds: [] });

    expect(result).toEqual([]);
    expect(mock.calls.length).toBe(0);
  });

  it("advances due_at to now with only-forward guard and excludes suspended", async () => {
    mock.setRows([{ word_id: "w-1" }, { word_id: "w-2" }]);

    const result = await repos.reviews.expireCardsByWordIds({
      userId: "u1",
      wordbookId: "wb-1",
      wordIds: ["w-1", "w-2", "w-3"],
    });

    expect(result).toEqual(["w-1", "w-2"]);
    const query = mock.lastQuery!;
    expect(query.text).toContain("SET due_at = LEAST(COALESCE(due_at, now()), now())");
    expect(query.text).toContain("state <> 'suspended'");
    expect(query.text).toContain("(due_at IS NULL OR due_at > now())");
    expect(query.text).toContain("RETURNING word_id");
    expect(query.params).toEqual(["u1", "wb-1", ["w-1", "w-2", "w-3"]]);
  });
});
