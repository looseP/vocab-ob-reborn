/**
 * L3WritingFeedbackRepository 单测（W5）：SQL 形状与守卫（锁/FOR UPDATE/版本 CAS）。
 */
import { describe, expect, it, vi } from "vitest";
import type { L3WritingFeedbackRow } from "@/repositories/l3-writing.types";
import { L3WritingFeedbackRepository } from "@/repositories/l3-writing-feedback.repository";

const USER = "00000000-0000-4000-8000-000000000001";
const SHEET = "00000000-0000-4000-8000-000000000801";
const REQUEST = "00000000-0000-4000-8000-000000000902";

function feedbackRow(overrides: Partial<L3WritingFeedbackRow> = {}): L3WritingFeedbackRow {
  return {
    id: "00000000-0000-4000-8000-000000000921",
    user_id: USER,
    sheet_id: SHEET,
    text_sha256: "a".repeat(64),
    schema_version: 1,
    feedback: { schemaVersion: 1 },
    version: 1,
    request_id: REQUEST,
    last_editor: "agent-a",
    created_at: "2026-09-18T00:00:00.000Z",
    updated_at: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("L3WritingFeedbackRepository.findBySheet", () => {
  it("selects the owner sheet row without locking", async () => {
    const repo = new L3WritingFeedbackRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(feedbackRow());
    const row = await repo.findBySheet(USER, SHEET);
    expect(row?.version).toBe(1);
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("FROM l3_writing_feedback");
    expect(sql).toContain("user_id = $1::uuid");
    expect(sql).toContain("sheet_id = $2::uuid");
    expect(sql).not.toContain("FOR UPDATE");
    expect(params).toEqual([USER, SHEET]);
  });
});

describe("L3WritingFeedbackRepository.lockBySheet", () => {
  it("requires an active transaction", async () => {
    const repo = new L3WritingFeedbackRepository();
    await expect(repo.lockBySheet(USER, SHEET)).rejects.toThrow("requires an active transaction");
  });

  it("locks the feedback row with FOR UPDATE", async () => {
    const repo = new L3WritingFeedbackRepository({} as never);
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(feedbackRow());
    const row = await repo.lockBySheet(USER, SHEET);
    expect(row?.sheet_id).toBe(SHEET);
    const [sql] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("FOR UPDATE");
  });
});

describe("L3WritingFeedbackRepository.insertFirst", () => {
  it("inserts version=1 with schema_version=1 and principal editor", async () => {
    const repo = new L3WritingFeedbackRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(feedbackRow());
    const row = await repo.insertFirst({
      user_id: USER,
      sheet_id: SHEET,
      text_sha256: "b".repeat(64),
      feedback_jsonb: '{"schemaVersion":1}',
      request_id: REQUEST,
      last_editor: "owner",
    });
    expect(row.version).toBe(1);
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("INSERT INTO l3_writing_feedback");
    expect(sql).toContain("schema_version, feedback, version, request_id, last_editor");
    expect(sql).toContain("1, $4::jsonb, 1");
    expect(params).toEqual([USER, SHEET, "b".repeat(64), '{"schemaVersion":1}', REQUEST, "owner"]);
  });
});

describe("L3WritingFeedbackRepository.updateCas", () => {
  it("bumps version behind the expected-version guard and returns null on miss", async () => {
    const repo = new L3WritingFeedbackRepository();
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(feedbackRow({ version: 2 }));
    const row = await repo.updateCas({
      user_id: USER,
      sheet_id: SHEET,
      text_sha256: "c".repeat(64),
      feedback_jsonb: '{"schemaVersion":1}',
      request_id: REQUEST,
      last_editor: "agent-b",
      expected_version: 1,
    });
    expect(row?.version).toBe(2);
    const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("version = version + 1");
    expect(sql).toContain("user_id = $1::uuid");
    expect(sql).toContain("sheet_id = $2::uuid");
    expect(sql).toContain("AND version = $7");
    expect(params[6]).toBe(1);

    spy.mockResolvedValue(null);
    await expect(repo.updateCas({
      user_id: USER,
      sheet_id: SHEET,
      text_sha256: "c".repeat(64),
      feedback_jsonb: "{}",
      request_id: REQUEST,
      last_editor: "agent-b",
      expected_version: 1,
    })).resolves.toBeNull();
  });
});

describe("L3WritingFeedbackRepository.deleteBySheet（W9 清理）", () => {
  it("owner+sheet 限定的 DELETE…RETURNING；true/false 两态", async () => {
    const repo = new L3WritingFeedbackRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue({ id: "f-1" });
    expect(await repo.deleteBySheet(USER, SHEET)).toBe(true);
    const [sql, params] = spy.mock.calls[0]!;
    expect(sql).toContain("DELETE FROM l3_writing_feedback");
    expect(sql).toContain("user_id = $1::uuid AND sheet_id = $2::uuid");
    expect(sql).toContain("RETURNING id");
    expect(params).toEqual([USER, SHEET]);

    spy.mockResolvedValue(null);
    expect(await repo.deleteBySheet(USER, SHEET)).toBe(false);
  });
});

describe("L3WritingFeedbackRepository.insertFirst（异常臂）", () => {
  it("空行抛错（防静默假成功）", async () => {
    const repo = new L3WritingFeedbackRepository();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await expect(repo.insertFirst({
      user_id: USER,
      sheet_id: SHEET,
      text_sha256: "a".repeat(64),
      feedback_jsonb: "{}",
      request_id: REQUEST,
      last_editor: "agent-a",
    })).rejects.toThrow("insert returned no row");
  });
});
