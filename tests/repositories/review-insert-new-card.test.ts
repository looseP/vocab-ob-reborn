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

describe("ReviewRepository.insertNewCard", () => {
  beforeEach(() => mock.reset());

  const repos = createRepositories(tx);

  it("requires an active transaction", async () => {
    const noTx = createRepositories();
    await expect(
      noTx.reviews.insertNewCard({ userId: "u1", wordId: "w1", wordbookId: "wb1", desiredRetention: "0.850" }),
    ).rejects.toMatchObject({ code: "BUSINESS_RULE" });
  });

  it("returns word_not_found when the word does not exist", async () => {
    mock.setRowMap({
      "FROM words WHERE": [],
      "FROM wordbooks WHERE": [{ id: "wb-1" }],
    });
    await expect(
      repos.reviews.insertNewCard({ userId: "u1", wordId: "missing", wordbookId: "wb-1", desiredRetention: "0.850" }),
    ).resolves.toEqual({ status: "word_not_found", progressId: null });
    expect(mock.calls[0].text).toContain("FROM words");
    // short-circuits before touching wordbooks
    expect(mock.calls.length).toBe(1);
  });

  it("returns wordbook_invalid when the wordbook is not owned by the user", async () => {
    mock.setRowMap({
      "FROM words WHERE": [{ id: "w-1" }],
      "FROM wordbooks WHERE": [],
    });
    await expect(
      repos.reviews.insertNewCard({ userId: "u1", wordId: "w-1", wordbookId: "foreign", desiredRetention: "0.850" }),
    ).resolves.toEqual({ status: "wordbook_invalid", progressId: null });
    expect(mock.calls.length).toBe(2);
    expect(mock.lastQuery!.text).toContain("user_id = $2");
  });

  it("returns duplicate when ON CONFLICT absorbs the insert", async () => {
    mock.setRowMap({
      "FROM words WHERE": [{ id: "w-1" }],
      "FROM wordbooks WHERE": [{ id: "wb-1" }],
      "INSERT INTO user_word_progress": [],
    });
    await expect(
      repos.reviews.insertNewCard({ userId: "u1", wordId: "w-1", wordbookId: "wb-1", desiredRetention: "0.850" }),
    ).resolves.toEqual({ status: "duplicate", progressId: null });
  });

  it("inserts a brand-new card and returns its progress id", async () => {
    mock.setRowMap({
      "FROM words WHERE": [{ id: "w-1" }],
      "FROM wordbooks WHERE": [{ id: "wb-1" }],
      "INSERT INTO user_word_progress": [{ id: "p-new" }],
    });
    await expect(
      repos.reviews.insertNewCard({ userId: "u1", wordId: "w-1", wordbookId: "wb-1", desiredRetention: "0.850" }),
    ).resolves.toEqual({ status: "inserted", progressId: "p-new" });

    const insertCall = mock.calls.find((call: { text: string }) => call.text.includes("INSERT INTO user_word_progress"))!;
    expect(insertCall.text).toContain("'fsrs', 'new'");
    expect(insertCall.params).toEqual(["u1", "w-1", "wb-1", "0.850"]);
  });
});
