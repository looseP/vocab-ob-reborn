import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMockPool } from "../helpers/mock-db";

const mock = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  checkPoolHealth: vi.fn(),
  resetPool: vi.fn(),
}));

import { createRepositories } from "@/index";

beforeEach(() => mock.reset());

describe("L3ProposalRepository", () => {
  it("creates proposal and items only in proposal tables", async () => {
    mock.setRowMap({
      "INSERT INTO l3_proposals": [{ id: "prop-1", user_id: "u1", source_type: "agent", status: "pending" }],
      "INSERT INTO l3_proposal_items": [{ id: "item-1", proposal_id: "prop-1", user_id: "u1", item_type: "source", ordinal: 1, status: "pending" }],
    });
    const repos = createRepositories();

    await repos.l3Proposal.createProposal({
      user_id: "u1",
      source_type: "agent",
      title: "Candidate contexts",
      provenance: { source: "test" },
    });
    await repos.l3Proposal.createProposalItem({
      proposal_id: "prop-1",
      user_id: "u1",
      item_type: "source",
      ordinal: 1,
      payload: { sourceType: "article", title: "Essay" },
    });

    const sql = mock.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("INSERT INTO l3_proposals");
    expect(sql).toContain("INSERT INTO l3_proposal_items");
    expect(sql).not.toContain("INSERT INTO l3_sources");
    expect(sql).not.toContain("INSERT INTO l3_contexts");
    expect(sql).not.toContain("INSERT INTO l3_occurrences");
    expect(sql).not.toContain("INSERT INTO l3_context_links");
  });

  it("lists and gets proposals scoped to the requesting user", async () => {
    mock.setRows([{ id: "prop-1", user_id: "u1", source_type: "agent", status: "pending", created_at: "2026-07-08T00:00:00Z" }]);
    const repos = createRepositories();

    await repos.l3Proposal.listProposals({ userId: "u1", status: "pending", limit: 10 });
    expect(mock.lastQuery?.text).toContain("WHERE user_id = $1::uuid");
    expect(mock.lastQuery?.text).toContain("AND status = $3");

    await repos.l3Proposal.findProposalByIdForUser("u1", "prop-1");
    expect(mock.lastQuery?.text).toContain("WHERE id = $1::uuid AND user_id = $2::uuid");
    expect(mock.lastQuery?.params).toEqual(["prop-1", "u1"]);
  });

  it("rejects malformed proposal cursors before querying", async () => {
    const repos = createRepositories();

    await expect(repos.l3Proposal.listProposals({
      userId: "u1",
      status: "pending",
      limit: 10,
      cursor: "bad-cursor",
    })).rejects.toBeInstanceOf(Error);
    expect(mock.calls).toHaveLength(0);
  });

  it("applies a valid cursor and returns an encoded next page cursor", async () => {
    const first = { id: "00000000-0000-4000-8000-000000000001", user_id: "u1", created_at: "2026-07-08T00:00:00Z" };
    const second = { id: "00000000-0000-4000-8000-000000000002", user_id: "u1", created_at: "2026-07-07T00:00:00Z" };
    mock.setRows([first, second]);
    const cursor = Buffer.from(JSON.stringify({ createdAt: "2026-07-09T00:00:00Z", id: "00000000-0000-4000-8000-000000000009" })).toString("base64url");

    const page = await createRepositories().l3Proposal.listProposals({ userId: "u1", limit: 1, cursor });

    expect(page.items).toEqual([first]);
    expect(page.nextCursor).toBeTypeOf("string");
    expect(mock.lastQuery?.text).toContain("(created_at, id) <");
    expect(mock.lastQuery?.params).toEqual(["u1", 2, "2026-07-09T00:00:00Z", "00000000-0000-4000-8000-000000000009"]);
  });

  it("returns null or a proposal bundle through the public API", async () => {
    const repos = createRepositories();
    mock.setRows([]);
    await expect(repos.l3Proposal.getProposalBundle("u1", "missing")).resolves.toBeNull();

    mock.setRowMap({
      "FROM l3_proposals WHERE id": [{ id: "prop-1", user_id: "u1" }],
      "FROM l3_proposal_items": [{ id: "item-1", proposal_id: "prop-1", user_id: "u1" }],
    });
    await expect(repos.l3Proposal.getProposalBundle("u1", "prop-1")).resolves.toEqual({
      proposal: { id: "prop-1", user_id: "u1" },
      items: [{ id: "item-1", proposal_id: "prop-1", user_id: "u1" }],
    });
  });

  it("queries idempotency input hashes and requires a transaction for row locking", async () => {
    const repos = createRepositories();
    mock.setRows([{ id: "prop-1", input_hash: "hash-1" }]);
    await expect(repos.l3Proposal.findProposalByInputHash("u1", "hash-1")).resolves.toMatchObject({ id: "prop-1" });
    expect(mock.lastQuery?.text).toContain("input_hash = $2");
    await expect(repos.l3Proposal.lockProposalByIdForUser("u1", "prop-1"))
      .rejects.toMatchObject({ code: "BUSINESS_RULE" });
  });

  it("updates proposal lifecycle without active L3 writes", async () => {
    mock.setRowMap({
      "UPDATE l3_proposal_items": [{ id: "item-1", proposal_id: "prop-1", user_id: "u1", status: "rejected" }],
      "UPDATE l3_proposals": [{ id: "prop-1", user_id: "u1", source_type: "agent", status: "rejected" }],
    });
    const repos = createRepositories();

    await repos.l3Proposal.markProposalItemsRejected("prop-1", "u1");
    await repos.l3Proposal.markProposalRejected("prop-1", "u1", "nope");

    const sql = mock.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("UPDATE l3_proposal_items");
    expect(sql).toContain("UPDATE l3_proposals");
    expect(sql).not.toContain("INSERT INTO l3_sources");
    expect(sql).not.toContain("INSERT INTO l3_contexts");
  });

  it("marks proposal and item confirmed with active entity ids", async () => {
    mock.setRowMap({
      "UPDATE l3_proposal_items": [{ id: "item-1", proposal_id: "prop-1", user_id: "u1", status: "confirmed", active_entity_type: "source", active_entity_id: "src-1" }],
      "UPDATE l3_proposals": [{ id: "prop-1", user_id: "u1", source_type: "agent", status: "confirmed" }],
    });
    const repos = createRepositories();

    await repos.l3Proposal.markProposalItemConfirmed("item-1", "u1", "source", "src-1");
    await repos.l3Proposal.markProposalConfirmed("prop-1", "u1");

    const sql = mock.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("active_entity_type = $3");
    expect(sql).toContain("status = 'confirmed'");
    expect(sql).not.toContain("word_l2_content");
    expect(sql).not.toContain("user_word_progress");
  });

  it("declares proposal owner composite constraints in migration", () => {
    const migration = readFileSync(join(process.cwd(), "drizzle/0008_flashy_colonel_america.sql"), "utf8");

    expect(migration).toContain('CONSTRAINT "l3_proposals_id_user_id_unique" UNIQUE("id","user_id")');
    expect(migration).toContain('CONSTRAINT "l3_proposals_wordbook_owner_fk" FOREIGN KEY ("wordbook_id","user_id")');
    expect(migration).toContain('CONSTRAINT "l3_proposal_items_proposal_owner_fk" FOREIGN KEY ("proposal_id","user_id")');
  });
});
